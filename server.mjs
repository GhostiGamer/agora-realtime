// ÁGORA · servidor de tiempo real (WebSocket)
// Presencia y movimiento en la sala, chat de sala, carreras y señalización de llamadas de voz.
// Todo en memoria: si se reinicia, los navegadores vuelven a conectarse solos en unos segundos.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.RT_SECRET || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://agoraai.dev,https://www.agoraai.dev').split(',').map(s => s.trim()).filter(Boolean);
const MAX_CONN = Number(process.env.MAX_CONN || 1500);      // conexiones a la vez
const MAX_PER_IP = Number(process.env.MAX_PER_IP || 12);     // pestañas por IP
const RATE = 40, BURST = 80;                                 // mensajes por segundo por conexión
const MAX_STATE = 3000, MAX_HIST = 60, MAX_LOBBY = 250;
if (!SECRET) { console.error('Falta RT_SECRET (la misma clave que en Netlify).'); process.exit(1); }

const clients = new Set();          // conexiones
const byUid = new Map();            // uid -> Set(conexión)
const rooms = new Map();            // sala -> { members:Set, dirty, hist:[] }
const voice = new Map();            // grupo -> Set(conexión)
const perIp = new Map();
let lobbyDirty = false;

const now = () => Date.now();
const send = (c, m) => { if (c.ws.readyState === 1 && c.ws.bufferedAmount < 512 * 1024) c.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
const sizeOk = (o, max) => { try { return JSON.stringify(o ?? null).length <= max; } catch { return false; } };
const room = (name) => { let r = rooms.get(name); if (!r) { r = { members: new Set(), dirty: true, hist: [] }; rooms.set(name, r); } return r; };

// Billete firmado por Netlify: quién eres y en qué grupos estás
function verify(tk) {
  if (!tk || typeof tk.uid !== 'string' || !Array.isArray(tk.gids) || typeof tk.sig !== 'string') return null;
  const prids = Array.isArray(tk.prids) ? tk.prids : [];
  if (!(Number(tk.exp) > now())) return null;
  const want = crypto.createHmac('sha256', SECRET).update(`${tk.uid}|${tk.gids.join(',')}|${prids.join(',')}|${tk.exp}`).digest('hex');
  if (want.length !== tk.sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(tk.sig))) return null;
  return { uid: tk.uid.slice(0, 64), gids: new Set(tk.gids.map(Number)), prids: new Set(prids.map(Number)) };
}

// salas privadas (p-<id>): solo quien tenga la sala en su billete
const canRoom = (c, name) => !name.startsWith('p-') || (c.prids && c.prids.has(Number(name.slice(2))));
function leaveRoom(c) { if (!c.room) return; const r = rooms.get(c.room); if (r) { r.members.delete(c); r.dirty = true; } c.room = null; }
function leaveVoice(c) { if (!c.vgid) return; const v = voice.get(c.vgid); if (v) { v.delete(c); if (!v.size) voice.delete(c.vgid); else voiceMembers(c.vgid); } c.vgid = null; }
function voiceMembers(gid) { const v = voice.get(gid); if (!v) return; const members = [...new Set([...v].map(x => x.uid))]; for (const x of v) send(x, { t: 'vmem', gid, members }); }

function onMessage(c, raw) {
  // límite de mensajes por conexión
  const t = now(); c.tokens = Math.min(BURST, c.tokens + (t - c.last) * RATE / 1000); c.last = t;
  if (c.tokens < 1) { if (++c.dropped > 400) c.ws.close(1008, 'demasiados mensajes'); return; }
  c.tokens -= 1;
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (!c.uid) {
    if (m.t !== 'hello') return;
    const who = verify(m.tk); if (!who) return c.ws.close(4001, 'billete no válido');
    c.uid = who.uid; c.gids = who.gids; c.prids = who.prids;
    if (!byUid.has(c.uid)) byUid.set(c.uid, new Set()); byUid.get(c.uid).add(c);
    send(c, { t: 'ok' }); return;
  }
  switch (m.t) {
    case 'tk': { const who = verify(m.tk); if (who && who.uid === c.uid) { c.gids = who.gids; c.prids = who.prids; } break; }
    case 'st': {   // estado en la portada y en la sala
      if (!sizeOk(m.lobby, MAX_STATE) || !sizeOk(m.state, MAX_STATE)) return;
      c.lobby = m.lobby || {}; lobbyDirty = true;
      let want = typeof m.room === 'string' ? m.room.slice(0, 40) : null;
      if (want && !canRoom(c, want)) want = null;
      if (want !== c.room) { leaveRoom(c); if (want) { c.room = want; room(want).members.add(c); } }
      c.state = want ? (m.state || {}) : null; if (c.room) room(c.room).dirty = true;
      break;
    }
    case 'hist': { if (!canRoom(c, String(m.room || ''))) return; const r = rooms.get(String(m.room || '')); send(c, { t: 'hist', room: m.room, list: r ? r.hist : [] }); break; }
    case 'chat': {
      const name = String(m.room || '').slice(0, 40), text = String(m.text || '').trim().slice(0, 300);
      if (!name || !text || name.startsWith('g-') || !canRoom(c, name)) return;
      if (t - (c.lastChat || 0) < 1200) return; c.lastChat = t;
      const msg = { uid: c.uid, ts: t, t: text, nick: String(m.nick || '').slice(0, 16), c: String(m.c || '').slice(0, 9) };
      const r = room(name); r.hist.push(msg); if (r.hist.length > MAX_HIST) r.hist.shift();
      for (const x of r.members) send(x, { t: 'chat', room: name, m: msg });
      if (c.room !== name) send(c, { t: 'chat', room: name, m: msg });
      break;
    }
    case 'vjoin': {
      const gid = Number(m.gid); if (!c.gids.has(gid)) return send(c, { t: 'verr', gid });
      leaveVoice(c); const was = voice.has(gid) ? [...voice.get(gid)].some(x => x.uid !== c.uid) : false;
      c.vgid = gid; if (!voice.has(gid)) voice.set(gid, new Set()); voice.get(gid).add(c); voiceMembers(gid);
      // primera persona en la llamada: avisa al resto del grupo que esté conectado
      if (!was) { const nick = String(m.nick || '').slice(0, 16); for (const x of clients) if (x !== c && x.uid !== c.uid && x.gids && x.gids.has(gid) && x.vgid !== gid) send(x, { t: 'ring', gid, from: c.uid, nick }); }
      break;
    }
    case 'vleave': leaveVoice(c); break;
    case 'vsig': {
      if (!c.vgid || !sizeOk(m.data, 60000)) return;
      const v = voice.get(c.vgid); if (!v) return;
      for (const x of v) if (x.uid === String(m.to)) send(x, { t: 'vsig', from: c.uid, data: m.data });
      break;
    }
  }
}

// envíos agrupados: la sala 10 veces por segundo, la portada cada 3 segundos
setInterval(() => {
  for (const [name, r] of rooms) {
    if (!r.members.size) { if (!r.hist.length || r.idle > 600) rooms.delete(name); else r.idle = (r.idle || 0) + 1; continue; }
    r.idle = 0; if (!r.dirty) continue; r.dirty = false;
    const seen = new Map(); for (const x of r.members) if (x.uid && x.state) seen.set(x.uid, x.state);
    const msg = JSON.stringify({ t: 'room', room: name, list: [...seen].map(([uid, state]) => ({ uid, state })) });
    for (const x of r.members) send(x, msg);
  }
}, 100);
setInterval(() => {
  if (!lobbyDirty) return; lobbyDirty = false;
  const seen = new Map(); for (const c of clients) if (c.uid) seen.set(c.uid, { uid: c.uid, lobby: c.lobby || {}, room: c.room });
  const list = [...seen.values()].slice(-MAX_LOBBY), msg = JSON.stringify({ t: 'lobby', list, total: seen.size });
  for (const c of clients) if (c.uid) send(c, msg);
}, 3000);

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, conns: clients.size, rooms: rooms.size, calls: voice.size, mem: Math.round(process.memoryUsage().rss / 1048576) + ' MB' })); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '', ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const okOrigin = ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+--?[a-z0-9-]*\.netlify\.app$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  if (!okOrigin || clients.size >= MAX_CONN || (perIp.get(ip) || 0) >= MAX_PER_IP) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { ws, ip, uid: null, gids: new Set(), prids: new Set(), lobby: {}, room: null, state: null, vgid: null, tokens: BURST, last: now(), dropped: 0, alive: true };
    clients.add(c); perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const hello = setTimeout(() => { if (!c.uid) ws.close(4000, 'sin saludo'); }, 10000);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (d) => onMessage(c, d));
    ws.on('close', () => {
      clearTimeout(hello); clients.delete(c); leaveRoom(c); leaveVoice(c); lobbyDirty = true;
      const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      if (c.uid) { const s = byUid.get(c.uid); if (s) { s.delete(c); if (!s.size) byUid.delete(c.uid); } }
    });
  });
});
// conexiones muertas fuera cada 25 s
setInterval(() => { for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch { /* nada */ } } }, 25000);
server.listen(PORT, () => console.log(`ÁGORA tiempo real en :${PORT}`));
const bye = () => { for (const c of clients) c.ws.close(1012, 'reinicio'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
