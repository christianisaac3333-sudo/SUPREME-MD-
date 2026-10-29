# SUPREME MD

A separate Baileys WhatsApp bot project using ES modules. It does not modify any other bot folder.

## Install in Termux

```bash
pkg update -y
pkg install nodejs-lts ffmpeg git -y
cd ~/SUPREME-MD-BOT
npm install
cp .env.example .env
nano .env
npm run check
npm start
```

Set `OWNER_NUMBER` to your number with country code, digits only. Keep `.env` and `auth_info/` private.

## Included commands

- General: `.menu`, `.alive`, `.ping`, `.uptime`, `.info`, `.id`, `.owner`, `.rules`, `.time`, `.calc`
- Groups: `.groupinfo`, `.admins`, `.tagall`, `.hidetag`, `.grouplink`, `.revoke`
- Moderation: `.warn`, `.warnings`, `.kick`, `.promote`, `.demote`, `.mute`, `.unmute`, `.antilink on|off`, `.antispam on|off`, `.welcome on|off`, `.goodbye on|off`
- Media: `.sticker` (reply to image), `.toimg` (reply to sticker), `.tomp3` (reply to audio/video; ffmpeg required), `.tourl` (provider integration not yet configured)
- AI: `.ask`, `.translate French | hello`, `.summarize`, `.weather city` (AI/weather API keys needed)
- Search shortcuts: `.pinterest`, `.google`, `.youtube`, `.tiktok`, `.instagram`, `.facebook`, `.spotify`, `.github`
- Fun: `.riddle`, `.answer`, `.guess`, `.flip`, `.dice`, `.roll`, `.joke`, `.fact`
- Owner: `.settings`, `.mode`, `.sudo`, `.broadcast` (currently replies only to current chat), `.restart` (use host/PM2)

## Notes

- Search shortcuts open the corresponding site's search page; they do not scrape or download protected content.
- `.vv` does not bypass WhatsApp view-once protections.
- `.mute @user` records a muted member and attempts to delete their messages; the bot needs admin permissions. Group message deletion can be limited by WhatsApp.
- Settings and warnings are stored in `data/`. Preserve that folder on hosting.
- Baileys is an unofficial WhatsApp Web integration. Use responsibly and avoid spam. API compatibility can change.
- For hosting, use a Node.js host with persistent storage for `auth_info/` and `data/`. Do not run the same session simultaneously on Termux and the host.
