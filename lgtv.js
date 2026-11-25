// Minimal LG webOS "SSAP" client: pairing, requests, pointer/button socket,
// SSDP + port-scan discovery and Wake-on-LAN. No external deps besides `ws`.
import WebSocket from 'ws';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.1',
  signed: {
    created: '20140509',
    appId: 'com.lge.test',
    vendorId: 'com.lge',
    localizedAppNames: { '': 'LG Remote App', 'ko-KR': '리모컨 앱', 'zxx-XX': 'ЛГ Rэмotэ AПП' },
    localizedVendorNames: { '': 'LG Electronics' },
    permissions: ['TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO', 'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME'],
    serial: '2f930e2d2cfe083771f68e4fe7bb07',
  },
  permissions: ['LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO', 'READ_SETTINGS', 'CONTROL_TV_SCREEN', 'CONTROL_TV_STANBY', 'CONTROL_FAVORITE_GROUP', 'CONTROL_USER_INFO', 'CHECK_BLUETOOTH_DEVICE', 'CONTROL_BLUETOOTH', 'CONTROL_TIMER_INFO', 'STB_INTERNAL_CONNECTION', 'CONTROL_RECORDING', 'READ_RECORDING_STATE', 'WRITE_RECORDING_LIST', 'READ_RECORDING_LIST', 'READ_RECORDING_SCHEDULE', 'WRITE_RECORDING_SCHEDULE', 'READ_STORAGE_DEVICE_LIST', 'READ_TV_PROGRAM_INFO', 'CONTROL_BOX_CHANNEL', 'READ_TV_ACR_AUTH_TOKEN', 'READ_TV_CONTENT_STATE', 'READ_TV_CURRENT_TIME', 'ADD_LAUNCHER_CHANNEL', 'SET_CHANNEL_SKIP', 'RELEASE_CHANNEL_SKIP', 'CONTROL_CHANNEL_BLOCK', 'DELETE_SELECT_CHANNEL', 'CONTROL_CHANNEL_GROUP', 'SCAN_TV_CHANNELS', 'CONTROL_TV_POWER', 'CONTROL_WOL'],
  signatures: [{ signatureVersion: 1, signature: 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==' }],
};

// Newer LG firmware (2025+) rejects the well-known signature above with
// "403 Pairing rejected: blacklisted certificate detected". In that case we
// register again without the signed block. The permissions that used to come
// from the signed block (pointer/button socket, app list, ...) must then be
// requested in the top-level list instead.
const UNSIGNED_MANIFEST = {
  manifestVersion: MANIFEST.manifestVersion,
  appVersion: '1.0',
  permissions: [...new Set([...MANIFEST.signed.permissions, ...MANIFEST.permissions])],
};
const BLACKLISTED = /blacklisted certificate/i;

export class LGTV extends EventEmitter {
  constructor({ ip, clientKey = null }) {
    super();
    this.ip = ip;
    this.clientKey = clientKey;
    this.ws = null;
    this.pointer = null;
    this.state = 'disconnected'; // disconnected | connecting | pairing | connected
    this.nextId = 1;
    this.pending = new Map();
    this.subs = new Map();
    this.lastError = null;
    this.unsigned = false; // switched on after the TV rejects the signed manifest
  }

  async connect() {
    if (this.ws) this.close();
    this.state = 'connecting';
    this.lastError = null;
    this.emit('state', this.state);
    // 2022+ TVs use TLS on 3001; older use plain ws on 3000. Try both.
    const attempts = [`wss://${this.ip}:3001`, `ws://${this.ip}:3000`];
    let lastErr;
    for (const url of attempts) {
      try {
        await this._open(url);
        this.url = url;
        return;
      } catch (e) {
        // Keep the most useful error: an answer from the TV itself (e.g. pairing
        // rejected) beats a plain socket error from the fallback port.
        if (!lastErr || !lastErr.fromTV) lastErr = e;
        if (e.fromTV) break;
      }
    }
    this.state = 'disconnected';
    this.lastError = lastErr?.message || 'connect failed';
    this.emit('state', this.state);
    throw lastErr;
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } try { ws.terminate(); } catch {} };
      ws.on('error', fail);
      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
          this.state = 'disconnected';
          this.emit('state', this.state);
          for (const p of this.pending.values()) p.reject(new Error('socket closed'));
          this.pending.clear();
          if (this.pointer) { try { this.pointer.terminate(); } catch {} this.pointer = null; }
        }
        fail(new Error('closed'));
      });
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id === 'register_0') {
          if (msg.type === 'registered') {
            this.clientKey = msg.payload['client-key'];
            this.state = 'connected';
            this.emit('state', this.state);
            this.emit('key', this.clientKey);
            settled = true; resolve();
          } else if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
            this.state = 'pairing';
            this.emit('state', this.state);
          } else if (msg.type === 'error') {
            if (!this.unsigned && BLACKLISTED.test(msg.error || '')) {
              // TV refuses the legacy signature: retry on the same socket without it.
              this.unsigned = true;
              sendRegister();
              return;
            }
            this.lastError = msg.error;
            const err = new Error(msg.error || 'pairing rejected');
            err.fromTV = true;
            fail(err);
          }
          return;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.type === 'error') p.reject(new Error(msg.error || 'error')); else p.resolve(msg.payload);
        }
        const s = this.subs.get(msg.id);
        if (s) s(msg.payload);
      });
      const sendRegister = () => ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload: { forcePairing: false, pairingType: 'PROMPT', manifest: this.unsigned ? UNSIGNED_MANIFEST : MANIFEST, 'client-key': this.clientKey || undefined } }));
      ws.on('open', () => {
        this.ws = ws;
        sendRegister();
        // Pairing prompt on TV waits for user; allow up to 60s.
        setTimeout(() => fail(new Error('pairing timed out')), 60000);
      });
    });
  }

  close() {
    if (this.pointer) { try { this.pointer.terminate(); } catch {} this.pointer = null; }
    if (this.ws) { const w = this.ws; this.ws = null; try { w.terminate(); } catch {} }
    this.state = 'disconnected';
    this.emit('state', this.state);
  }

  get connected() { return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN; }

  request(uri, payload = {}) {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    const id = `req_${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'request', id, uri, payload }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout')); }, 8000);
    });
  }

  subscribe(uri, payload, cb) {
    if (!this.connected) return;
    const id = `sub_${this.nextId++}`;
    this.subs.set(id, cb);
    this.ws.send(JSON.stringify({ type: 'subscribe', id, uri, payload }));
    return id;
  }

  async getPointer() {
    if (this.pointer?.readyState === WebSocket.OPEN) return this.pointer;
    if (this._pointerPromise) return this._pointerPromise;
    this._pointerPromise = (async () => {
      const { socketPath } = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
      const p = new WebSocket(socketPath, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      await new Promise((res, rej) => { p.once('open', res); p.once('error', rej); });
      p.on('close', () => { if (this.pointer === p) this.pointer = null; });
      p.on('error', () => {});
      this.pointer = p;
      return p;
    })();
    try { return await this._pointerPromise; } finally { this._pointerPromise = null; }
  }

  async sendButton(name) {
    const p = await this.getPointer();
    p.send(`type:button\nname:${name}\n\n`);
  }
  async pointerMove(dx, dy, down = false) {
    const p = await this.getPointer();
    p.send(`type:move\ndx:${Math.round(dx)}\ndy:${Math.round(dy)}\ndown:${down ? 1 : 0}\n\n`);
  }
  async pointerClick() { const p = await this.getPointer(); p.send('type:click\n\n'); }
  async pointerScroll(dx, dy) { const p = await this.getPointer(); p.send(`type:scroll\ndx:${Math.round(dx)}\ndy:${Math.round(dy)}\n\n`); }

  // Convenience wrappers
  volumeUp() { return this.request('ssap://audio/volumeUp'); }
  volumeDown() { return this.request('ssap://audio/volumeDown'); }
  getVolume() { return this.request('ssap://audio/getVolume'); }
  setVolume(volume) { return this.request('ssap://audio/setVolume', { volume }); }
  setMute(mute) { return this.request('ssap://audio/setMute', { mute }); }
  turnOff() { return this.request('ssap://system/turnOff'); }
  channelUp() { return this.request('ssap://tv/channelUp'); }
  channelDown() { return this.request('ssap://tv/channelDown'); }
  play() { return this.request('ssap://media.controls/play'); }
  pause() { return this.request('ssap://media.controls/pause'); }
  stop() { return this.request('ssap://media.controls/stop'); }
  rewind() { return this.request('ssap://media.controls/rewind'); }
  fastForward() { return this.request('ssap://media.controls/fastForward'); }
  listApps() { return this.request('ssap://com.webos.applicationManager/listLaunchPoints'); }
  launch(id, params) { return this.request('ssap://system.launcher/launch', { id, ...(params ? { params } : {}) }); }
  closeApp(id) { return this.request('ssap://system.launcher/close', { id }); }
  foregroundApp() { return this.request('ssap://com.webos.applicationManager/getForegroundAppInfo'); }
  toast(message) { return this.request('ssap://system.notifications/createToast', { message }); }
  listInputs() { return this.request('ssap://tv/getExternalInputList'); }
  switchInput(inputId) { return this.request('ssap://tv/switchInput', { inputId }); }
  insertText(text) { return this.request('ssap://com.webos.service.ime/insertText', { text, replace: 0 }); }
  sendEnter() { return this.request('ssap://com.webos.service.ime/sendEnterKey'); }
  deleteChars(count = 1) { return this.request('ssap://com.webos.service.ime/deleteCharacters', { count }); }
  systemInfo() { return this.request('ssap://system/getSystemInfo'); }
  connectionInfo() { return this.request('ssap://com.webos.service.connectionmanager/getinfo'); }
  screenOff() { return this.request('ssap://com.webos.service.tvpower/power/turnOffScreen', { standbyMode: 'active' }); }
  screenOn() { return this.request('ssap://com.webos.service.tvpower/power/turnOnScreen', { standbyMode: 'active' }); }
}

// ---------- Discovery ----------
export function ssdpDiscover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:lge-com:service:webos-second-screen:1\r\n\r\n');
    sock.on('message', (buf, rinfo) => {
      const txt = buf.toString();
      if (/webos|LG/i.test(txt)) {
        const name = (txt.match(/DLNADeviceName\.lge\.com:\s*(.+)/i)?.[1] || '').trim();
        found.set(rinfo.address, { ip: rinfo.address, name: decodeURIComponent(name || 'LG TV'), via: 'ssdp' });
      }
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      for (let i = 0; i < 3; i++) setTimeout(() => { try { sock.send(msg, 1900, '239.255.255.250'); } catch {} }, i * 400);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
  });
}

function localSubnets() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list) {
    if (n.family === 'IPv4' && !n.internal) out.push(n.address.split('.').slice(0, 3).join('.'));
  }
  return [...new Set(out)];
}

function portOpen(ip, port, ms = 700) {
  return new Promise((res) => {
    const s = net.createConnection({ host: ip, port });
    const done = (v) => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function scanDiscover() {
  const mine = new Set(Object.values(os.networkInterfaces()).flat().map((n) => n.address));
  const found = [];
  for (const sub of localSubnets()) {
    const jobs = [];
    for (let i = 1; i < 255; i++) {
      const ip = `${sub}.${i}`;
      if (mine.has(ip)) continue;
      jobs.push((async () => { if (await portOpen(ip, 3001) || await portOpen(ip, 3000)) found.push({ ip, name: 'LG TV (port scan)', via: 'scan' }); })());
    }
    await Promise.all(jobs);
  }
  return found;
}

export async function discover() {
  const ssdp = await ssdpDiscover();
  if (ssdp.length) return ssdp;
  return scanDiscover();
}

export function localIPs() {
  return Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address);
}

// ---------- Wake on LAN ----------
export function macFromArp(ip) {
  return new Promise((resolve) => {
    execFile('arp', ['-n', ip], (err, stdout) => {
      const m = stdout?.match(/(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})/i);
      resolve(m ? m[1].split(':').map((h) => h.padStart(2, '0')).join(':') : null);
    });
  });
}

export function wakeOnLan(mac) {
  const clean = mac.replace(/[^0-9a-f]/gi, '');
  if (clean.length !== 12) return Promise.reject(new Error('bad MAC'));
  const macBuf = Buffer.from(clean, 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuf)]);
  const targets = ['255.255.255.255', ...localSubnets().map((s) => `${s}.255`)];
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      let left = targets.length * 2;
      for (const t of targets) for (const port of [9, 7]) sock.send(packet, port, t, () => { if (--left === 0) { sock.close(); resolve(); } });
    });
  });
}
