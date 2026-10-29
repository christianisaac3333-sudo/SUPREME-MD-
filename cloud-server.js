import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import {
  access,
  mkdir,
  readFile,
  writeFile,
  rename
} from 'node:fs/promises';
import { makeWASocket, Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@pasqua-baileys/baileys';
import pino from 'pino';
import { Telegraf } from 'telegraf';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAX_ACTIVE_SESSIONS = Math.max(
  1,
  Number(process.env.MAX_ACTIVE_SESSIONS || 10)
);

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Check your private .env file.');
  process.exit(1);
}

await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });

async function loadUsers() {
  try {
    const value = JSON.parse(await readFile(USERS_FILE, 'utf8'));

    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('Invalid users database format');
    }

    return value;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

let users = await loadUsers();
let saveQueue = Promise.resolve();

function saveUsers() {
  const snapshot = JSON.stringify(users, null, 2);

  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const temporary = `${USERS_FILE}.tmp`;
    await writeFile(temporary, snapshot, { mode: 0o600 });
    await rename(temporary, USERS_FILE);
  });

  return saveQueue;
}

function telegramId(ctx) {
  const id = String(ctx.from?.id ?? '');
  if (!/^\d+$/.test(id)) throw new Error('Invalid Telegram ID');
  return id;
}

function authDirectory(id) {
  if (!/^\d+$/.test(id)) throw new Error('Invalid account ID');
  return path.join(SESSIONS_DIR, id, 'auth');
}

async function registeredWhatsAppSession(id) {
  try {
    const creds = JSON.parse(
      await readFile(path.join(authDirectory(id), 'creds.json'), 'utf8')
    );
    return creds.registered === true;
  } catch {
    return false;
  }
}

async function setWhatsAppStatus(id, status) {
  if (!users[id]) return;
  users[id].whatsappStatus = status;
  await saveUsers();
}

const app = express();
app.disable('x-powered-by');

app.get('/', (_req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="en">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>SUPREME MD CLOUD</title>
      <body style="background:#0b0b0f;color:#eee;font-family:Arial;padding:32px">
        <h1>👑 SUPREME MD CLOUD</h1>
        <p>Cloud service is running.</p>
        <p><a href="/health" style="color:#b9a7ff">Service health</a></p>
        <p>Telegram: @Supremecy_bot</p>
      </body>
    </html>
  `);
});

app.get('/health', (_req, res) => {
  res.json({ service: 'SUPREME MD CLOUD', status: 'ok' });
});

const bot = new Telegraf(TOKEN);
const logger = pino({ level: 'silent' });
const sessions = new Map();
const pairingCooldown = new Map();

bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private') return;
  return next();
});

async function startSession(id, phoneNumber = null) {
  if (!users[id]) throw new Error('Register first with /register');

  const existing = sessions.get(id);
  if (existing) return existing;

  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    throw new Error('The service has reached its active-session limit. Try later.');
  }

  const directory = authDirectory(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const { state, saveCreds } = await useMultiFileAuthState(directory);
  const sock = makeWASocket({
    browser: Browsers.macOS('Chrome'),
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  const entry = {
    sock,
    state,
    status: state.creds.registered ? 'connecting' : 'pairing',
    stopped: false,
    phoneNumber,
    pairingRequested: false,
    reconnectTimer: null
  };

  sessions.set(id, entry);
  await setWhatsAppStatus(id, entry.status);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, qr, lastDisconnect } = update;
console.log('[WA CONNECTION UPDATE]', {
  connection,
  hasQR: Boolean(qr),
  registered: Boolean(state.creds.registered),
  statusCode: lastDisconnect?.error?.output?.statusCode ?? null,
  reason: lastDisconnect?.error?.message ?? null
});

    if (
      connection === 'connecting' &&
      phoneNumber &&
      !state.creds.registered &&
      !entry.pairingRequested &&
      !entry.stopped
    ) {
      entry.pairingRequested = true;

      try {
        const number = String(phoneNumber).replace(/\D/g, '');
        if (!number) throw new Error('Phone number is empty or invalid');

        const code = await sock.requestPairingCode(number);

        if (entry.stopped || sessions.get(id) !== entry) return;

        await bot.telegram.sendMessage(
          id,
          'SUPREME MD — WhatsApp Pairing\n\n' +
          'Enter this code in WhatsApp > Linked devices > Link with phone number instead.\n\n' +
          `Pairing code: ${code}\n\nKeep this code private.`,
          { protect_content: true }
        );
      } catch (err) {
        console.error('[PAIRING] Code request failed:', err?.stack || err);
        entry.pairingRequested = false;
        await bot.telegram.sendMessage(
          id,
          'SUPREME MD could not generate a pairing code. Check the Termux log and try again.'
        ).catch(() => {});
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.phoneNumber = null;
      await setWhatsAppStatus(id, 'connected').catch(() => {});
      await bot.telegram.sendMessage(
        id,
        '✅ Your WhatsApp session is connected. Use /status to check it.'
      ).catch(() => {});
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.error('[WHATSAPP DISCONNECT]', {
        statusCode: code ?? null,
        reason: lastDisconnect?.error?.message || 'No error message',
        registered: Boolean(state.creds.registered)
      });

      if (code === DisconnectReason.loggedOut) {
        entry.stopped = true;
        entry.status = 'logged_out';

        if (sessions.get(id) === entry) sessions.delete(id);

        await setWhatsAppStatus(id, 'logged_out').catch(() => {});
        await bot.telegram.sendMessage(
          id,
          'Your WhatsApp session was logged out. Use /pair to link it again.'
        ).catch(() => {});
        return;
      }

      if (entry.stopped || sessions.get(id) !== entry) {
        return;
      }

      entry.status = 'reconnecting';
      await setWhatsAppStatus(id, 'reconnecting').catch(() => {});

      entry.reconnectTimer = setTimeout(async () => {
        if (entry.stopped || sessions.get(id) !== entry) return;

        sessions.delete(id);

        try {
          await startSession(
            id,
            state.creds.registered ? null : entry.phoneNumber
          );
        } catch {
          await setWhatsAppStatus(id, 'disconnected').catch(() => {});
          console.error('[SESSION] Reconnection failed.');
        }
      }, 5000);
    }
  });

  return entry;
}

bot.start(async ctx => {
  await ctx.reply(
    '👑 Welcome to SUPREME MD CLOUD.\n\n' +
    '/register - Create an account\n' +
    '/me - View your account\n' +
    '/pair 234XXXXXXXXX - Request a pairing code\n' +
    '/connect - Reconnect your saved session\n' +
    '/status - Check WhatsApp status\n' +
    '/disconnect - Stop your cloud connection\n' +
    '/help - Show commands'
  );
});

bot.command('register', async ctx => {
  try {
    const id = telegramId(ctx);

    if (users[id]) {
      return ctx.reply('You are already registered. Use /me.');
    }

    await mkdir(authDirectory(id), { recursive: true, mode: 0o700 });

    users[id] = {
      telegramId: id,
      username: ctx.from.username ?? null,
      createdAt: new Date().toISOString(),
      status: 'registered',
      whatsappStatus: 'not_connected'
    };

    await saveUsers();

    await ctx.reply(
      '✅ Registration successful.\n' +
      'Your WhatsApp session will be stored separately from other users.\n' +
      'Use /pair followed by your phone number including its country code.'
    );
  } catch {
    await ctx.reply('Registration failed. Please try again later.');
  }
});

bot.command('me', async ctx => {
  const id = telegramId(ctx);
  const user = users[id];

  if (!user) return ctx.reply('Send /register first.');

  await ctx.reply(
    '👑 SUPREME MD CLOUD ACCOUNT\n\n' +
    `Telegram ID: ${user.telegramId}\n` +
    `Account: ${user.status}\n` +
    `WhatsApp: ${user.whatsappStatus || 'not_connected'}\n` +
    `Registered: ${user.createdAt}`
  );
});

bot.command('pair', async ctx => {
  const id = telegramId(ctx);

  if (!users[id]) return ctx.reply('Send /register first.');

  const now = Date.now();
  const previous = pairingCooldown.get(id) || 0;

  if (now - previous < 60_000) {
    return ctx.reply('Please wait one minute between pairing requests.');
  }

  const existing = sessions.get(id);

  if (existing) {
    return ctx.reply(`Your session is currently ${existing.status}. Use /status.`);
  }

  const raw = ctx.message.text.trim().split(/\s+/)[1] || '';

  if (!/^\d{10,15}$/.test(raw)) {
    return ctx.reply(
      'Usage: /pair 234XXXXXXXXX\n\n' +
      'Include the country calling code. Use digits only, without +, spaces, or hyphens.'
    );
  }

  pairingCooldown.set(id, now);

  try {
    if (await registeredWhatsAppSession(id)) {
      await startSession(id);
      return ctx.reply(
        'A saved WhatsApp session was found. Reconnecting now; use /status to check it.'
      );
    }

    await startSession(id, raw);

    await ctx.reply(
      'Pairing started. I will send your code here in this private chat when WhatsApp is ready.'
    );
  } catch (err) {
    console.error('[PAIRING] Session startup failed:', err?.message || err);
    await ctx.reply(
      'Could not start pairing. Check your connection and try again later.'
    );
  }
});

bot.command('connect', async ctx => {
  const id = telegramId(ctx);

  if (!users[id]) return ctx.reply('Send /register first.');

  if (sessions.has(id)) {
    return ctx.reply(`Your session is ${sessions.get(id).status}.`);
  }

  if (!(await registeredWhatsAppSession(id))) {
    return ctx.reply('No linked WhatsApp session was found. Use /pair with your number.');
  }

  try {
    await startSession(id);
    await ctx.reply('Reconnection started. Use /status to check progress.');
  } catch {
    await ctx.reply('Could not reconnect. Please try again later.');
  }
});

bot.command('status', async ctx => {
  const id = telegramId(ctx);

  if (!users[id]) return ctx.reply('Send /register first.');

  const current = sessions.get(id);
  const status = current?.status || users[id].whatsappStatus || 'not_connected';

  await ctx.reply(`Your WhatsApp session status: ${status}`);
});

bot.command('disconnect', async ctx => {
  const id = telegramId(ctx);

  if (!users[id]) return ctx.reply('Send /register first.');

  const entry = sessions.get(id);

  if (!entry) {
    return ctx.reply('You have no active cloud connection.');
  }

  entry.stopped = true;
  clearTimeout(entry.reconnectTimer);

  if (sessions.get(id) === entry) sessions.delete(id);

  try {
    entry.sock.end(new Error('User requested disconnect'));
  } catch {}

  await setWhatsAppStatus(id, 'disconnected');

  await ctx.reply(
    'Your cloud connection has stopped. Saved credentials were retained so you can use /connect later.'
  );
});

bot.command('help', ctx => ctx.reply(
  'SUPREME MD CLOUD\n\n' +
  '/register - Create your account\n' +
  '/me - View account details\n' +
  '/pair 234XXXXXXXXX - Request a pairing code\n' +
  '/connect - Reconnect your saved session\n' +
  '/status - Check connection status\n' +
  '/disconnect - Stop your cloud connection'
));

bot.catch(err => {
  console.error('[TELEGRAM] A command failed:', err?.message || err);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SUPREME MD CLOUD listening on port ${PORT}`);
});

try {
  await bot.launch();
  console.log('Telegram registration and pairing bot is running.');
} catch {
  console.error('Telegram startup failed. Check the token and network.');
  server.close();
  process.exit(1);
}

// Restore only sessions whose own saved credentials indicate registration.
for (const id of Object.keys(users)) {
  if (!/^\d+$/.test(id)) continue;

  try {
    if (await registeredWhatsAppSession(id)) {
      await startSession(id);
    }
  } catch {
    console.error('[SESSION] A saved session could not be restored.');
  }
}

let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;

  for (const entry of sessions.values()) {
    entry.stopped = true;
    clearTimeout(entry.reconnectTimer);

    try {
      entry.sock.end(new Error(signal));
    } catch {}
  }

  bot.stop(signal);

  await new Promise(resolve => server.close(resolve));
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
