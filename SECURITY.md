# Security Policy

## Scope

LG TV Remote is designed to run on a **trusted home network**. The web server listens on all
interfaces (`0.0.0.0`) and has **no authentication** — anyone who can reach the port can control
the paired TV. Do not expose it to the internet (no port forwarding, no public tunnels).

`config.json` stores your TV's pairing key. Keep it private and never commit it.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](../../security/advisories/new) rather than opening a public issue.
