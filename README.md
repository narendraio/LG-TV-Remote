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
- No cloud, no account — everything stays on your local network

## Requirements

- Node.js 18 or newer
- An LG TV running webOS, on the same network as the computer running the server

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

On macOS you can also double-click `start.command`.

## First-time pairing

1. Turn the TV on.
2. Open the page → **Setup** → **Find TVs** → tap your TV (or type its IP).
3. The TV shows "Allow this device?" — choose **Yes** with the TV remote.

The pairing key is saved to `config.json` (git-ignored), so it reconnects automatically afterwards. See `config.example.json` for the format.

## Wake from off

The **Wake** button sends a Wake-on-LAN packet. On the TV enable
*Settings → General → Devices → TV On With Mobile → Turn on via Wi‑Fi* (menu names vary by model). The MAC address is learned automatically the first time you connect.

## Keyboard shortcuts (desktop)

Arrows = navigate · Enter = OK · Backspace = Back · Esc = Exit · `h` = Home · `m` = Mute · `+`/`-` = volume · Space = pause · digits = numbers

## Security

The server has no authentication and listens on all network interfaces, so anyone on your network can control the TV. Only run it on a trusted network and never expose it to the internet. See [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

## Disclaimer

This is an independent project and is not affiliated with, endorsed by, or sponsored by LG Electronics. "LG" and "webOS" are trademarks of their respective owners.
