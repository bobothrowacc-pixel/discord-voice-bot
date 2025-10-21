// bot.js
// MUST be first so @discordjs/voice sees it
process.env.DISCORDJS_VOICE_TRANSPORT = 'udp';
console.log('Transport env:', process.env.DISCORDJS_VOICE_TRANSPORT);

require('dotenv').config();

const express = require('express');
const app = express();
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[WEB] Listening on :${port}`));

const { Client, GatewayIntentBits, Events, REST, Routes, AttachmentBuilder } = require('discord.js');
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
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // target VC for your bot to sit in
const DB_PATH = process.env.DB_PATH || './data.db';     // use a persistent disk in production

// ---------- DB (SQLite, sync & fast) ----------
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_hours (
    user_id TEXT PRIMARY KEY,
    total_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL
  );
`);

const addTimeStmt = db.prepare(`
  INSERT INTO user_hours (user_id, total_ms)
  VALUES (@user_id, @delta)
  ON CONFLICT(user_id) DO UPDATE SET total_ms = total_ms + excluded.total_ms
`);
const startSessionStmt = db.prepare(`
  INSERT INTO sessions (user_id, started_at) VALUES (@user_id, @started_at)
  ON CONFLICT(user_id) DO UPDATE SET started_at = excluded.started_at
`);
const endSessionStmt = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
const getTopStmt = db.prepare(`SELECT user_id, total_ms FROM user_hours ORDER BY total_ms DESC LIMIT ?`);
const getSessionStmt = db.prepare(`SELECT started_at FROM sessions WHERE user_id = ?`);

function startSession(userId, when = Date.now()) {
  startSessionStmt.run({ user_id: userId, started_at: when });
}
function endSession(userId, when = Date.now()) {
  const row = getSessionStmt.get(userId);
  if (!row) return 0;
  const delta = Math.max(0, when - row.started_at);
  const txn = db.transaction(() => {
    endSessionStmt.run(userId);
    addTimeStmt.run({ user_id: userId, delta });
  });
  txn();
  return delta;
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // needed to track join/leave
  ],
});

// ---------- Minimal “silent stream” player ----------
const { PassThrough } = require('stream');
function makeSilenceStream() {
  const pt = new PassThrough();
  const frame = Buffer.from([0xF8, 0xFF, 0xFE]); // Opus SILK comfort-noise frame
  const interval = setInterval(() => pt.write(frame), 20); // 50fps
  pt.on('close', () => clearInterval(interval));
  return pt;
}
let connection = null;
let player = null;

// ---------- Connect bot to your VC and keep it there ----------
async function connectToVC() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return console.error('[VC] Guild not found. Check GUILD_ID.');
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) return console.error('[VC] VOICE_CHANNEL_ID invalid.');

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

  connection?.on('stateChange', async (o, n) => {
    console.log(`[VC] State: ${o.status} -> ${n.status}`);
    if (n.status === VoiceConnectionStatus.Disconnected) {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('[VC] Quick reconnect OK');
      } catch {
        console.warn('[VC] Rebuilding connection...');
        try { connection.destroy(); } catch {}
        connection = null;
        setTimeout(connectToVC, 5_000);
      }
    } else if (n.status === VoiceConnectionStatus.Destroyed) {
      console.warn('[VC] Destroyed. Rejoining...');
      setTimeout(connectToVC, 5_000);
    }
  });

  player.on('error', (err) => console.error('[Player] Error:', err));
}

// ---------- Track voice time ----------
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId = (newState.member ?? oldState.member)?.id;
  if (!userId || userId === client.user?.id) return;

  const wasIn = !!oldState.channelId;
  const nowIn = !!newState.channelId;

  if (!wasIn && nowIn) {
    // joined any VC → start
    startSession(userId, Date.now());
  } else if (wasIn && !nowIn) {
    // left VC → end & add
    const delta = endSession(userId, Date.now());
    if (delta > 0) console.log(`[TIME] +${(delta/1000/60).toFixed(1)}m to ${userId}`);
  } else if (wasIn && nowIn && oldState.channelId !== newState.channelId) {
    // moved channel → close old session, start new one (keeps continuity)
    const when = Date.now();
    const delta = endSession(userId, when);
    startSession(userId, when);
    if (delta > 0) console.log(`[TIME] move: +${(delta/1000/60).toFixed(1)}m to ${userId}`);
  }
});

// On startup, for anyone already in VC, start sessions “from now” (we can’t know their earlier join times)
async function seedCurrentSessions() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  const channels = await guild.channels.fetch();
  const voiceChannels = channels.filter(ch => ch && ch.type === 2);
  const when = Date.now();
  for (const [, ch] of voiceChannels) {
    for (const [, member] of ch.members) {
      if (member.user.id !== client.user.id) {
        startSession(member.user.id, when);
      }
    }
  }
  console.log('[TIME] Seeded sessions for current VC members.');
}

// ---------- Slash commands registration ----------
const commands = [
  {
    name: 'leaderboard',
    description: 'Show top users by total voice time.',
    options: [
      {
        name: 'limit',
        description: 'How many to show (default 10, max 20)',
        type: 4, // INTEGER
        required: false
      }
    ]
  }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands((await client.application.fetch()).id, GUILD_ID), {
    body: commands
  });
  console.log('✅ Registered slash commands.');
}

// ---------- Canvas rendering ----------
const { createCanvas, loadImage } = require('@napi-rs/canvas');

function formatHMS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}

async function renderLeaderboard(guild, limit = 10) {
  const rows = getTopStmt.all(Math.min(20, Math.max(1, limit)));
  const width = 950;
  const rowH = 96;
  const headerH = 110;
  const height = headerH + rowH * rows.length + 40;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#0f172a'; // slate-900
  ctx.fillRect(0, 0, width, height);

  // header
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText('🎧 Voice Time Leaderboard', 32, 60);
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(`Updated: ${new Date().toLocaleString()}`, 32, 88);

  // rows
  let y = headerH;
  for (let i = 0; i < rows.length; i++) {
    const { user_id, total_ms } = rows[i];

    // row background
    ctx.fillStyle = i % 2 === 0 ? '#111827' : '#0b1220';
    ctx.fillRect(20, y - 10, width - 40, rowH - 8);

    // rank
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(String(i + 1).padStart(2, '0'), 32, y + 18);

    // avatar
    let avatarUrl = null;
    try {
      const member = await guild.members.fetch(user_id);
      avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 128 });
    } catch { /* user might have left */ }

    if (avatarUrl) {
      try {
        const img = await loadImage(avatarUrl);
        const ax = 70, ay = y - 6, size = 64;
        // circle clip
        ctx.save();
        ctx.beginPath();
        ctx.arc(ax + size / 2, ay + size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, ax, ay, size, size);
        ctx.restore();
      } catch { /* ignore */ }
    }

    // username & hours
    let displayName = user_id;
    try {
      const member = await guild.members.fetch(user_id);
      displayName = member.displayName || member.user.username;
    } catch { /* ignore */ }

    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(displayName, 150, y + 16);

    ctx.fillStyle = '#a7f3d0';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(formatHMS(total_ms), width - 250, y + 16);

    y += rowH;
  }

  return canvas.toBuffer('image/png');
}

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'leaderboard') {
    const limit = interaction.options.getInteger('limit') ?? 10;
    await interaction.deferReply(); // give time to render
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const png = await renderLeaderboard(guild, limit);
      const file = new AttachmentBuilder(png, { name: 'leaderboard.png' });
      await interaction.editReply({ files: [file] });
    } catch (err) {
      console.error('Leaderboard error:', err);
      await interaction.editReply('Sorry, I failed to render the leaderboard.');
    }
  }
});

// ---------- Lifecycle ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await registerCommands();
  await seedCurrentSessions();
  connectToVC();
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Keep the bot pinned in the target VC, if moved
  const botId = client.user?.id;
  if (!botId) return;
  const wasBot = oldState.member?.id === botId || newState.member?.id === botId;
  if (wasBot) {
    const nowInTarget = newState.channelId === VOICE_CHANNEL_ID;
    if (!nowInTarget) {
      console.log('⚠️ Bot moved; rejoining target VC...');
      setTimeout(connectToVC, 3_000);
    }
  }
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
