// bot.js
// MUST be the very first line so @discordjs/voice sees it
process.env.DISCORDJS_VOICE_TRANSPORT = 'udp';
console.log('Transport env:', process.env.DISCORDJS_VOICE_TRANSPORT);

require('dotenv').config();
const express = require('express');
const app = express();


app.get('/', (_req, res) => res.status(200).send('OK'));    // health endpoint for UptimeRobot
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[WEB] Listening on :${port}`));

const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport
} = require('@discordjs/voice');
const { PassThrough } = require('stream');

// Optional: helpful to see voice deps on Replit logs
console.log('[Voice Deps]\n' + generateDependencyReport());

// ------------------------
// Config from environment
// ------------------------
const TOKEN = process.env.DISCORD_TOKEN;           // set this in Replit "Secrets"
const GUILD_ID = process.env.GUILD_ID;             // set this in Replit "Secrets"
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // set this in Replit "Secrets"

// ------------------------
// Create Discord client
// ------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------------------------------------------
// Make a tiny Opus-silence stream (no FFmpeg)
// ---------------------------------------------
function makeSilenceStream() {
  const pt = new PassThrough();
  const frame = Buffer.from([0xF8, 0xFF, 0xFE]); // Discord-compatible Opus silence
  const interval = setInterval(() => pt.write(frame), 20); // 50 fps
  pt.on('close', () => clearInterval(interval));
  return pt;
}

let connection = null;
let player = null;

async function connectToVC() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error('[VC] Guild not found. Check GUILD_ID.');
    return;
  }

  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) {
    console.error('[VC] Voice channel not found or not a voice channel. Check VOICE_CHANNEL_ID.');
    return;
  }

  console.log('[VC] Joining voice channel...');

  connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  player = createAudioPlayer();
  const resource = createAudioResource(makeSilenceStream(), { inputType: StreamType.Opus });
  player.play(resource);
  connection.subscribe(player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log('🔊 Connected and streaming silence.');
  } catch (err) {
    console.error('[VC] Failed to become Ready:', err);
    try { connection.destroy(); } catch {}
    connection = null;
  }

  connection.on('stateChange', async (oldState, newState) => {
    console.log(`[VC] State: ${oldState.status} -> ${newState.status}`);

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('[VC] Quick reconnect OK');
      } catch {
        console.warn('[VC] Quick reconnect failed. Rebuilding...');
        try { connection.destroy(); } catch {}
        connection = null;
        setTimeout(connectToVC, 5_000);
      }
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      console.warn('[VC] Destroyed. Rejoining soon...');
      setTimeout(connectToVC, 5_000);
    } else if (
      newState.status === VoiceConnectionStatus.Connecting ||
      newState.status === VoiceConnectionStatus.Signalling
    ) {
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        console.log('✅ Transitioned to Ready.');
      } catch {
        console.warn('[VC] Stuck during transition. Rebuilding...');
        try { connection.destroy(); } catch {}
        connection = null;
        setTimeout(connectToVC, 5_000);
      }
    }
  });

  player.on('error', (err) => {
    console.error('[Player] Error:', err);
  });
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  connectToVC();
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const botId = client.user?.id;
  if (!botId) return;

  const wasBot = oldState.member?.id === botId || newState.member?.id === botId;
  if (wasBot) {
    const nowInTarget = newState.channelId === VOICE_CHANNEL_ID;
    if (!nowInTarget) {
      console.log('⚠️ Bot left/moved from target VC. Rejoining...');
      setTimeout(connectToVC, 3_000);
    }
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  try { connection?.destroy(); } catch {}
  client.destroy();
  process.exit(0);
});

client.login(TOKEN);
