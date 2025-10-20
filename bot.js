// --- FORCE UDP (disable DAVE/WebRTC) BEFORE importing @discordjs/voice ---
process.env.DISCORDJS_VOICE_TRANSPORT =
  process.env.DISCORDJS_VOICE_TRANSPORT || 'udp';
console.log('Transport env:', process.env.DISCORDJS_VOICE_TRANSPORT);

// Load env vars for your token/IDs
require('dotenv').config();

const express = require('express');
const app = express();

// Tiny web server so hosts (Render/Replit) keep the app alive
app.get('/', (_req, res) => res.status(200).send('OK'));
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
  generateDependencyReport,
} = require('@discordjs/voice');
const { PassThrough } = require('stream');

// Helpful at startup
console.log('[Voice Deps]\n' + generateDependencyReport());

// ------------------------
// Env config
// ------------------------
const TOKEN = process.env.DISCORD_TOKEN;               // bot token
const GUILD_ID = process.env.GUILD_ID;                 // server id
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // voice channel id

// ------------------------
// Discord client
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
  const interval = setInterval(() => pt.write(frame), 20); // 50 fps (20ms)
  pt.on('close', () => clearInterval(interval));
  return pt;
}

// Globals (only set after a successful Ready)
let connection = null;
let player = null;

// Single-flight / debounce controls
let connectInProgress = false;
let reconnectTimer = null;

function scheduleReconnect(ms) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  connectInProgress = false; // allow next attempt
  reconnectTimer = setTimeout(() => {
    connectToVC().catch(() => {});
  }, ms);
}

// ---------------------------------------------
// Guarded connectToVC (UDP/legacy + debounce)
// ---------------------------------------------
async function connectToVC() {
  if (connectInProgress) {
    console.log('[VC] Join already in progress; skipping.');
    return;
  }
  connectInProgress = true;

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error('[VC] Guild not found. Check GUILD_ID.');
    connectInProgress = false;
    return;
  }

  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  // 2 = GuildVoice (use a regular Voice channel for UDP transport)
  if (!channel || channel.type !== 2) {
    console.error('[VC] Voice channel not found or wrong type. Use a regular Voice channel.');
    connectInProgress = false;
    return;
  }

  console.log('[VC] Joining voice channel...');

  const newConn = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  // Attach state handler BEFORE awaiting; guard with optional chaining
  newConn.on?.('stateChange', async (oldState, newState) => {
    console.log(`[VC] State: ${oldState.status} -> ${newState.status}`);

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      try {
        await Promise.race([
          entersState(newConn, VoiceConnectionStatus.Signalling, 7_500),
          entersState(newConn, VoiceConnectionStatus.Connecting, 7_500),
        ]);
        console.log('[VC] Quick reconnect OK');
      } catch {
        console.warn('[VC] Quick reconnect failed. Rebuilding...');
        try { newConn.destroy(); } catch {}
        if (connection === newConn) connection = null;
        scheduleReconnect(5_000);
      }
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      console.warn('[VC] Destroyed. Rejoining soon...');
      if (connection === newConn) connection = null;
      scheduleReconnect(5_000);
    } else if (
      newState.status === VoiceConnectionStatus.Connecting ||
      newState.status === VoiceConnectionStatus.Signalling
    ) {
      try {
        // UDP can be slow to settle on some hosts—allow longer
        await entersState(newConn, VoiceConnectionStatus.Ready, 60_000);
        console.log('✅ Transitioned to Ready (udp).');
      } catch {
        console.warn('[VC] Stuck during transition (udp). Rebuilding...');
        try { newConn.destroy(); } catch {}
        if (connection === newConn) connection = null;
        scheduleReconnect(5_000);
      }
    }
  });

  // Fresh player/resource for this attempt
  const newPlayer = createAudioPlayer();
  const resource = createAudioResource(makeSilenceStream(), { inputType: StreamType.Opus });
  newPlayer.play(resource);
  newConn.subscribe(newPlayer);

  try {
    await entersState(newConn, VoiceConnectionStatus.Ready, 60_000);
    console.log('🔊 Connected and streaming silence (udp).');
    // Promote to globals only after success
    connection = newConn;
    player = newPlayer;
    connectInProgress = false;
  } catch (err) {
    console.error('[VC] Failed to become Ready (udp):', err);
    try { newConn.destroy(); } catch {}
    scheduleReconnect(5_000);
  }

  newPlayer.on('error', (err) => {
    console.error('[Player] Error:', err);
  });
}

// ---------------------------------------------
// Lifecycle + auto-rejoin when moved/kicked
// ---------------------------------------------
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  connectToVC().catch(() => {});
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const botId = client.user?.id;
  if (!botId) return;

  const involvesBot = oldState.member?.id === botId || newState.member?.id === botId;
  if (!involvesBot) return;

  const nowInTarget = newState.channelId === VOICE_CHANNEL_ID;
  if (!nowInTarget && !connectInProgress) {
    console.log('⚠️ Bot left/moved from target VC. Rejoining...');
    scheduleReconnect(3_000);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  try { connection?.destroy(); } catch {}
  client.destroy();
  process.exit(0);
});

// Login
client.login(TOKEN);
