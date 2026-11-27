# LG TV Remote (web)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

Control an LG webOS TV from any browser on the same Wi‑Fi. A tiny Node.js server runs on your computer and talks to the TV over LG's local WebSocket API; your phone just opens a web page (installable as a PWA).

## Features

- D-pad, OK, Back, Home, Exit and number buttons
- Touchpad-style pointer and scrolling
- Volume, mute, channel up/down, media controls
- App launcher and input (HDMI) switcher
- Send text to the TV's on-screen keyboard
- Power off, screen off, and **Wake-on-LAN** power on
- Automatic TV discovery (SSDP + network scan)
- Keyboard shortcuts on desktop
- **Live view of the TV screen** on your phone (~1 fps, no audio) with playing/paused status
- **Voice & text commands**: “open Netflix”, “volume 20”, “switch to HDMI 2”, “turn off in 30 minutes”
- **Save a screenshot** of what's on the TV
- **Schedules**: turn the TV on or off at set times on chosen days
- **Volume limit**: caps the volume, even from the TV's own remote
- **Screen time**: how long each app was on, today or over the last 7 days
- No cloud, no account — everything stays on your local network

## Requirements

- Node.js 18 or newer
- An LG TV running webOS, on the same network as the computer running the server

## Run with Docker

Good for an always-on box like a Raspberry Pi or home server (Linux):

```bash
docker compose up -d
```

The container uses **host networking** so TV discovery (SSDP) and Wake-on-LAN broadcasts reach your LAN. Pairing data is kept in a `tv-remote-data` volume. Docker Desktop on macOS/Windows does not support host networking the same way, so there just use `npm start`.

## Run

```bash
git clone https://github.com/narendraio/LG-TV-Remote.git
cd LG-TV-Remote
npm install
npm start
```

Then open:

- On the computer: http://localhost:8080
- On your phone: the `http://<computer-ip>:8080` URL printed in the terminal (also shown under **Setup** in the app)

Use a different port with `PORT=9000 npm start`.

### Optional PIN

Anyone on your Wi‑Fi can open the remote by default. To require a PIN:

```bash
REMOTE_PIN=4821 npm start
```

The browser asks for the PIN once and remembers it. After 5 wrong attempts a device is locked out for a minute.

On macOS you can also double-click `start.command`.

## First-time pairing

1. Turn the TV on.
2. Open the page → **Setup** → **Find TVs** → tap your TV (or type its IP).
3. The TV shows "Allow this device?" — choose **Yes** with the TV remote.

The pairing key is saved to `config.json` (git-ignored), so it reconnects automatically afterwards. See `config.example.json` for the format.

## Wake from off

The **Wake** button sends a Wake-on-LAN packet. On the TV enable
*Settings → General → Devices → TV On With Mobile → Turn on via Wi‑Fi* (menu names vary by model). The MAC address is learned automatically the first time you connect.

## Command line

Control the TV from a terminal, scripts, cron jobs or Siri/Android shortcuts while the server is running:

```bash
npm run tv -- volume up
npm run tv -- volume 20
npm run tv -- launch netflix
npm run tv -- input hdmi2
npm run tv -- off
npm run tv -- do switch to hdmi 2       # any voice command
npm run tv -- screenshot tv.jpg
npm run tv -- schedule 23:30 off weekdays
npm run tv -- limit 30
npm run tv -- screentime 7
npm run tv -- help        # all commands
```

Run `npm link` once to get a global `tv` command (`tv mute`, `tv home`, …).
To control a server on another machine, set `TV_REMOTE_URL=http://192.168.1.10:8080`.

Every action is also a plain HTTP call, e.g. `curl -X POST http://localhost:8080/api/button/HOME`.

## Voice & text commands

Type into the box at the top of the page, or tap the 🎤 and speak. Examples:

| Say | Does |
|---|---|
| `open netflix`, `youtube`, `play jiohotstar` | open an app (fuzzy match) |
| `switch to hdmi 2`, `live tv` | change input |
| `volume 20`, `louder`, `volume down by 5`, `mute` | volume |
| `pause`, `play`, `fast forward` | media |
| `home`, `back`, `ok`, `down 3` | remote keys |
| `channel 105`, `next channel` | channels |
| `type cricket highlights` | type into the TV keyboard |
| `turn off`, `turn on`, `screen off` | power |
| `turn off in 30 minutes`, `cancel sleep` | sleep timer |

Browsers only allow the microphone on `https` or `localhost`. Over plain `http://<computer-ip>:8080` on a phone, use the microphone key on your phone's keyboard instead; the 🎤 button tells you so. From a terminal: `tv do open netflix`.

## Schedules, volume limit and screen time

- **Schedules** (More tab): pick a time, *Turn on* / *Turn off* and the days. Times use the server computer's clock. In Docker, set `TZ` (e.g. `TZ: "Asia/Kolkata"`) in `docker-compose.yml`. *Turn on* uses Wake-on-LAN, so set that up first (see below).
- **Volume limit** (Setup tab): if anyone turns the volume above the limit, including with the TV's own remote, it's turned back down.
- **Screen time** (More tab): while the server is running and the TV is on, it records which app is on screen every 30 seconds. Stored in `usage.json` next to `config.json` (last 35 days only, never leaves your computer).

Schedules and the volume limit are saved in `config.json` and kept when you **Forget** the TV.

## Keyboard shortcuts (desktop)

Arrows = navigate · Enter = OK · Backspace = Back · Esc = Exit · `h` = Home · `m` = Mute · `+`/`-` = volume · Space = pause · digits = numbers

## Security

By default the server has no authentication and listens on all network interfaces, so anyone on your network can control the TV. Set `REMOTE_PIN` (see above) to require a PIN. Only run it on a trusted network and never expose it to the internet. See [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

## Disclaimer

This is an independent project and is not affiliated with, endorsed by, or sponsored by LG Electronics. "LG" and "webOS" are trademarks of their respective owners.
