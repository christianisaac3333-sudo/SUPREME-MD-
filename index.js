import 'dotenv/config';
import makeWASocket, {
  fetchLatestWaWebVersion,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PREFIX = process.env.PREFIX || '.';
const BOT_NAME = process.env.BOT_NAME || 'SUPREME MD';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const AUTH_DIR = './auth_info';
const DATA_DIR = './data';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');
const logger = pino({ level: 'silent' });

let sock;
let reconnecting = false;
let shuttingDown = false;
const startedAt = Date.now();
const spamTracker = new Map();
const games = new Map();
let settings = { groups: {}, sudo: [] };
let warnings = {};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function saveJson(file, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}
async function loadData() {
  await mkdir(DATA_DIR, { recursive: true });
  settings = await readJson(SETTINGS_FILE, { groups: {}, sudo: [] });
  warnings = await readJson(WARNINGS_FILE, {});
}
function senderNumber(jid = '') {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}
function unwrap(message) {
  let msg = message || {};
  for (let i = 0; i < 5; i++) {
    if (msg.ephemeralMessage) msg = msg.ephemeralMessage.message || {};
    else if (msg.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message || {};
    else if (msg.viewOnceMessage) msg = msg.viewOnceMessage.message || {};
    else if (msg.documentWithCaptionMessage) msg = msg.documentWithCaptionMessage.message || {};
    else break;
  }
  return msg;
}
function getText(message) {
  const m = unwrap(message);
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}
function isOwner(sender) {
  const num = senderNumber(sender);
  return Boolean(OWNER && num === OWNER) || settings.sudo.includes(num);
}
async function isAdmin(groupJid, participantJid) {
  const metadata = await sock.groupMetadata(groupJid);
  const target = participantJid?.split(':')[0];
  return metadata.participants.some(p =>
    p.id?.split(':')[0] === target &&
    (p.admin === 'admin' || p.admin === 'superadmin')
  );
}
async function isGroupAdmin(groupJid, senderJid) {
  return isOwner(senderJid) || await isAdmin(groupJid, senderJid);
}
async function botIsAdmin(groupJid) {
  return isAdmin(groupJid, sock.user.id);
}
async function reply(jid, text, quoted) {
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
}
function groupConfig(jid) {
  settings.groups[jid] ||= { antilink: false, antispam: true, muted: [] };
  settings.groups[jid].muted ||= [];
  return settings.groups[jid];
}
function getTarget(m) {
  const context = unwrap(m.message).extendedTextMessage?.contextInfo;
  return context?.mentionedJid?.[0] || context?.participant || null;
}
function menuText() {
  return `👑 *${BOT_NAME} — COMMAND CENTRE*

*GENERAL*
${PREFIX}menu • ${PREFIX}help • ${PREFIX}alive • ${PREFIX}ping
${PREFIX}uptime • ${PREFIX}info • ${PREFIX}id • ${PREFIX}owner
${PREFIX}rules • ${PREFIX}time • ${PREFIX}calc <expression>

*GROUP / MODERATION*
${PREFIX}groupinfo • ${PREFIX}admins • ${PREFIX}tagall [text]
${PREFIX}hidetag [text] • ${PREFIX}grouplink • ${PREFIX}revoke
${PREFIX}warn @user • ${PREFIX}warnings @user • ${PREFIX}kick @user
${PREFIX}promote @user • ${PREFIX}demote @user
${PREFIX}antilink on|off • ${PREFIX}antispam on|off
${PREFIX}mute @user • ${PREFIX}unmute @user
${PREFIX}welcome on|off • ${PREFIX}goodbye on|off

*MEDIA*
${PREFIX}sticker • ${PREFIX}toimg • ${PREFIX}tomp3
${PREFIX}tourl (needs upload provider)

*AI / UTILITIES*
${PREFIX}ask <question> • ${PREFIX}translate <language> | <text>
${PREFIX}summarize <text> • ${PREFIX}weather <city>

*SEARCH / APPS*
${PREFIX}pinterest <query> • ${PREFIX}google <query>
${PREFIX}youtube <query> • ${PREFIX}tiktok <query>
${PREFIX}instagram <query> • ${PREFIX}facebook <query>
${PREFIX}spotify <query> • ${PREFIX}github <query>

*GAMES*
${PREFIX}riddle • ${PREFIX}answer <answer> • ${PREFIX}guess
${PREFIX}guess <1-10> • ${PREFIX}flip • ${PREFIX}dice
${PREFIX}roll [sides] • ${PREFIX}joke • ${PREFIX}fact

*OWNER*
${PREFIX}settings • ${PREFIX}mode public|private
${PREFIX}sudo add|remove <number> • ${PREFIX}broadcast <text>
${PREFIX}restart (process manager required)

*Note:* Search commands open official search pages. Media downloads require a trusted, configured provider.`;
}
function safeCalc(expression) {
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/%]/g) || [];
  if (!expression.trim() || tokens.join('') !== expression.replace(/\s/g, '')) {
    throw new Error('Invalid expression');
  }
  let pos = 0;
  function primary() {
    const token = tokens[pos++];
    if (token === '(') {
      const value = sum();
      if (tokens[pos++] !== ')') throw new Error('Missing )');
      return value;
    }
    if (token === '-') return -primary();
    if (token === '+') return primary();
    const n = Number(token);
    if (!Number.isFinite(n)) throw new Error('Invalid number');
    return n;
  }
  function product() {
    let value = primary();
    while (['*', '/', '%'].includes(tokens[pos])) {
      const op = tokens[pos++];
      const right = primary();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero');
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (['+', '-'].includes(tokens[pos])) {
      const op = tokens[pos++];
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }
  const result = sum();
  if (pos !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid expression');
  return result;
}
async function aiRequest(prompt) {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('AI_API_KEY is missing in .env');
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: `You are ${BOT_NAME}, a helpful, safe WhatsApp assistant. Be concise and accurate.` },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `AI HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content || 'No response received.';
}
async function quotedMedia(m, quoted) {
  const context = unwrap(m.message).extendedTextMessage?.contextInfo;
  if (!quoted || !context?.stanzaId) throw new Error('Reply to a supported image, video, or audio message.');
  const key = {
    remoteJid: m.key.remoteJid,
    id: context.stanzaId,
    participant: context.participant,
    fromMe: context.participant === sock.user.id
  };
  return downloadMediaMessage(
    { key, message: quoted },
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );
}
async function sendSearch(jid, app, query, quoted) {
  if (!query) return reply(jid, `Usage: ${PREFIX}${app} <search words>`, quoted);
  const q = encodeURIComponent(query);
  const links = {
    pinterest: `https://www.pinterest.com/search/pins/?q=${q}`,
    google: `https://www.google.com/search?q=${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    tiktok: `https://www.tiktok.com/search?q=${q}`,
    instagram: `https://www.instagram.com/explore/search/keyword/?q=${q}`,
    facebook: `https://www.facebook.com/search/top?q=${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
    github: `https://github.com/search?q=${q}`
  };
  await reply(jid, `🔎 *${app.toUpperCase()} SEARCH*\n${query}\n\n${links[app]}`, quoted);
}
async function getAITranslate(language, text) {
  return aiRequest(`Translate the following text into ${language}. Return only the translation:\n\n${text}`);
}
async function processCommand(m) {
  if (!m.message || m.key.fromMe) return;
  const jid = m.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  const isGroup = jid.endsWith('@g.us');
  const sender = m.key.participant || jid;
  const owner = isOwner(sender);
  const msg = unwrap(m.message);
  const text = getText(m.message).trim();
  const lower = text.toLowerCase();

  if (isGroup) {
    const cfg = groupConfig(jid);
    const senderAdmin = await isAdmin(jid, sender).catch(() => false);

    if (cfg.muted.includes(sender) && !senderAdmin && !owner) {
      if (await botIsAdmin(jid).catch(() => false)) {
        await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
      }
      return;
    }

    if (text && cfg.antilink && !senderAdmin && !owner &&
        /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/)/i.test(text)) {
      if (await botIsAdmin(jid).catch(() => false)) {
        await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
        await reply(jid, '🚫 Links are disabled in this group.');
      }
      return;
    }

    if (text && cfg.antispam && !senderAdmin && !owner && !text.startsWith(PREFIX)) {
      const key = `${jid}:${sender}`;
      const now = Date.now();
      const recent = (spamTracker.get(key) || []).filter(t => now - t < 8000);
      recent.push(now);
      spamTracker.set(key, recent);
      if (recent.length >= 7 && await botIsAdmin(jid).catch(() => false)) {
        await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
        await reply(jid, `⚠️ @${senderNumber(sender)}, please slow down.`);
        return;
      }
    }
  }

  if (!text.startsWith(PREFIX)) return;
  const parts = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  const args = parts;
  const query = args.join(' ');
  const context = msg.extendedTextMessage?.contextInfo;
  const quoted = context?.quotedMessage;
  const target = getTarget(m);

  try {
    if (['menu', 'help'].includes(command)) return reply(jid, menuText(), m);
    if (['alive', 'ping'].includes(command)) return reply(jid, `👑 ${BOT_NAME} is online.\n🏓 Pong!`, m);
    if (command === 'uptime') {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      return reply(jid, `⏱️ ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`, m);
    }
    if (command === 'info') return reply(jid, `👑 ${BOT_NAME}\nBaileys bot\nNode ${process.version}\nPrefix ${PREFIX}`, m);
    if (['id', 'jid'].includes(command)) return reply(jid, `Chat: ${jid}\nSender: ${sender}`, m);
    if (command === 'owner') return reply(jid, OWNER ? `Owner: https://wa.me/${OWNER}` : 'Set OWNER_NUMBER in .env.', m);
    if (command === 'rules') return reply(jid, '📜 Respect everyone. No spam, scams, or unwanted links. Follow group admins.', m);
    if (command === 'time') return reply(jid, `🕒 ${new Date().toLocaleString()}`, m);
    if (command === 'calc') {
      try { return reply(jid, `🧮 ${safeCalc(query)}`, m); }
      catch { return reply(jid, 'Invalid calculation. Example: .calc (12 + 8) * 3', m); }
    }

    if (['pinterest', 'google', 'youtube', 'tiktok', 'instagram', 'facebook', 'spotify', 'github'].includes(command)) {
      return sendSearch(jid, command, query, m);
    }

    if (command === 'ask') {
      if (!query) return reply(jid, 'Usage: .ask your question', m);
      await reply(jid, '🤖 Thinking…', m);
      return reply(jid, (await aiRequest(query)).slice(0, 4000), m);
    }
    if (command === 'translate') {
      const i = query.indexOf('|');
      if (i < 1 || !query.slice(i + 1).trim()) return reply(jid, 'Usage: .translate French | Hello world', m);
      return reply(jid, (await getAITranslate(query.slice(0, i).trim(), query.slice(i + 1).trim())).slice(0, 4000), m);
    }
    if (command === 'summarize') {
      if (!query) return reply(jid, 'Usage: .summarize paste text here', m);
      return reply(jid, (await aiRequest(`Summarize this text in clear bullet points:\n${query}`)).slice(0, 4000), m);
    }
    if (command === 'weather') {
      const city = query;
      const key = process.env.OPENWEATHER_API_KEY;
      if (!city) return reply(jid, 'Usage: .weather Port Harcourt', m);
      if (!key) return reply(jid, `Weather API not configured. Search: https://www.google.com/search?q=${encodeURIComponent(city + ' weather')}`, m);
      const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`);
      const d = await r.json();
      if (!r.ok) return reply(jid, d.message || 'Weather lookup failed.', m);
      return reply(jid, `🌦️ ${d.name}: ${d.weather?.[0]?.description}\nTemperature: ${d.main?.temp}°C\nFeels like: ${d.main?.feels_like}°C\nHumidity: ${d.main?.humidity}%`, m);
    }

    if (command === 'flip') return reply(jid, Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!', m);
    if (command === 'dice') return reply(jid, `🎲 ${Math.floor(Math.random() * 6) + 1}`, m);
    if (command === 'roll') {
      const sides = Number(args[0] || 6);
      if (!Number.isInteger(sides) || sides < 2 || sides > 100) return reply(jid, 'Usage: .roll 6 (2–100)', m);
      return reply(jid, `🎲 ${Math.floor(Math.random() * sides) + 1}`, m);
    }
    if (command === 'joke') {
      const jokes = ['Why do programmers prefer dark mode? Because light attracts bugs.', 'I told my computer I needed a break; it said no problem—it would go to sleep.', 'Why was the math book sad? Too many problems.'];
      return reply(jid, jokes[Math.floor(Math.random() * jokes.length)], m);
    }
    if (command === 'fact') {
      const facts = ['Octopuses have three hearts.', 'A day on Venus is longer than its year.', 'Honey never spoils when properly sealed and stored.'];
      return reply(jid, facts[Math.floor(Math.random() * facts.length)], m);
    }
    if (command === 'riddle') {
      const riddles = [
        { q: 'What has keys but cannot open locks?', a: 'piano' },
        { q: 'What gets wetter as it dries?', a: 'towel' },
        { q: 'What has a face and two hands but no arms?', a: 'clock' }
      ];
      const r = riddles[Math.floor(Math.random() * riddles.length)];
      games.set(jid, { answer: r.a });
      return reply(jid, `🧩 ${r.q}\nAnswer with ${PREFIX}answer <answer>`, m);
    }
    if (command === 'answer') {
      const game = games.get(jid);
      if (!game) return reply(jid, 'Start with .riddle first.', m);
      if (query.toLowerCase() === game.answer) {
        games.delete(jid);
        return reply(jid, '🎉 Correct!', m);
      }
      return reply(jid, 'Not quite. Try again.', m);
    }
    if (command === 'guess') {
      const key = `${jid}:${sender}`;
      if (!args.length) {
        games.set(key, { number: Math.floor(Math.random() * 10) + 1 });
        return reply(jid, 'I picked a number 1–10. Guess with .guess 5', m);
      }
      const game = games.get(key);
      const guess = Number(args[0]);
      if (!game) return reply(jid, 'Start with .guess first.', m);
      if (guess === game.number) {
        games.delete(key);
        return reply(jid, '🎉 Correct guess!', m);
      }
      return reply(jid, guess < game.number ? 'Too low.' : 'Too high.', m);
    }

    if (command === 'sticker' || command === 'toimg' || command === 'tomp3') {
      if (!quoted) return reply(jid, `Reply to supported media with ${PREFIX}${command}.`, m);
      const media = unwrap(quoted);
      const isImage = Boolean(media.imageMessage || media.stickerMessage);
      const isAudio = Boolean(media.audioMessage || media.videoMessage);
      if (command === 'sticker' && !media.imageMessage) return reply(jid, 'Reply to an image with .sticker.', m);
      if (command === 'toimg' && !media.stickerMessage) return reply(jid, 'Reply to a sticker with .toimg.', m);
      if (command === 'tomp3' && !isAudio) return reply(jid, 'Reply to audio/video with .tomp3.', m);
      const buffer = await quotedMedia(m, quoted);
      if (command === 'sticker' || command === 'toimg') {
        const dir = await mkdtemp(path.join(tmpdir(), 'supreme-image-'));
        try {
          const { writeFile, readFile, rm } = await import('node:fs/promises');
          const input = path.join(dir, 'input.bin');
          const output = path.join(dir, command === 'sticker' ? 'output.webp' : 'output.png');

          await writeFile(input, buffer);

          if (command === 'sticker') {
            await execFileAsync('ffmpeg', [
              '-y', '-i', input, '-frames:v', '1',
              '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
              '-c:v', 'libwebp', '-quality', '80', output
            ]);
            const webp = await readFile(output);
            return await sock.sendMessage(jid, { sticker: webp }, { quoted: m });
          }

          await execFileAsync('ffmpeg', [
            '-y', '-i', input, '-frames:v', '1', output
          ]);
          const png = await readFile(output);
          return await sock.sendMessage(jid, {
            image: png,
            caption: 'Converted by SUPREME MD'
          }, { quoted: m });
        } finally {
          const { rm } = await import('node:fs/promises');
          await rm(dir, { recursive: true, force: true });
        }
      }
      const dir = await mkdtemp(path.join(tmpdir(), 'supreme-'));
      try {
        const input = path.join(dir, 'input.bin');
        const output = path.join(dir, 'output.mp3');
        const { writeFile: write } = await import('node:fs/promises');
        await write(input, buffer);
        await execFileAsync('ffmpeg', ['-y', '-i', input, '-vn', '-codec:a', 'libmp3lame', '-q:a', '4', output]);
        const { readFile: read } = await import('node:fs/promises');
        const mp3 = await read(output);
        return sock.sendMessage(jid, { audio: mp3, mimetype: 'audio/mpeg', fileName: 'supreme.mp3' }, { quoted: m });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    if (['groupinfo', 'admins', 'tagall', 'hidetag', 'grouplink', 'revoke', 'warn', 'warnings', 'kick', 'promote', 'demote', 'antilink', 'antispam', 'mute', 'unmute', 'welcome', 'goodbye'].includes(command)) {
      if (!isGroup) return reply(jid, 'This command works in groups only.', m);
      if (!await isGroupAdmin(jid, sender)) return reply(jid, 'Group admins or the bot owner only.', m);
      const meta = await sock.groupMetadata(jid);
      const cfg = groupConfig(jid);
      if (command === 'groupinfo') return reply(jid, `📋 ${meta.subject}\nMembers: ${meta.participants.length}\nDescription: ${meta.desc || 'Not set'}`, m);
      if (command === 'admins') {
        const admins = meta.participants.filter(p => p.admin);
        return sock.sendMessage(jid, { text: `🛡️ Admins:\n${admins.map(p => '@' + senderNumber(p.id)).join('\n')}`, mentions: admins.map(p => p.id) }, { quoted: m });
      }
      if (command === 'tagall' || command === 'hidetag') {
        const members = meta.participants.map(p => p.id);
        return sock.sendMessage(jid, {
          text: `${query || 'Attention everyone!'}${command === 'tagall' ? '\n' + members.map(x => '@' + senderNumber(x)).join(' ') : ''}`,
          mentions: members
        }, { quoted: m });
      }
      if (command === 'grouplink') {
        const code = await sock.groupInviteCode(jid);
        return reply(jid, `https://chat.whatsapp.com/${code}`, m);
      }
      if (command === 'revoke') {
        await sock.groupRevokeInvite(jid);
        return reply(jid, 'Invite link reset.', m);
      }
      if (command === 'antilink' || command === 'antispam' || command === 'welcome' || command === 'goodbye') {
        const value = (args[0] || '').toLowerCase();
        if (!['on', 'off'].includes(value)) return reply(jid, `Usage: ${PREFIX}${command} on|off`, m);
        cfg[command] = value === 'on';
        await saveJson(SETTINGS_FILE, settings);
        return reply(jid, `${command} is now ${value.toUpperCase()} (saved).`, m);
      }
      if (command === 'warn' || command === 'warnings') {
        if (!target) return reply(jid, `Mention or reply to a user: ${PREFIX}${command} @user`, m);
        const key = `${jid}:${target}`;
        if (command === 'warn') warnings[key] = (warnings[key] || 0) + 1;
        await saveJson(WARNINGS_FILE, warnings);
        return reply(jid, `⚠️ @${senderNumber(target)}: ${warnings[key] || 0} warning(s).`, m);
      }
      if (command === 'mute' || command === 'unmute') {
        if (!target) return reply(jid, `Mention or reply to a user: ${PREFIX}${command} @user`, m);
        cfg.muted = cfg.muted.filter(x => x !== target);
        if (command === 'mute') cfg.muted.push(target);
        await saveJson(SETTINGS_FILE, settings);
        return reply(jid, `${command === 'mute' ? 'Muted' : 'Unmuted'} @${senderNumber(target)}. The bot must be an admin to delete their messages.`, m);
      }
      if (['kick', 'promote', 'demote'].includes(command)) {
        if (!target) return reply(jid, `Mention or reply to a user: ${PREFIX}${command} @user`, m);
        if (target === sender || target.split(':')[0] === sock.user.id.split(':')[0]) return reply(jid, 'Cannot target yourself or the bot.', m);
        const action = command === 'kick' ? 'remove' : command;
        await sock.groupParticipantsUpdate(jid, [target], action);
        return reply(jid, `✅ ${command} completed for @${senderNumber(target)}.`, m);
      }
    }

    if (command === 'settings') {
      if (!owner) return reply(jid, 'Owner only.', m);
      return reply(jid, JSON.stringify(settings, null, 2).slice(0, 3500), m);
    }
    if (command === 'mode') {
      if (!owner) return reply(jid, 'Owner only.', m);
      if (!['public', 'private'].includes((args[0] || '').toLowerCase())) return reply(jid, 'Usage: .mode public|private', m);
      settings.mode = args[0].toLowerCase();
      await saveJson(SETTINGS_FILE, settings);
      return reply(jid, `Bot mode: ${settings.mode}. Note: command gating for private mode must be configured for your owner/admin policy.`, m);
    }
    if (command === 'sudo') {
      if (!owner) return reply(jid, 'Owner only.', m);
      const action = (args[0] || '').toLowerCase();
      const number = (args[1] || '').replace(/\D/g, '');
      if (!['add', 'remove'].includes(action) || number.length < 10) return reply(jid, 'Usage: .sudo add|remove 234XXXXXXXXX', m);
      settings.sudo = settings.sudo.filter(n => n !== number);
      if (action === 'add') settings.sudo.push(number);
      await saveJson(SETTINGS_FILE, settings);
      return reply(jid, `Sudo ${action}ed: ${number}`, m);
    }
    if (command === 'broadcast') {
      if (!owner) return reply(jid, 'Owner only.', m);
      if (!query) return reply(jid, 'Usage: .broadcast message (sends only to this chat in this version)', m);
      return reply(jid, `📢 ${query}`, m);
    }
    if (command === 'restart') {
      if (!owner) return reply(jid, 'Owner only.', m);
      return reply(jid, 'Use your process manager (PM2 or host restart button) to restart safely.', m);
    }
    if (command === 'tourl') {
      return reply(jid, 'Upload-to-URL needs a trusted upload provider API. Configure one before enabling this command.', m);
    }
    if (command === 'vv') {
      return reply(jid, '🔒 View-once media is temporary. SUPREME MD does not bypass WhatsApp privacy protections. Ask the sender to share it normally if you need to keep it.', m);
    }

    return reply(jid, `Unknown command. Type ${PREFIX}menu`, m);
  } catch (err) {
    console.error(`[COMMAND:${command}]`, err?.message || err);
    return reply(jid, `Command failed: ${err?.message || 'unexpected error'}`, m).catch(() => {});
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion();
  console.log('Using WhatsApp Web version:', version.join('.'));
  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: [BOT_NAME, 'Chrome', '1.0.0']
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      reconnecting = false;
      console.log(`👑 ${BOT_NAME} connected. Prefix: ${PREFIX}`);
    }
    if (connection === 'close' && !shuttingDown && !reconnecting) {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.error('[WA DISCONNECT]', JSON.stringify({ statusCode: code, message: lastDisconnect?.error?.message, payload: lastDisconnect?.error?.output?.payload }));
      if (code === DisconnectReason.loggedOut) {
        console.error('WhatsApp logged out. Re-link only when you are ready.');
        return;
      }
      reconnecting = true;
      await sleep(3000);
      reconnecting = false;
      connect().catch(console.error);
    }
  });

  sock.ev.on('group-participants.update', async event => {
    try {
      const cfg = groupConfig(event.id);
      const meta = await sock.groupMetadata(event.id);
      for (const participant of event.participants) {
        if (event.action === 'add' && cfg.welcome !== false) {
          await sock.sendMessage(event.id, {
            text: `👑 Welcome @${senderNumber(participant)} to *${meta.subject}*!\nPlease read the rules and respect everyone.`,
            mentions: [participant]
          });
        } else if (event.action === 'remove' && cfg.goodbye !== false) {
          await sock.sendMessage(event.id, {
            text: `👋 Goodbye @${senderNumber(participant)}. Take care!`,
            mentions: [participant]
          });
        }
      }
    } catch (err) {
      console.error('[GROUP EVENT]', err.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try { await processCommand(m); }
      catch (err) { console.error('[MESSAGE]', err.message); }
    }
  });

  if (!state.creds.registered) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const number = await rl.question('WhatsApp number with country code (digits only): ');
      const clean = number.replace(/\D/g, '');
      if (clean.length < 10) throw new Error('Phone number looks too short.');
      await sleep(1200);
      console.log(`Pairing code: ${await sock.requestPairingCode(clean)}`);
      console.log('On WhatsApp: Linked devices > Link a device > Link with phone number instead.');
    } finally { rl.close(); }
  }
}

process.on('SIGINT', () => { shuttingDown = true; sock?.end?.(new Error('SIGINT')); process.exit(0); });
process.on('SIGTERM', () => { shuttingDown = true; sock?.end?.(new Error('SIGTERM')); process.exit(0); });

await loadData();
connect().catch(err => { console.error('Fatal startup error:', err); process.exitCode = 1; });
