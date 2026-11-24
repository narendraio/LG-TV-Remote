import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LGTV, discover, localIPs, macFromArp, wakeOnLan } from './lgtv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, 'config.json');
const PORT = Number(process.env.PORT || 8080);

let config = { ip: null, clientKey: null, mac: null, name: null };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
const saveConfig = () => fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));

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

async function ensureConnected() {
  if (tv?.connected) return tv;
  if (!config.ip) throw new Error('No TV configured. Open Settings and pick your TV.');
  if (!connecting) connecting = connectTo(config.ip).finally(() => { connecting = null; });
  return connecting;
}

const app = express();
app.use(express.json());
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
app.post('/api/volume/set', wrap(async (req) => (await ensureConnected()).setVolume(Number(req.body.volume))));
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

app.listen(PORT, '0.0.0.0', () => {
  console.log('\nLG TV Remote is running.');
  for (const ip of localIPs()) console.log(`  Phone / other devices:  http://${ip}:${PORT}`);
  console.log(`  This Mac:               http://localhost:${PORT}\n`);
  if (config.ip) ensureConnected().catch((e) => console.log('[tv] initial connect failed:', e.message));
});
