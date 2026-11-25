import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LGTV, discover, localIPs, macFromArp, macOf, wakeOnLan } from './lgtv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(__dirname, 'config.json');
const PORT = Number(process.env.PORT || 8080);
const PIN = (process.env.REMOTE_PIN || '').trim();

let config = { ip: null, clientKey: null, mac: null, name: null };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
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
app.post('/api/forget', wrap(async () => { tv?.close(); tv = null; config = { ip: null, clientKey: null, mac: null, name: null }; saveConfig(); }));

// Remote-control style buttons go through the pointer socket (UP/DOWN/ENTER/BACK/HOME/...)
app.post('/api/button/:name', wrap(async (req) => { const t = await ensureConnected(); await t.sendButton(req.params.name.toUpperCase()); }));

app.post('/api/pointer/move', wrap(async (req) => { const t = await ensureConnected(); await t.pointerMove(req.body.dx || 0, req.body.dy || 0, !!req.body.down); }));
app.post('/api/pointer/click', wrap(async () => { const t = await ensureConnected(); await t.pointerClick(); }));
app.post('/api/pointer/scroll', wrap(async (req) => { const t = await ensureConnected(); await t.pointerScroll(req.body.dx || 0, req.body.dy || 0); }));

app.post('/api/volume/up', wrap(async () => (await ensureConnected()).volumeUp()));
app.post('/api/volume/down', wrap(async () => (await ensureConnected()).volumeDown()));
app.post('/api/volume/set', wrap(async (req) => {
  const v = Math.round(Number(req.body?.volume));
  if (!Number.isFinite(v)) throw new Error('volume must be a number');
  return (await ensureConnected()).setVolume(Math.min(100, Math.max(0, v)));
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

app.post('/api/text', wrap(async (req) => (await ensureConnected()).insertText(String(req.body.text || ''))));
app.post('/api/text/enter', wrap(async () => (await ensureConnected()).sendEnter()));
app.post('/api/text/delete', wrap(async (req) => (await ensureConnected()).deleteChars(Number(req.body.count || 1))));
app.post('/api/toast', wrap(async (req) => (await ensureConnected()).toast(String(req.body.message || ''))));

// What's on screen right now, with a friendly app name.
let appTitles = new Map();
app.get('/api/now-playing', wrap(async () => {
  const t = await ensureConnected();
  const fg = await t.foregroundApp();
  const appId = fg?.appId || '';
  if (appId && !appTitles.has(appId)) {
    try {
      const r = await t.listApps();
      appTitles = new Map((r.launchPoints || []).map((a) => [a.id, a.title]));
    } catch {}
  }
  return { ok: true, appId, title: appTitles.get(appId) || appId || null };
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
app.post('/api/power/on', wrap(async () => {
  const mac = config.mac || (config.ip && await macFromArp(config.ip));
  if (!mac) throw new Error('TV MAC address unknown. Connect once while the TV is on, then Wake will work.');
  config.mac = mac; saveConfig();
  await wakeOnLan(mac);
  // Try to reconnect in the background as the TV boots.
  (async () => { for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 4000)); try { await ensureConnected(); return; } catch {} } })();
  return { ok: true, mac };
}));

// ---------- Sleep timer ----------
const sleep = { at: null, timer: null, warnTimer: null };
function clearSleep() {
  clearTimeout(sleep.timer); clearTimeout(sleep.warnTimer);
  sleep.at = null; sleep.timer = null; sleep.warnTimer = null;
}
const sleepState = () => ({ at: sleep.at, remainingMs: sleep.at ? Math.max(0, sleep.at - Date.now()) : 0 });

app.get('/api/sleep', (req, res) => res.json(sleepState()));
app.post('/api/sleep', wrap(async (req) => {
  const minutes = Number(req.body?.minutes);
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
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\nLG TV Remote is running.');
  for (const ip of localIPs()) console.log(`  Phone / other devices:  http://${ip}:${PORT}`);
  console.log(`  This Mac:               http://localhost:${PORT}`);
  console.log(PIN ? '  PIN protection:         enabled\n' : '  PIN protection:         off (set REMOTE_PIN to enable)\n');
  if (config.ip) ensureConnected().catch((e) => console.log('[tv] initial connect failed:', e.message));
});
