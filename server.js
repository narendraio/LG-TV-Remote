import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LGTV, discover, localIPs, macFromArp, macOf, wakeOnLan } from './lgtv.js';
import { parseCommand, pick } from './commands.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(__dirname, 'config.json');
const PORT = Number(process.env.PORT || 8080);
const PIN = (process.env.REMOTE_PIN || '').trim();

let config = { ip: null, clientKey: null, mac: null, name: null, maxVolume: null, schedules: [] };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
if (!Array.isArray(config.schedules)) config.schedules = [];
const saveConfig = () => {
  try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2)); }
  catch (e) { console.log('[config] could not save', CONFIG, '-', e.message); }
};

let tv = null;
let connecting = null;

async function connectTo(ip) {
  if (tv) tv.close();
  tv = new LGTV({ ip, clientKey: config.ip === ip ? config.clientKey : null });
  tv.on('key', (k) => { config.clientKey = k; config.ip = ip; saveConfig(); });
  tv.on('state', (s) => console.log(`[tv] ${ip} ${s}`));
  await tv.connect();
  config.ip = ip; saveConfig();
  watchVolume(tv);
  // Learn the MAC for wake-on-LAN (from TV first, ARP as fallback).
  try {
    const info = await tv.connectionInfo();
    const mac = info?.wifiInfo?.macAddress || info?.wiredInfo?.macAddress;
    if (mac) config.mac = mac.toLowerCase();
  } catch {}
  if (!config.mac) { const m = await macFromArp(ip); if (m) config.mac = m; }
  try { const si = await tv.systemInfo(); config.name = si?.modelName || config.name; } catch {}
  saveConfig();
  return tv;
}

// Routers often hand the TV a new IP. If the saved IP stops answering, look for
// an LG TV on the network with the same MAC address and switch to it, keeping
// the pairing key (keys belong to the TV, not the IP).
let lastSearch = 0;
async function findMovedTV() {
  if (!config.mac || Date.now() - lastSearch < 60_000) return null;
  lastSearch = Date.now();
  console.log(`[tv] ${config.ip} not answering, looking for the TV (${config.mac}) on the network…`);
  for (const { ip } of await discover()) {
    if (ip !== config.ip && (await macOf(ip)) === config.mac) return ip;
  }
  return null;
}

async function ensureConnected() {
  if (tv?.connected) return tv;
  if (!config.ip) throw new Error('No TV configured. Open Settings and pick your TV.');
  if (!connecting) {
    connecting = connectTo(config.ip).catch(async (err) => {
      if (err.fromTV) throw err; // the TV answered (e.g. pairing rejected), it hasn't moved
      const ip = await findMovedTV().catch(() => null);
      if (!ip) throw err;
      console.log(`[tv] found the TV at its new address ${ip} (was ${config.ip})`);
      config.ip = ip; saveConfig(); // keep clientKey: same TV, new IP
      return connectTo(ip);
    }).finally(() => { connecting = null; });
  }
  return connecting;
}

const app = express();
app.use(express.json());

// Optional PIN protection: set REMOTE_PIN to require it on every /api request.
const pinFailures = new Map(); // ip -> { count, until }
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};
app.use('/api', (req, res, next) => {
  if (!PIN) return next();
  const ip = req.ip;
  const f = pinFailures.get(ip);
  if (f?.until && f.until > Date.now()) {
    return res.status(429).json({ ok: false, error: 'Too many wrong PIN attempts. Try again in a minute.' });
  }
  // Header for fetch(); ?pin= for things that can't send headers (e.g. <img> streams)
  const given = String(req.get('x-remote-pin') || req.query.pin || '');
  if (given && safeEqual(given, PIN)) { pinFailures.delete(ip); return next(); }
  if (given) {
    const count = (f?.count || 0) + 1;
    pinFailures.set(ip, count >= 5 ? { count: 0, until: Date.now() + 60_000 } : { count });
  }
  res.status(401).json({ ok: false, pinRequired: true, error: given ? 'Wrong PIN' : 'PIN required' });
});
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try { const out = await fn(req, res); res.json(out ?? { ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

app.get('/api/status', (req, res) => res.json({
  ip: config.ip, name: config.name, mac: config.mac, paired: !!config.clientKey,
  state: tv?.state || 'disconnected', error: tv?.lastError || null, serverIPs: localIPs(), port: PORT,
  maxVolume: config.maxVolume ?? null,
}));

app.get('/api/discover', wrap(async () => ({ tvs: await discover() })));

app.post('/api/connect', wrap(async (req) => {
  const ip = (req.body?.ip || config.ip || '').trim();
  if (!ip) throw new Error('ip required');
  if (config.ip !== ip) { config.clientKey = null; config.mac = null; config.name = null; }
  await connectTo(ip);
  return { ok: true, state: tv.state, name: config.name };
}));

app.post('/api/disconnect', wrap(async () => { tv?.close(); }));
// Forget the TV but keep the user's own settings (volume limit, schedules).
app.post('/api/forget', wrap(async () => { tv?.close(); tv = null; config = { ...config, ip: null, clientKey: null, mac: null, name: null }; saveConfig(); }));

// Remote-control style buttons go through the pointer socket (UP/DOWN/ENTER/BACK/HOME/...)
app.post('/api/button/:name', wrap(async (req) => { const t = await ensureConnected(); await t.sendButton(req.params.name.toUpperCase()); }));

app.post('/api/pointer/move', wrap(async (req) => { const t = await ensureConnected(); await t.pointerMove(req.body.dx || 0, req.body.dy || 0, !!req.body.down); }));
app.post('/api/pointer/click', wrap(async () => { const t = await ensureConnected(); await t.pointerClick(); }));
app.post('/api/pointer/scroll', wrap(async (req) => { const t = await ensureConnected(); await t.pointerScroll(req.body.dx || 0, req.body.dy || 0); }));

app.post('/api/volume/up', wrap(async () => volumeUp(await ensureConnected())));
app.post('/api/volume/down', wrap(async () => (await ensureConnected()).volumeDown()));
app.post('/api/volume/set', wrap(async (req) => {
  const v = Math.round(Number(req.body?.volume));
  if (!Number.isFinite(v)) throw new Error('volume must be a number');
  return setVolumeLimited(await ensureConnected(), v);
}));
app.post('/api/volume/mute', wrap(async (req) => (await ensureConnected()).setMute(!!req.body.mute)));
app.get('/api/volume', wrap(async () => (await ensureConnected()).getVolume()));

app.post('/api/channel/up', wrap(async () => (await ensureConnected()).channelUp()));
app.post('/api/channel/down', wrap(async () => (await ensureConnected()).channelDown()));

app.post('/api/media/:action', wrap(async (req) => {
  const t = await ensureConnected();
  const map = { play: 'play', pause: 'pause', stop: 'stop', rewind: 'rewind', forward: 'fastForward' };
  const fn = map[req.params.action]; if (!fn) throw new Error('unknown action');
  return t[fn]();
}));

app.get('/api/apps', wrap(async () => {
  const t = await ensureConnected();
  const r = await t.listApps();
  const apps = (r.launchPoints || []).map((a) => ({ id: a.id, title: a.title, icon: a.largeIcon || a.icon })).sort((a, b) => a.title.localeCompare(b.title));
  return { apps };
}));
app.post('/api/launch', wrap(async (req) => (await ensureConnected()).launch(req.body.id, req.body.params)));
app.get('/api/foreground', wrap(async () => (await ensureConnected()).foregroundApp()));

// Send a link to the TV: YouTube links open in the YouTube app, everything else in the web browser.
function youTubeId(u) {
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    if (m) return m[1];
  }
  return null;
}
app.post('/api/cast', wrap(async (req) => {
  const raw = String(req.body?.url || '').trim();
  const found = raw.match(/https?:\/\/\S+/i)?.[0] || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw) ? `https://${raw}` : null);
  let u;
  try { u = new URL(found); } catch { throw new Error('Not a valid http(s) link'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links are supported');
  const t = await ensureConnected();
  const vid = youTubeId(u);
  if (vid && /^[\w-]{6,20}$/.test(vid)) { await t.playYouTube(vid); return { ok: true, opened: 'youtube', videoId: vid }; }
  await t.openUrl(u.href);
  return { ok: true, opened: 'browser', url: u.href };
}));

// Web Share Target: "Share → LG Remote" on Android opens /share?url=...&text=...
app.get('/share', (req, res) => {
  const text = [req.query.url, req.query.text, req.query.title].filter(Boolean).join(' ');
  res.redirect('/?share=' + encodeURIComponent(text));
});

app.get('/api/inputs', wrap(async () => {
  const r = await (await ensureConnected()).listInputs();
  return { inputs: (r.devices || []).map((d) => ({ id: d.id, label: d.label, icon: d.icon, connected: d.connected })) };
}));
app.post('/api/input', wrap(async (req) => (await ensureConnected()).switchInput(req.body.id)));

// Live screen. The TV needs ~0.5s per screenshot and handles one at a time, so
// while anyone is watching we capture back-to-back on the server and push each
// frame to every viewer over one long-lived MJPEG response (no per-frame round
// trips from the phone). Nobody watching = no captures.
const screen = { frame: null, at: 0, seq: 0, error: null, running: false, viewers: 0, lastPull: 0, waiters: [], times: [] };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const screenWanted = () => screen.viewers > 0 || Date.now() - screen.lastPull < 3000;
async function captureLoop() {
  if (screen.running) return;
  screen.running = true;
  while (screenWanted()) {
    try {
      const img = await (await ensureConnected()).screenshot();
      screen.frame = img; screen.at = Date.now(); screen.seq++; screen.error = null;
      screen.times.push(screen.at); screen.times = screen.times.filter((t) => screen.at - t < 5000);
    } catch (e) {
      screen.error = e.message;
      await pause(2000);
    }
    for (const wake of screen.waiters.splice(0)) wake();
  }
  screen.running = false;
}
const nextFrame = (afterSeq, timeoutMs = 8000) => new Promise((resolve) => {
  if (screen.seq > afterSeq) return resolve();
  const t = setTimeout(resolve, timeoutMs);
  screen.waiters.push(() => { clearTimeout(t); resolve(); });
});
const screenFps = () => (screen.times.length > 1 ? (screen.times.length - 1) / ((screen.times.at(-1) - screen.times[0]) / 1000) : 0);

// Single frame (used by scripts / fallback).
app.get('/api/screen', async (req, res) => {
  screen.lastPull = Date.now();
  if (!screen.frame || Date.now() - screen.at > 1000) { const seq = screen.seq; captureLoop(); await nextFrame(seq); }
  if (!screen.frame || Date.now() - screen.at > 10_000) return res.status(503).json({ ok: false, error: screen.error || 'no screen available' });
  res.set({ 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).send(screen.frame);
});

// Continuous stream: <img src="/api/screen/stream">
app.get('/api/screen/stream', async (req, res) => {
  res.writeHead(200, {
    'content-type': 'multipart/x-mixed-replace; boundary=frame',
    'cache-control': 'no-store, no-cache', pragma: 'no-cache', connection: 'keep-alive',
  });
  res.socket?.setNoDelay(true);
  let open = true;
  screen.viewers++;
  req.on('close', () => { if (open) { open = false; screen.viewers--; } });
  captureLoop();
  // Send the latest frame right away so the picture appears instantly.
  let sent = screen.seq;
  if (screen.frame && Date.now() - screen.at < 5000) writeFrame(res, screen.frame);
  while (open) {
    // Every pass waits for a newer frame (or the timeout), so this never spins.
    await nextFrame(sent);
    if (!open || screen.seq === sent) continue;
    sent = screen.seq;
    if (res.writableNeedDrain) continue; // slow phone: skip to the newest frame
    writeFrame(res, screen.frame);
  }
});
function writeFrame(res, img) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${img.length}\r\n\r\n`);
  res.write(img);
  res.write('\r\n');
}

// Is the foreground app playing or paused?
app.get('/api/playback', wrap(async () => {
  const r = await (await ensureConnected()).mediaState();
  const m = (r.foregroundAppInfo || [])[0] || {};
  return { ok: true, appId: m.appId || null, playState: m.playState || null, screenFps: Math.round(screenFps() * 10) / 10, screenError: screen.error };
}));

app.post('/api/text', wrap(async (req) => (await ensureConnected()).insertText(String(req.body.text || ''))));
app.post('/api/text/enter', wrap(async () => (await ensureConnected()).sendEnter()));
app.post('/api/text/delete', wrap(async (req) => (await ensureConnected()).deleteChars(Number(req.body.count || 1))));
app.post('/api/toast', wrap(async (req) => (await ensureConnected()).toast(String(req.body.message || ''))));

// What's on screen right now, with a friendly app name.
let appTitles = new Map();
async function refreshAppTitles(t, ids) {
  if (!ids.some((id) => id && !appTitles.has(id))) return;
  try {
    const r = await t.listApps();
    appTitles = new Map((r.launchPoints || []).map((a) => [a.id, a.title]));
  } catch {}
}
const SYSTEM_TITLES = { 'com.webos.app.home': 'Home screen', 'com.webos.app.livetv': 'Live TV', 'com.webos.app.browser': 'Web Browser' };
function appTitle(id) {
  if (!id) return null;
  if (appTitles.has(id)) return appTitles.get(id);
  if (SYSTEM_TITLES[id]) return SYSTEM_TITLES[id];
  const hdmi = id.match(/hdmi(\d)/i); if (hdmi) return `HDMI ${hdmi[1]}`;
  return id;
}
app.get('/api/now-playing', wrap(async () => {
  const t = await ensureConnected();
  const fg = await t.foregroundApp();
  const appId = fg?.appId || '';
  await refreshAppTitles(t, [appId]);
  return { ok: true, appId, title: appId ? appTitle(appId) : null };
}));

// Close the app in the foreground; if the TV refuses, fall back to Home.
app.post('/api/app/close', wrap(async (req) => {
  const t = await ensureConnected();
  const id = String(req.body?.id || (await t.foregroundApp())?.appId || '');
  if (!id) throw new Error('No app is open');
  try { await t.closeApp(id); return { ok: true, closed: id }; }
  catch { await t.sendButton('HOME'); return { ok: true, closed: null, wentHome: true }; }
}));

app.post('/api/power/off', wrap(async () => { const t = await ensureConnected(); await t.turnOff(); t.close(); }));
app.post('/api/power/screen', wrap(async (req) => { const t = await ensureConnected(); return req.body.on ? t.screenOn() : t.screenOff(); }));
async function wakeTV() {
  const mac = config.mac || (config.ip && await macFromArp(config.ip));
  if (!mac) throw new Error('TV MAC address unknown. Connect once while the TV is on, then Wake will work.');
  config.mac = mac; saveConfig();
  await wakeOnLan(mac);
  // Try to reconnect in the background as the TV boots.
  (async () => { for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 4000)); try { await ensureConnected(); return; } catch {} } })();
  return { ok: true, mac };
}
app.post('/api/power/on', wrap(wakeTV));

// ---------- Sleep timer ----------
const sleep = { at: null, timer: null, warnTimer: null };
function clearSleep() {
  clearTimeout(sleep.timer); clearTimeout(sleep.warnTimer);
  sleep.at = null; sleep.timer = null; sleep.warnTimer = null;
}
const sleepState = () => ({ at: sleep.at, remainingMs: sleep.at ? Math.max(0, sleep.at - Date.now()) : 0 });

app.get('/api/sleep', (req, res) => res.json(sleepState()));
app.post('/api/sleep', wrap(async (req) => setSleep(Number(req.body?.minutes))));
function setSleep(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 720) throw new Error('minutes must be between 0 and 720');
  clearSleep();
  if (minutes === 0) {
    ensureConnected().then((t) => t.toast('Sleep timer cancelled')).catch(() => {});
    return { ok: true, ...sleepState() };
  }
  const ms = Math.round(minutes * 60_000);
  sleep.at = Date.now() + ms;
  sleep.timer = setTimeout(async () => {
    clearSleep();
    console.log('[sleep] timer fired, turning TV off');
    try { const t = await ensureConnected(); await t.turnOff(); t.close(); }
    catch (e) { console.log('[sleep] turn off failed:', e.message); }
  }, ms);
  if (ms > 90_000) {
    sleep.warnTimer = setTimeout(() => {
      ensureConnected().then((t) => t.toast('TV will turn off in 1 minute (sleep timer)')).catch(() => {});
    }, ms - 60_000);
  }
  ensureConnected().then((t) => t.toast(`Sleep timer: TV will turn off in ${minutes} min`)).catch(() => {});
  return { ok: true, ...sleepState() };
}

// ---------- Volume limit ----------
// config.maxVolume (null = no limit). Enforced for this app and, through a
// volume subscription, for the TV's own remote too.
const hasLimit = () => Number.isInteger(config.maxVolume) && config.maxVolume < 100;
const volumeOf = (r) => { const v = r?.volumeStatus?.volume ?? r?.volume; return typeof v === 'number' ? v : null; };
let lastLimitToast = 0;
function enforceLimit(t, volume) {
  if (!hasLimit() || volume == null || volume <= config.maxVolume || !t.connected) return false;
  t.setVolume(config.maxVolume).catch(() => {});
  if (Date.now() - lastLimitToast > 10_000) {
    lastLimitToast = Date.now();
    t.toast(`Volume is limited to ${config.maxVolume}`).catch(() => {});
  }
  return true;
}
function watchVolume(t) {
  try { t.subscribe('ssap://audio/getVolume', {}, (p) => enforceLimit(t, volumeOf(p))); } catch {}
}
async function volumeUp(t) {
  if (hasLimit() && (volumeOf(await t.getVolume()) ?? 0) >= config.maxVolume) {
    throw new Error(`Volume is limited to ${config.maxVolume}`);
  }
  return t.volumeUp();
}
function setVolumeLimited(t, v) {
  const max = hasLimit() ? config.maxVolume : 100;
  return t.setVolume(Math.min(max, Math.max(0, Math.round(v))));
}
app.get('/api/volume-limit', (req, res) => res.json({ ok: true, max: hasLimit() ? config.maxVolume : null }));
app.post('/api/volume-limit', wrap(async (req) => {
  const raw = req.body?.max;
  const max = raw === null || raw === undefined || raw === 'off' ? null : Math.round(Number(raw));
  if (max !== null && (!Number.isFinite(max) || max < 1 || max > 100)) throw new Error('max must be 1-100, or null for no limit');
  config.maxVolume = max === 100 ? null : max;
  saveConfig();
  if (hasLimit() && tv?.connected) { try { enforceLimit(tv, volumeOf(await tv.getVolume())); } catch {} }
  return { ok: true, max: config.maxVolume };
}));

// ---------- Voice / text commands ----------
async function runCommand(text) {
  const c = parseCommand(text);
  if (!c) throw new Error('Say or type a command, e.g. "open Netflix" or "volume 20"');
  if (c.type === 'power' && c.on) { await wakeTV(); return 'Turning the TV on'; }
  if (c.type === 'sleep') { setSleep(c.minutes); return c.minutes ? `Sleep timer: ${c.minutes} min` : 'Sleep timer cancelled'; }
  const t = await ensureConnected();
  switch (c.type) {
    case 'volume': await setVolumeLimited(t, c.value); return `Volume ${hasLimit() ? Math.min(c.value, config.maxVolume) : Math.min(c.value, 100)}`;
    case 'volumeStep': {
      const steps = Math.min(Math.max(1, c.n), 50);
      for (let i = 0; i < steps; i++) await (c.dir === 'up' ? volumeUp(t) : t.volumeDown());
      return `Volume ${c.dir}${steps > 1 ? ` by ${steps}` : ''}`;
    }
    case 'mute': await t.setMute(c.on); return c.on ? 'Muted' : 'Unmuted';
    case 'power': await t.turnOff(); t.close(); return 'TV off';
    case 'screen': await (c.on ? t.screenOn() : t.screenOff()); return c.on ? 'Screen on' : 'Screen off';
    case 'media': {
      const fn = { play: 'play', pause: 'pause', stop: 'stop', rewind: 'rewind', forward: 'fastForward' }[c.action];
      await t[fn](); return c.action[0].toUpperCase() + c.action.slice(1);
    }
    case 'channel': await (c.dir === 'up' ? t.channelUp() : t.channelDown()); return `Channel ${c.dir}`;
    case 'channelNumber':
      for (const d of c.number) await t.sendButton(d);
      await t.sendButton('ENTER');
      return `Channel ${c.number}`;
    case 'button': {
      const times = Math.min(Math.max(1, c.n), 20);
      for (let i = 0; i < times; i++) { await t.sendButton(c.name); if (times > 1) await pause(150); }
      return c.name === 'ENTER' ? 'OK' : c.name[0] + c.name.slice(1).toLowerCase() + (times > 1 ? ` ×${times}` : '');
    }
    case 'type': await t.insertText(c.text); return `Typed "${c.text}"`;
    case 'input': case 'launch': case 'launchOrInput': {
      if (c.type !== 'input') {
        const apps = ((await t.listApps()).launchPoints || []).map((a) => ({ id: a.id, title: a.title }));
        const app = pick(apps, c.query, ['title', 'id']);
        if (app) { await t.launch(app.id); return `Opening ${app.title}`; }
      }
      const inputs = ((await t.listInputs()).devices || []).map((d) => ({ id: d.id, label: d.label }));
      const inp = pick(inputs, c.query, ['id', 'label']);
      if (inp) { await t.switchInput(inp.id); return `Switched to ${inp.label}`; }
      throw new Error(c.guess ? `Didn't understand "${text}"` : `No app or input called "${c.query}"`);
    }
  }
  throw new Error(`Didn't understand "${text}"`);
}
app.post('/api/command', wrap(async (req) => {
  const text = String(req.body?.text || '').slice(0, 200);
  return { ok: true, did: await runCommand(text) };
}));

// ---------- Schedules (turn the TV on/off at set times) ----------
// Times are in the server's local time zone (set TZ for Docker).
const pad2 = (x) => String(x).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const scheduleView = (s) => ({ id: s.id, time: s.time, action: s.action, days: s.days, enabled: s.enabled !== false });
function validDays(days) {
  if (!Array.isArray(days) || !days.length) return null;
  const out = [...new Set(days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  return out.length === new Set(days).size ? out : null;
}
async function runSchedule(s) {
  console.log(`[schedule] ${s.time} turn ${s.action}`);
  try {
    if (s.action === 'on') { await wakeTV(); return; }
    if (!tv?.connected) return; // already off (or unreachable): nothing to do
    await tv.turnOff(); tv.close();
  } catch (e) { console.log('[schedule] failed:', e.message); }
}
function scheduleTick() {
  const now = new Date();
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  for (const s of config.schedules) {
    if (s.enabled === false || s.time !== hhmm || !s.days.includes(now.getDay())) continue;
    const key = `${localDay(now)} ${hhmm}`;
    if (s.lastRun === key) continue;
    s.lastRun = key; saveConfig();
    runSchedule(s);
  }
}
setInterval(scheduleTick, 15_000);
app.get('/api/schedules', (req, res) => res.json({
  ok: true, schedules: config.schedules.map(scheduleView),
  serverTime: new Date().toTimeString().slice(0, 5), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}));
app.post('/api/schedules', wrap(async (req) => {
  const time = String(req.body?.time || '');
  const action = req.body?.action;
  const days = validDays(req.body?.days ?? [0, 1, 2, 3, 4, 5, 6]);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('time must be HH:MM (24-hour)');
  if (action !== 'on' && action !== 'off') throw new Error('action must be "on" or "off"');
  if (!days) throw new Error('days must be a list of 0-6 (0 = Sunday)');
  if (config.schedules.length >= 20) throw new Error('Too many schedules (max 20)');
  const s = { id: crypto.randomBytes(4).toString('hex'), time, action, days, enabled: true };
  config.schedules.push(s); saveConfig();
  return { ok: true, schedule: scheduleView(s) };
}));
app.patch('/api/schedules/:id', wrap(async (req) => {
  const s = config.schedules.find((x) => x.id === req.params.id);
  if (!s) throw new Error('No such schedule');
  if (typeof req.body?.enabled === 'boolean') s.enabled = req.body.enabled;
  saveConfig();
  return { ok: true, schedule: scheduleView(s) };
}));
app.delete('/api/schedules/:id', wrap(async (req) => {
  const before = config.schedules.length;
  config.schedules = config.schedules.filter((x) => x.id !== req.params.id);
  if (config.schedules.length === before) throw new Error('No such schedule');
  saveConfig();
}));

// ---------- Screen time ----------
// Every 30s while the TV is connected, credit the elapsed time to the app on
// screen. Stored per local day in usage.json next to config.json (35 days kept).
const USAGE = path.join(path.dirname(CONFIG), 'usage.json');
let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE, 'utf8')) || {}; } catch {}
let usageDirty = false, lastUsageTick = 0;
function saveUsage() {
  if (!usageDirty) return;
  const cutoff = localDay(new Date(Date.now() - 35 * 86_400_000));
  for (const day of Object.keys(usage)) if (day < cutoff) delete usage[day];
  try { fs.writeFileSync(USAGE, JSON.stringify(usage)); usageDirty = false; }
  catch (e) { console.log('[screen time] could not save', USAGE, '-', e.message); }
}
async function usageTick() {
  const now = Date.now(), prev = lastUsageTick;
  lastUsageTick = 0;
  if (!tv?.connected) return;
  let appId;
  try { appId = (await tv.foregroundApp())?.appId; } catch { return; }
  lastUsageTick = now;
  if (!appId || !prev) return;
  const day = localDay();
  usage[day] ||= {};
  usage[day][appId] = (usage[day][appId] || 0) + Math.min(60, Math.round((now - prev) / 1000));
  usageDirty = true;
}
setInterval(usageTick, 30_000);
setInterval(saveUsage, 120_000);
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { saveUsage(); process.exit(0); });
app.get('/api/screentime', wrap(async (req) => {
  const days = Math.min(30, Math.max(1, Math.round(Number(req.query.days) || 1)));
  const totals = {};
  for (let i = 0; i < days; i++) {
    for (const [id, sec] of Object.entries(usage[localDay(new Date(Date.now() - i * 86_400_000))] || {})) totals[id] = (totals[id] || 0) + sec;
  }
  if (tv?.connected) await refreshAppTitles(tv, Object.keys(totals));
  const apps = Object.entries(totals).map(([appId, sec]) => ({ appId, title: appTitle(appId), sec })).sort((a, b) => b.sec - a.sec);
  return { ok: true, days, totalSec: apps.reduce((n, a) => n + a.sec, 0), apps };
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\nLG TV Remote is running.');
  for (const ip of localIPs()) console.log(`  Phone / other devices:  http://${ip}:${PORT}`);
  console.log(`  This Mac:               http://localhost:${PORT}`);
  console.log(PIN ? '  PIN protection:         enabled\n' : '  PIN protection:         off (set REMOTE_PIN to enable)\n');
  if (config.ip) ensureConnected().catch((e) => console.log('[tv] initial connect failed:', e.message));
});
