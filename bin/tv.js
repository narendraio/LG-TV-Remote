#!/usr/bin/env node
// Command-line control for a running LG TV Remote server.
//   node bin/tv.js volume up
//   TV_REMOTE_URL=http://192.168.1.10:8080 npx tv launch netflix
import process from 'node:process';
import fs from 'node:fs';

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
Say it     do <sentence...>        e.g. do open netflix · do volume 20 · do switch to hdmi 2
Screen     screenshot [file.jpg]   save what's on the TV
Limit      limit [<1-100>|off]     show or set the maximum volume
Schedule   schedules               list on/off schedules
           schedule <HH:MM> on|off [daily|weekdays|weekends|mon,wed,...]
           unschedule <id>
Usage      screentime [days]       time per app (default: today)
Other      status

Server:    ${BASE}  (set TV_REMOTE_URL to change; REMOTE_PIN if PIN-protected)`;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function parseDays(arg = 'daily') {
  const a = arg.toLowerCase();
  if (a === 'daily' || a === 'everyday') return [0, 1, 2, 3, 4, 5, 6];
  if (a === 'weekdays') return [1, 2, 3, 4, 5];
  if (a === 'weekends') return [0, 6];
  const days = a.split(',').map((d) => DAYS.indexOf(d.trim().slice(0, 3)));
  if (days.some((d) => d < 0)) throw new Error(`Unknown days "${arg}". Use daily, weekdays, weekends or e.g. mon,wed,fri`);
  return days;
}
const fmtDur = (sec) => { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };

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
    case 'do': case 'say': {
      if (!args.length) throw new Error('usage: tv do <sentence>, e.g. tv do open youtube');
      const r = await call('/api/command', { text: args.join(' ') });
      return console.log(r.did);
    }
    case 'screenshot': case 'snap': {
      const headers = PIN ? { 'x-remote-pin': PIN } : {};
      let r;
      try { r = await fetch(BASE + '/api/screen', { headers }); } catch { throw new Error(`Cannot reach the server at ${BASE}. Is "npm start" running?`); }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${r.statusText}`);
      const file = args[0] || `tv-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.jpg`;
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return console.log(`Saved ${file}`);
    }
    case 'limit': {
      if (!a0) { const r = await call('/api/volume-limit'); return console.log(r.max ? `Volume limited to ${r.max}` : 'No volume limit'); }
      if (a0 !== 'off' && !/^\d+$/.test(a0)) throw new Error('usage: tv limit [<1-100>|off]');
      const r = await call('/api/volume-limit', { max: a0 === 'off' ? null : Number(a0) });
      return console.log(r.max ? `Volume limited to ${r.max}` : 'Volume limit off');
    }
    case 'schedules': {
      const { schedules, timeZone } = await call('/api/schedules');
      if (!schedules.length) return console.log('No schedules');
      for (const x of schedules) console.log(`${x.id}  ${x.time}  turn ${x.action.padEnd(3)}  ${x.days.map((d) => DAYS[d]).join(',')}${x.enabled ? '' : '  (paused)'}`);
      return console.log(`(server time zone: ${timeZone})`);
    }
    case 'schedule': {
      const [time, action, days] = args;
      if (!time || !['on', 'off'].includes((action || '').toLowerCase())) throw new Error('usage: tv schedule <HH:MM> on|off [daily|weekdays|weekends|mon,wed,...]');
      const { schedule } = await call('/api/schedules', { time: time.padStart(5, '0'), action: action.toLowerCase(), days: parseDays(days) });
      return console.log(`Added ${schedule.id}: turn ${schedule.action} at ${schedule.time}`);
    }
    case 'unschedule': {
      if (!args[0]) throw new Error('usage: tv unschedule <id>  (see "tv schedules")');
      await call(`/api/schedules/${encodeURIComponent(args[0])}`, undefined, 'DELETE');
      return console.log('Schedule removed');
    }
    case 'screentime': {
      const days = Number(a0) || 1;
      const r = await call(`/api/screentime?days=${days}`);
      console.log(`${days === 1 ? 'Today' : `Last ${days} days`}: ${fmtDur(r.totalSec)}`);
      for (const x of r.apps) console.log(`  ${fmtDur(x.sec).padStart(7)}  ${x.title}`);
      return;
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
