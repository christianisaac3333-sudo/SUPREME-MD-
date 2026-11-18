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
import { makeWASocket, Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
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
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (entry.stopped || sessions.get(id) !== entry) return;

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



const WA_PREFIX = process.env.BOT_PREFIX || '.';

const MENU_PAGES = {
  home: {
    text:
      '♤ SUPREME MD CLOUD ♤\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      'WELCOME TO THE SUPREME COMMAND CENTRE\n\n' +
      'Explore the command categories below.\n' +
      'WhatsApp commands run through your linked WhatsApp bot.\n\n' +
      '♤ CHRIS REMAINS SUPREME ♤',
    buttons: [
      ['menu_general', '♤ GENERAL'],
      ['menu_ai', '♤ SUPREME AI'],
      ['menu_media', '♤ MEDIA'],
      ['menu_search', '♤ SEARCH & APPS'],
      ['menu_group', '♤ GROUP MANAGEMENT'],
      ['menu_games', '♤ GAMES & FUN'],
      ['menu_owner', '♤ OWNER TOOLS'],
      ['menu_account', '♤ ACCOUNT'],
      ['menu_whatsapp', '♤ WHATSAPP CONTROL']
    ]
  },

  general: {
    text:
      '♤ GENERAL COMMANDS ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'menu — Open command menu\n' +
      WA_PREFIX + 'help — Show help\n' +
      WA_PREFIX + 'alive — Check if bot is online\n' +
      WA_PREFIX + 'ping — Check response\n' +
      WA_PREFIX + 'uptime — Bot running time\n' +
      WA_PREFIX + 'info — Bot information\n' +
      WA_PREFIX + 'id — Chat and sender ID\n' +
      WA_PREFIX + 'jid — Chat identifier\n' +
      WA_PREFIX + 'owner — Owner contact\n' +
      WA_PREFIX + 'rules — Group rules\n' +
      WA_PREFIX + 'time — Current time\n' +
      WA_PREFIX + 'calc 12+8 — Calculator',
    buttons: []
  },

  ai: {
    text:
      '♤ SUPREME AI ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'ask <question> — Ask AI anything\n\n' +
      WA_PREFIX + 'translate French | Hello — Translate text\n\n' +
      WA_PREFIX + 'summarize <text> — Summarize text\n\n' +
      WA_PREFIX + 'weather Port Harcourt — Weather lookup\n\n' +
      'AI availability depends on your API configuration.',
    buttons: []
  },

  media: {
    text:
      '♤ MEDIA CENTRE ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'sticker — Turn a replied image into a sticker\n\n' +
      WA_PREFIX + 'toimg — Convert a replied sticker to an image\n\n' +
      WA_PREFIX + 'tomp3 — Convert replied audio/video to MP3\n\n' +
      WA_PREFIX + 'tourl — Upload feature (provider not configured)\n\n' +
      WA_PREFIX + 'vv — View-once privacy information\n\n' +
      'Reply to supported media before using conversion commands.',
    buttons: []
  },

  search: {
    text:
      '♤ SEARCH & APPS ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'google <query>\n' +
      WA_PREFIX + 'youtube <query>\n' +
      WA_PREFIX + 'pinterest <query>\n' +
      WA_PREFIX + 'tiktok <query>\n' +
      WA_PREFIX + 'instagram <query>\n' +
      WA_PREFIX + 'facebook <query>\n' +
      WA_PREFIX + 'spotify <query>\n' +
      WA_PREFIX + 'github <query>\n\n' +
      'Example: ' + WA_PREFIX + 'youtube science projects',
    buttons: []
  },

  group: {
    text:
      '♤ GROUP MANAGEMENT ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'groupinfo — Group information\n' +
      WA_PREFIX + 'admins — View administrators\n' +
      WA_PREFIX + 'tagall [text] — Mention members\n' +
      WA_PREFIX + 'hidetag [text] — Hidden member mention\n' +
      WA_PREFIX + 'grouplink — Get invite link\n' +
      WA_PREFIX + 'revoke — Reset invite link\n' +
      WA_PREFIX + 'warn @user — Add warning\n' +
      WA_PREFIX + 'warnings @user — Check warnings\n' +
      WA_PREFIX + 'kick @user — Remove member\n' +
      WA_PREFIX + 'promote @user — Promote member\n' +
      WA_PREFIX + 'demote @user — Demote member\n' +
      WA_PREFIX + 'mute @user — Mute member\n' +
      WA_PREFIX + 'unmute @user — Unmute member\n' +
      WA_PREFIX + 'antilink on/off\n' +
      WA_PREFIX + 'antispam on/off\n' +
      WA_PREFIX + 'welcome on/off\n' +
      WA_PREFIX + 'goodbye on/off\n\n' +
      'Group commands require the appropriate admin permissions.',
    buttons: []
  },

  games: {
    text:
      '♤ GAMES & FUN ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'riddle — Start a riddle\n' +
      WA_PREFIX + 'answer <answer> — Answer a riddle\n' +
      WA_PREFIX + 'guess — Start number guessing\n' +
      WA_PREFIX + 'guess <1-10> — Make a guess\n' +
      WA_PREFIX + 'flip — Coin flip\n' +
      WA_PREFIX + 'dice — Roll a dice\n' +
      WA_PREFIX + 'roll 20 — Roll custom dice\n' +
      WA_PREFIX + 'joke — Random joke\n' +
      WA_PREFIX + 'fact — Random fact',
    buttons: []
  },

  owner: {
    text:
      '♤ OWNER CONTROL ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      WA_PREFIX + 'settings — View bot settings\n' +
      WA_PREFIX + 'mode public/private — Set bot mode\n' +
      WA_PREFIX + 'sudo add/remove <number> — Manage sudo\n' +
      WA_PREFIX + 'broadcast <text> — Current-chat announcement\n' +
      WA_PREFIX + 'restart — Restart guidance\n\n' +
      'These commands are restricted to the configured owner.',
    buttons: []
  },

  account: {
    text:
      '♤ ACCOUNT CENTRE ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      '/register — Create your cloud account\n' +
      '/me — View your account details\n\n' +
      'Your account information is private.',
    buttons: [
      ['menu_register', 'REGISTER'],
      ['menu_me', 'MY ACCOUNT']
    ]
  },

  whatsapp: {
    text:
      '♤ WHATSAPP CONTROL ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      '/pair 234XXXXXXXXX — Link WhatsApp\n' +
      '/connect — Reconnect saved session\n' +
      '/status — Check connection status\n' +
      '/disconnect — Stop cloud connection\n\n' +
      'Keep your pairing code private.',
    buttons: [
      ['menu_pair', 'PAIR WHATSAPP'],
      ['menu_status', 'CONNECTION STATUS'],
      ['menu_connect', 'RECONNECT'],
      ['menu_disconnect', 'DISCONNECT']
    ]
  },

  help: {
    text:
      '♤ SUPREME HELP CENTRE ♤\n━━━━━━━━━━━━━━━━━━\n\n' +
      '/start — Open main menu\n' +
      '/menu — Open main menu\n' +
      '/help — Show help\n' +
      '/register — Create account\n' +
      '/me — Account details\n' +
      '/pair — Link WhatsApp\n' +
      '/connect — Reconnect\n' +
      '/status — Connection status\n' +
      '/disconnect — Stop connection',
    buttons: [
      ['menu_account', 'ACCOUNT'],
      ['menu_whatsapp', 'WHATSAPP']
    ]
  }
};

function menuKeyboard(page) {
  const selected = MENU_PAGES[page];
  const rows = [];

  for (let i = 0; i < selected.buttons.length; i += 2) {
    rows.push(
      selected.buttons.slice(i, i + 2).map(([action, label]) => ({
        text: label,
        callback_data: action
      }))
    );
  }

  if (page !== 'home') {
    rows.push([{ text: '♤ BACK TO MAIN MENU', callback_data: 'menu_home' }]);
  }

  if (page !== 'help') {
    rows.push([{ text: 'HELP & COMMANDS', callback_data: 'menu_help' }]);
  }

  return rows;
}

async function showMenu(ctx, page = 'home', edit = false) {
  const selected = MENU_PAGES[page];
  if (!selected) return;

  const options = {
    reply_markup: { inline_keyboard: menuKeyboard(page) }
  };

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(selected.text, options);
    } catch (err) {
      if (!String(err?.description || err?.message).includes('message is not modified')) {
        throw err;
      }
    }
  } else {
    await ctx.reply(selected.text, options);
  }
}

bot.start(ctx => showMenu(ctx));
bot.command('menu', ctx => showMenu(ctx));
bot.command('help', ctx => showMenu(ctx, 'help'));

bot.action('menu_home', async ctx => {
  await ctx.answerCbQuery();
  await showMenu(ctx, 'home', true);
});

for (const page of ['general', 'ai', 'media', 'search', 'group', 'games', 'owner', 'account', 'whatsapp', 'help']) {
  bot.action('menu_' + page, async ctx => {
    await ctx.answerCbQuery();
    await showMenu(ctx, page, true);
  });
}

const MENU_COMMANDS = {
  menu_register: '/register',
  menu_me: '/me',
  menu_pair: '/pair',
  menu_status: '/status',
  menu_connect: '/connect',
  menu_disconnect: '/disconnect'
};

for (const [action, command] of Object.entries(MENU_COMMANDS)) {
  bot.action(action, async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(
      command === '/pair'
        ? 'To link WhatsApp, send:\n/pair 234XXXXXXXXX\n\nUse your country code and digits only.'
        : 'Send ' + command + ' in this private chat to continue.'
    );
  });
}

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

bot.catch(err => {
  console.error('[TELEGRAM] A command failed:', err?.message || err);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SUPREME MD CLOUD listening on port ${PORT}`);
});

if (process.env.TELEGRAM_POLLING_ENABLED !== 'false') {
  bot.launch({}, () => {
    console.log('Telegram registration and pairing bot is running.');
  }).catch(err => {
    const safeMessage = String(
      err?.response?.description || err?.message || 'Unknown startup error'
    ).replace(/\b\d{6,}:[A-Za-z0-9_-]+\b/g, '[REDACTED]');

    console.error('[TELEGRAM STARTUP ERROR]', {
      name: err?.name || 'Error',
      message: safeMessage,
      code: err?.code || null,
      status: err?.response?.error_code || null
    });

    server.close();
    process.exit(1);
  });
} else {
  console.log('Telegram polling disabled on SUPREME MD CLOUD; V2 API owns this bot token.');
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
