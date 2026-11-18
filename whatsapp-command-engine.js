const COMMANDS = [
  { category: 'GENERAL', items: [
    ['menu', 'Show active WhatsApp commands'],
    ['help', 'Show command help'],
    ['alive', 'Check whether this session is online'],
    ['ping', 'Check bot response'],
    ['uptime', 'Show this session uptime'],
    ['info', 'Show bot and prefix information'],
    ['id', 'Show chat and sender identifiers'],
    ['time', 'Show current server time']
  ]},
  { category: 'GAMES & FUN', items: [
    ['flip', 'Flip a coin'],
    ['dice', 'Roll a six-sided die'],
    ['roll 20', 'Roll a die with 2–100 sides'],
    ['joke', 'Get a short joke'],
    ['fact', 'Get a random fact']
  ]},
  { category: 'GROUP ADMIN', items: [
    ['groupinfo', 'Show group details'],
    ['admins', 'List group administrators'],
    ['grouplink', 'Get the group invite link'],
    ['revoke', 'Reset the group invite link'],
    ['kick @user', 'Remove a member (admin only)'],
    ['promote @user', 'Promote a member (admin only)'],
    ['demote @user', 'Demote a member (admin only)']
  ]},
  { category: 'PRIVACY', items: [
    ['vv', 'Explain view-once privacy support']
  ]}
];

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my computer I needed a break. It said it would go to sleep.',
  'Why was the math book worried? It had too many problems.'
];
const facts = [
  'Octopuses have three hearts.',
  'A day on Venus is longer than its year.',
  'Honey can remain stable for a very long time when properly sealed.'
];

function normalizeJid(value) {
  return String(value || '').split(':')[0];
}

function getMessageText(message = {}) {
  const body = message.message || {};
  return body.conversation ||
    body.extendedTextMessage?.text ||
    body.imageMessage?.caption ||
    body.videoMessage?.caption ||
    body.documentMessage?.caption ||
    body.buttonsResponseMessage?.selectedButtonId ||
    body.listResponseMessage?.singleSelectReply?.selectedRowId ||
    '';
}

function getContext(message = {}) {
  const body = message.message || {};
  return body.extendedTextMessage?.contextInfo ||
    body.imageMessage?.contextInfo ||
    body.videoMessage?.contextInfo ||
    body.documentMessage?.contextInfo ||
    {};
}

function formatMenu(prefix) {
  const lines = [
    '♤ SUPREME MD — WHATSAPP COMMANDS ♤',
    '━━━━━━━━━━━━━━━━━━━━',
    'Only commands implemented by this paired Cloud engine are shown.',
    ''
  ];
  for (const group of COMMANDS) {
    lines.push('〔 ' + group.category + ' 〕');
    for (const [name, description] of group.items) {
      lines.push(prefix + name + ' — ' + description);
    }
    lines.push('');
  }
  lines.push('♤ POWERED BY SUPREME DEV ♤');
  return lines.join('\n');
}

function getTarget(message) {
  const context = getContext(message);
  const mentioned = context.mentionedJid?.[0];
  const quoted = context.participant;
  return mentioned || quoted || null;
}

export function activeWhatsAppCommandDirectory(prefix = '.') {
  return COMMANDS.map(group => ({
    title: group.category,
    commands: group.items.map(([name, description]) => prefix + name + ' — ' + description).join('\n')
  }));
}

export function attachWhatsAppCommandEngine(sock, { prefix = '.', startedAt = Date.now() } = {}) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages || []) {
      try {
        if (!message?.message || message.key?.remoteJid === 'status@broadcast') continue;
        const jid = message.key?.remoteJid;
        if (!jid) continue;
        const text = getMessageText(message).trim();
        if (!text.startsWith(prefix)) continue;

        const parts = text.slice(prefix.length).trim().split(/\s+/);
        const command = (parts.shift() || '').toLowerCase();
        const args = parts;
        const query = args.join(' ');
        const isGroup = jid.endsWith('@g.us');
        const sender = message.key?.participant || jid;
        const reply = value => sock.sendMessage(jid, { text: String(value) }, { quoted: message });

        if (['menu', 'help', 'commands'].includes(command)) {
          await reply(formatMenu(prefix));
          continue;
        }
        if (['alive', 'ping'].includes(command)) {
          await reply('♤ SUPREME MD CLOUD is online.\nStatus: ACTIVE\n🏓 Pong!');
          continue;
        }
        if (command === 'uptime') {
          const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = seconds % 60;
          await reply('⏱️ Session uptime: ' + h + 'h ' + m + 'm ' + s + 's');
          continue;
        }
        if (command === 'info') {
          await reply('♤ SUPREME MD CLOUD\nWhatsApp engine: active\nPrefix: ' + prefix);
          continue;
        }
        if (command === 'id') {
          await reply('Chat: ' + jid + '\nSender: ' + sender);
          continue;
        }
        if (command === 'time') {
          await reply('🕒 ' + new Date().toLocaleString());
          continue;
        }
        if (command === 'flip') {
          await reply(Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!');
          continue;
        }
        if (command === 'dice') {
          await reply('🎲 ' + (Math.floor(Math.random() * 6) + 1));
          continue;
        }
        if (command === 'roll') {
          const sides = Number(args[0] || 6);
          if (!Number.isInteger(sides) || sides < 2 || sides > 100) {
            await reply('Usage: ' + prefix + 'roll 20 (choose 2–100 sides).');
          } else {
            await reply('🎲 ' + (Math.floor(Math.random() * sides) + 1) + ' / ' + sides);
          }
          continue;
        }
        if (command === 'joke') {
          await reply(jokes[Math.floor(Math.random() * jokes.length)]);
          continue;
        }
        if (command === 'fact') {
          await reply('💡 ' + facts[Math.floor(Math.random() * facts.length)]);
          continue;
        }
        if (command === 'vv') {
          await reply('🔒 SUPREME MD does not bypass view-once privacy. Ask the sender to share the media normally if you need a copy.');
          continue;
        }

        const groupCommands = ['groupinfo', 'admins', 'grouplink', 'revoke', 'kick', 'promote', 'demote'];
        if (groupCommands.includes(command)) {
          if (!isGroup) {
            await reply('This command works in WhatsApp groups only.');
            continue;
          }
          const metadata = await sock.groupMetadata(jid);
          const participants = metadata.participants || [];
          const senderId = normalizeJid(sender);
          const botId = normalizeJid(sock.user?.id);
          const senderEntry = participants.find(p => normalizeJid(p.id) === senderId);
          const botEntry = participants.find(p => normalizeJid(p.id) === botId);
          const senderAdmin = Boolean(senderEntry?.admin);
          const botAdmin = Boolean(botEntry?.admin);

          if (command === 'groupinfo') {
            await reply('♤ GROUP INFORMATION\nName: ' + metadata.subject +
              '\nMembers: ' + participants.length +
              '\nCreated: ' + (metadata.creation ? new Date(metadata.creation * 1000).toLocaleDateString() : 'Unavailable'));
            continue;
          }
          if (command === 'admins') {
            const admins = participants.filter(p => p.admin);
            await reply('♤ GROUP ADMINS\n' + admins.map(p => '• ' + (p.id || 'Unknown')).join('\n'));
            continue;
          }
          if (!senderAdmin) {
            await reply('Only group administrators can use this command.');
            continue;
          }
          if (command === 'grouplink') {
            const code = await sock.groupInviteCode(jid);
            await reply('Group invite link: https://chat.whatsapp.com/' + code);
            continue;
          }
          if (command === 'revoke') {
            if (!botAdmin) {
              await reply('Make SUPREME MD a group admin before resetting the invite link.');
              continue;
            }
            await sock.groupRevokeInvite(jid);
            await reply('✅ Group invite link has been reset.');
            continue;
          }
          const target = getTarget(message);
          if (!target) {
            await reply('Mention or reply to a member. Example: ' + prefix + command + ' @user');
            continue;
          }
          if (!botAdmin) {
            await reply('Make SUPREME MD a group admin before using ' + prefix + command + '.');
            continue;
          }
          if (normalizeJid(target) === botId || normalizeJid(target) === senderId) {
            await reply('That member cannot be targeted by this command.');
            continue;
          }
          const action = command === 'kick' ? 'remove' : command;
          await sock.groupParticipantsUpdate(jid, [target], action);
          await reply('✅ ' + command + ' completed.');
          continue;
        }
        await reply('Unknown or inactive command. Type ' + prefix + 'menu to see the active commands.');
      } catch (error) {
        console.error('[WHATSAPP COMMAND]', error?.message || error);
        try {
          const jid = message.key?.remoteJid;
          if (jid) await sock.sendMessage(jid, {
            text: 'That command could not be completed. Check that the bot has the required group permissions and try again.'
          }, { quoted: message });
        } catch {}
      }
    }
  });
}
