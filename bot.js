// bot.js
// MUST be first so @discordjs/voice sees it
process.env.DISCORDJS_VOICE_TRANSPORT = 'udp';
console.log('Transport env:', process.env.DISCORDJS_VOICE_TRANSPORT);

require('dotenv').config();

// --- Tiny web server (optional; useful for health checks on Render) ---
const express = require('express');
const app = express();
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[WEB] Listening on :${port}`));

// --- Discord / Voice ---
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

console.log('[Voice Deps]\n' + generateDependencyReport());

// ---------- Config ----------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // VC to pin bot in

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // needed so we can see when the bot is moved
  ],
});

// ---------- Silent player (keeps voice alive) ----------
const { PassThrough } = require('stream');
function makeSilenceStream() {
  const pt = new PassThrough();
  const frame = Buffer.from([0xF8, 0xFF, 0xFE]); // Opus "comfort noise" frame
  const interval = setInterval(() => pt.write(frame), 20); // 50 fps
  pt.on('close', () => clearInterval(interval));
  return pt;
}

let connection = null;
let player = null;
let connectLock = false;     // prevents overlapping joins
let reconnectTimer = null;   // debounced reconnect timer

async function connectToVC() {
  if (connectLock) {
    console.log('[VC] connectToVC: already running, skipping.');
    return;
  }
  connectLock = true;

  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) {
      console.error('[VC] Guild not found. Check GUILD_ID.');
      return;
    }

    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!channel || channel.type !== 2) {
      console.error('[VC] VOICE_CHANNEL_ID invalid or not a voice channel.');
      return;
    }

    if (connection && connection.state?.status !== 'destroyed') {
      console.log('[VC] Already connected/connecting, status:', connection.state.status);
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

    // fresh player each time
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
      return; // bail before attaching listeners
    }

    if (!connection) return; // safety

    // Ensure no duplicate listeners
    connection.removeAllListeners?.('stateChange');

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
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectToVC, 5_000);
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        console.warn('[VC] Destroyed. Rejoining soon...');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectToVC, 5_000);
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
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectToVC, 5_000);
        }
      }
    });

    player.on('error', (err) => console.error('[Player] Error:', err));
  } finally {
    connectLock = false;
  }
}

// If the BOT itself gets moved/removed from the target VC, debounce rejoin
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const botId = client.user?.id;
  if (!botId) return;

  const concernsBot = oldState.member?.id === botId || newState.member?.id === botId;
  if (!concernsBot) return;

  const nowInTarget = newState.channelId === VOICE_CHANNEL_ID;
  if (!nowInTarget) {
    console.log('⚠️ Bot left/moved from target VC. Rejoining...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectToVC, 3000);
  }
});

// ---------- Lifecycle ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  connectToVC();
});

process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

process.on('SIGINT', () => {
  console.log('Shutting down...');
  try { connection?.destroy(); } catch {}
  client.destroy();
  process.exit(0);
});

client.login(TOKEN);
