# Contributing

Thanks for your interest in improving LG TV Remote!

## Getting started

1. Fork the repo and clone your fork.
2. `npm install`
3. `npm start` and open http://localhost:8080
4. Pair with a TV on your network (see the README).

## Guidelines

- Keep it dependency-light — the project intentionally only depends on `express` and `ws`.
- Match the existing code style (ES modules, 2-space indent).
- Test your change against a real webOS TV when possible, and mention the TV model / webOS version in your PR.
- Never commit your `config.json` — it contains your TV's pairing key.

## Reporting bugs

Open an issue with your TV model, webOS version, Node.js version, OS, and the server's terminal output.

## Pull requests

- One focused change per PR.
- Describe what changed and how you tested it.
