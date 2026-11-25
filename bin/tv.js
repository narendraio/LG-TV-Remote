#!/usr/bin/env node
// Command-line control for a running LG TV Remote server.
//   node bin/tv.js volume up
//   TV_REMOTE_URL=http://192.168.1.10:8080 npx tv launch netflix
import process from 'node:process';

const BASE = (process.env.TV_REMOTE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '');
const PIN = process.env.REMOTE_PIN || '';

const BUTTONS = ['up', 'down', 'left', 'right', 'enter', 'ok', 'back', 'home', 'exit', 'menu', 'info', 'mute',
  'red', 'green', 'yellow', 'blue', 'dash', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const HELP = `Usage: tv <command> [args]

Power      on | off | screen on|off
Volume     volume [up|down|<0-100>] | mute | unmute
Channel    channel up|down
Media      play | pause | stop | rewind | forward
Keys       ${BUTTONS.join(' ')}
           key <NAME>              any webOS button name, e.g. key ASTERISK
Apps       apps                    list installed apps
           launch <name or id>     e.g. launch netflix
Inputs     inputs                  list inputs
           input <name or id>      e.g. input hdmi2
Text       type <text...>          type into the TV's on-screen keyboard
           toast <message...>      show a notification on the TV
Other      status

Server:    ${BASE}  (set TV_REMOTE_URL to change; REMOTE_PIN if PIN-protected)`;

async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
  const headers = { 'content-type': 'application/json' };
  if (PIN) headers['x-remote-pin'] = PIN;
  let r;
  try {
    r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(`Cannot reach the server at ${BASE}. Is "npm start" running?`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function pick(list, query, fields) {
  const q = norm(query);
  return list.find((x) => fields.some((f) => norm(x[f]) === q))
    || list.find((x) => fields.some((f) => norm(x[f]).startsWith(q)))
    || list.find((x) => fields.some((f) => norm(x[f]).includes(q)));
}

async function main(argv) {
  const [cmd, ...args] = argv;
  const a0 = (args[0] || '').toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return console.log(HELP);

  switch (cmd.toLowerCase()) {
    case 'status': {
      const s = await call('/api/status');
      return console.log(`${s.name || 'LG TV'} @ ${s.ip || '(none)'} — ${s.state}${s.paired ? '' : ' (not paired)'}`);
    }
    case 'on': case 'wake': await call('/api/power/on', {}); return console.log('Wake-on-LAN sent');
    case 'off': await call('/api/power/off', {}); return console.log('TV off');
    case 'screen':
      if (!['on', 'off'].includes(a0)) throw new Error('usage: tv screen on|off');
      return call('/api/power/screen', { on: a0 === 'on' });
    case 'volume': case 'vol': {
      if (a0 === 'up' || a0 === '+') return call('/api/volume/up', {});
      if (a0 === 'down' || a0 === '-') return call('/api/volume/down', {});
      if (/^\d+$/.test(a0)) return call('/api/volume/set', { volume: Number(a0) });
      const v = await call('/api/volume');
      const vs = v.volumeStatus || {};
      return console.log(`Volume ${vs.volume ?? v.volume}${(vs.muteStatus ?? v.muted) ? ' (muted)' : ''}`);
    }
    case 'mute': return call('/api/volume/mute', { mute: true });
    case 'unmute': return call('/api/volume/mute', { mute: false });
    case 'channel': case 'ch':
      if (!['up', 'down'].includes(a0)) throw new Error('usage: tv channel up|down');
      return call(`/api/channel/${a0}`, {});
    case 'play': case 'pause': case 'stop': case 'rewind': case 'forward':
      return call(`/api/media/${cmd.toLowerCase()}`, {});
    case 'key':
      if (!args[0]) throw new Error('usage: tv key <NAME>');
      return call(`/api/button/${encodeURIComponent(args[0].toUpperCase())}`, {});
    case 'apps': {
      const { apps } = await call('/api/apps');
      for (const x of apps) console.log(`${x.title.padEnd(32)} ${x.id}`);
      return;
    }
    case 'launch': case 'open': {
      if (!args.length) throw new Error('usage: tv launch <name or id>');
      const { apps } = await call('/api/apps');
      const app = pick(apps, args.join(' '), ['title', 'id']);
      if (!app) throw new Error(`No app matches "${args.join(' ')}". Run "tv apps" to list them.`);
      await call('/api/launch', { id: app.id });
      return console.log(`Launched ${app.title}`);
    }
    case 'inputs': {
      const { inputs } = await call('/api/inputs');
      for (const x of inputs) console.log(`${x.label.padEnd(24)} ${x.id}${x.connected ? '' : '  (not connected)'}`);
      return;
    }
    case 'input': {
      if (!args.length) throw new Error('usage: tv input <name or id>');
      const { inputs } = await call('/api/inputs');
      const inp = pick(inputs, args.join(' '), ['id', 'label']);
      if (!inp) throw new Error(`No input matches "${args.join(' ')}". Run "tv inputs" to list them.`);
      await call('/api/input', { id: inp.id });
      return console.log(`Switched to ${inp.label}`);
    }
    case 'type': return call('/api/text', { text: args.join(' ') });
    case 'toast': return call('/api/toast', { message: args.join(' ') });
    default: {
      const k = cmd.toLowerCase() === 'ok' ? 'ENTER' : cmd.toUpperCase();
      if (BUTTONS.includes(cmd.toLowerCase())) return call(`/api/button/${k}`, {});
      throw new Error(`Unknown command "${cmd}". Run "tv help".`);
    }
  }
}

main(process.argv.slice(2)).catch((e) => { console.error('Error:', e.message); process.exit(1); });
