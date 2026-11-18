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
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#090a0d">
<meta name="description" content="SUPREME MD CLOUD control centre and service status.">
<title>SUPREME MD CLOUD — Control Centre</title>
<style>
:root{color-scheme:dark;--bg:#090a0d;--panel:#121419;--panel2:#171a20;--line:#292d35;--gold:#d6b36b;--muted:#9299a5;--white:#f3f2ed;--green:#72d6a0;--red:#ff8585}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 80% -10%,#42351d55,transparent 38%),var(--bg);color:var(--white);font:15px/1.6 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 36px));margin:auto}
header{height:76px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:.13em}.mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--gold);color:var(--gold);border-radius:12px;font-size:21px}.brand small{display:block;color:var(--muted);font-size:9px;letter-spacing:.2em;font-weight:600}
.nav{display:flex;gap:20px;color:#c3c6cc;font-size:12px}.nav a:hover{color:var(--gold)}
.hero{padding:62px 0 34px;display:grid;grid-template-columns:1.3fr .7fr;gap:28px;align-items:center}.eyebrow{color:var(--gold);font-size:10px;letter-spacing:.22em;font-weight:800}.hero h1{font-size:clamp(36px,6vw,66px);line-height:1.02;letter-spacing:-.04em;margin:14px 0}.hero h1 em{font-style:normal;color:var(--gold)}.lead{color:#aeb3bd;max-width:620px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:25px}.btn{border:1px solid var(--line);border-radius:10px;padding:11px 16px;font-weight:700;font-size:12px;letter-spacing:.04em}.btn.primary{background:var(--gold);color:#17130c;border-color:var(--gold)}.btn:hover{transform:translateY(-1px)}
.statusbox{background:linear-gradient(145deg,#1a1c21,#101216);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 60px #0005}.statushead{display:flex;justify-content:space-between;align-items:center;font-weight:700}.pill{border-radius:99px;background:#21372b;color:var(--green);padding:4px 9px;font-size:10px}.pulse{display:inline-block;width:7px;height:7px;background:var(--green);border-radius:50%;margin-right:7px;box-shadow:0 0 14px var(--green)}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0 42px}.metric,.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px}.metric span{display:block;color:var(--muted);font-size:10px;letter-spacing:.12em}.metric strong{display:block;font-size:27px;margin-top:6px}.metric small{color:var(--muted)}
.sectionhead{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:16px}.sectionhead h2{margin:0;font-size:24px;letter-spacing:-.03em}.sectionhead p{margin:0;color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel h3{margin:0 0 8px;font-size:15px}.panel p{margin:0;color:var(--muted);font-size:13px}.command-tools{display:flex;gap:8px;margin:12px 0}.command-tools input{width:100%;background:#0b0d11;border:1px solid var(--line);border-radius:9px;padding:11px;color:var(--white);outline:none}.command-tools input:focus{border-color:var(--gold)}
.commands{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.category{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:13px}.category h4{margin:0 0 7px;color:var(--gold);font-size:11px;letter-spacing:.12em}.category pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#c8cbd1;font:12px/1.7 ui-monospace,SFMono-Regular,monospace;margin:0}
.note{border-left:2px solid var(--gold);padding:10px 13px;color:#b8bdc6;background:#17150f;border-radius:0 8px 8px 0;font-size:12px;margin-top:14px}
footer{border-top:1px solid var(--line);margin-top:48px;padding:24px 0;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media(max-width:760px){.hero{grid-template-columns:1fr;padding-top:40px}.nav{gap:10px;font-size:10px}.metrics{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.commands{grid-template-columns:1fr}.statusbox{max-width:none}}@media(max-width:420px){.nav a:nth-child(2){display:none}.metrics{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div class="wrap" style="display:flex;align-items:center;justify-content:space-between;width:100%"><a class="brand" href="/"><span class="mark">♤</span><span>SUPREME MD<small>CLOUD CONTROL CENTRE</small></span></a><nav class="nav"><a href="#status">STATUS</a><a href="#commands">COMMANDS</a><a href="#connect">CONNECT</a></nav></div></header>
<main class="wrap">
<section class="hero">
<div><div class="eyebrow">CHRIS REMAINS SUPREME · CLOUD PLATFORM</div><h1>ONE CLOUD.<br><em>MORE CONTROL.</em></h1><p class="lead">The SUPREME MD CLOUD service hub. Check the live service, explore command categories, and connect through the official Telegram control bot.</p><div class="actions"><a class="btn primary" href="https://t.me/Supremecy_bot" target="_blank" rel="noopener">OPEN TELEGRAM CONTROL ↗</a><a class="btn" href="https://supreme-md-v2.onrender.com" target="_blank" rel="noopener">SUPREME MD V2 WEBSITE ↗</a><a class="btn" href="/health">VIEW HEALTH JSON</a></div></div>
<aside class="statusbox" id="status"><div class="statushead"><span>LIVE SERVICE STATUS</span><span class="pill" id="statusPill">CHECKING</span></div><p style="color:var(--muted);font-size:12px;margin:13px 0 8px"><span class="pulse"></span><span id="statusText">Checking cloud response…</span></p><div style="border-top:1px solid var(--line);padding-top:13px;margin-top:13px;display:flex;justify-content:space-between;color:var(--muted);font-size:11px"><span>Last checked</span><strong id="checkedAt" style="color:var(--white)">—</strong></div><button class="btn" id="refresh" style="margin-top:15px;background:transparent;color:var(--white);cursor:pointer">↻ REFRESH STATUS</button></aside>
</section>
<section class="metrics" aria-label="Service metrics"><div class="metric"><span>REGISTERED ACCOUNTS</span><strong id="accounts">—</strong><small>Cloud account count</small></div><div class="metric"><span>ACTIVE WHATSAPP SESSIONS</span><strong id="sessions">—</strong><small id="capacity">Session capacity</small></div><div class="metric"><span>SERVER UPTIME</span><strong id="uptime">—</strong><small>Current process</small></div></section>
<section id="commands"><div class="sectionhead"><h2>Command directory</h2><p>Browse the controls available in Telegram.</p></div><div class="command-tools"><input id="search" type="search" placeholder="Search a command or category…" aria-label="Search commands"></div><div class="commands" id="commandList"><div class="panel">Loading command directory…</div></div></section>
<section class="grid" id="connect" style="margin-top:24px"><article class="panel"><h3>01 / Connect with Telegram</h3><p>Open the bot, register your Telegram account, then request a WhatsApp pairing code from the private chat.</p><div class="note">Telegram flow: /start → /register → /pair followed by your number with country code. Keep your pairing code private.</div><a class="btn primary" href="https://t.me/Supremecy_bot" target="_blank" rel="noopener" style="display:inline-block;margin-top:14px">OPEN @Supremecy_bot ↗</a></article><article class="panel"><h3>02 / Session safety</h3><p>Each registered account has a separate WhatsApp auth folder. Only connect accounts you own or are authorised to manage. Never share QR codes or pairing codes.</p><div class="note">The dashboard displays aggregate service counts only. It never displays phone numbers, Telegram IDs, QR codes, pairing codes, or saved credentials.</div></article></section>
</main>
<footer class="wrap"><span>♤ POWERED BY SUPREME DEV</span><span>SUPREME MD CLOUD · <span id="year"></span></span><span>CHRIS REMAINS SUPREME</span></footer>
<script>
const $=id=>document.getElementById(id);
function duration(s){s=Math.max(0,Math.floor(s||0));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return [d?d+'d':'',h?h+'h':'',m?m+'m':'',Math.floor(s%60)+'s'].filter(Boolean).join(' ')}
async function refresh(){try{const r=await fetch('/api/overview',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();$('statusPill').textContent='OPERATIONAL';$('statusText').textContent='Cloud API is responding';$('accounts').textContent=d.registeredAccounts;$('sessions').textContent=d.activeSessions;$('capacity').textContent='Maximum '+d.sessionCapacity+' sessions';$('uptime').textContent=duration(d.uptimeSeconds);$('checkedAt').textContent=new Date().toLocaleTimeString();}catch(e){$('statusPill').textContent='CHECK FAILED';$('statusText').textContent='Could not read service status';$('checkedAt').textContent=new Date().toLocaleTimeString();}}
function renderCommands(data){const root=$('commandList');root.innerHTML='';const q=$('search').value.trim().toLowerCase();let count=0;for(const item of data.categories||[]){if(q&&!((item.title+' '+item.commands).toLowerCase().includes(q)))continue;count++;const card=document.createElement('article');card.className='category';const title=document.createElement('h4');title.textContent=item.title;const pre=document.createElement('pre');pre.textContent=item.commands;card.append(title,pre);root.append(card)}if(!count){const empty=document.createElement('div');empty.className='panel';empty.textContent='No matching command category.';root.append(empty)}}
let commandData={categories:[]};fetch('/api/commands',{cache:'no-store'}).then(r=>r.json()).then(d=>{commandData=d;renderCommands(d)}).catch(()=>{$('commandList').textContent='Command directory is temporarily unavailable.'});$('search').addEventListener('input',()=>renderCommands(commandData));$('refresh').addEventListener('click',refresh);$('year').textContent=new Date().getFullYear();refresh();setInterval(refresh,30000);
</script>
</body></html>`);
});

app.get('/health', (_req, res) => {
  res.json({ service: 'SUPREME MD CLOUD', status: 'ok' });
});

let telegramPollingStatus = process.env.TELEGRAM_POLLING_ENABLED === 'false' ? 'disabled' : 'starting';
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

app.get('/api/overview', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    service: 'SUPREME MD CLOUD',
    status: 'ok',
    registeredAccounts: Object.keys(users).length,
    activeSessions: sessions.size,
    sessionCapacity: MAX_ACTIVE_SESSIONS,
    uptimeSeconds: Math.floor(process.uptime()),
    telegramConfigured: Boolean(TOKEN),
    telegramPollingEnabled: process.env.TELEGRAM_POLLING_ENABLED !== 'false',
    telegramStatus: telegramPollingStatus
  });
});

app.get('/api/commands', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    service: 'SUPREME MD CLOUD',
    prefix: WA_PREFIX,
    categories: Object.entries(MENU_PAGES).map(([key, page]) => ({
      key,
      title: key.replace(/^[a-z]/, value => value.toUpperCase()),
      commands: page.text
    }))
  });
});

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
    telegramPollingStatus = 'running';
    console.log('Telegram registration and pairing bot is running.');
  }).catch(err => {
    telegramPollingStatus = 'error';
    const safeMessage = String(
      err?.response?.description || err?.message || 'Unknown startup error'
    ).replace(/\b\d{6,}:[A-Za-z0-9_-]+\b/g, '[REDACTED]');

    console.error('[TELEGRAM STARTUP ERROR]', {
      name: err?.name || 'Error',
      message: safeMessage,
      code: err?.code || null,
      status: err?.response?.error_code || null
    });
    console.error('HTTP dashboard remains online; resolve the Telegram polling conflict separately.');
  });
} else {
  telegramPollingStatus = 'disabled';
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
