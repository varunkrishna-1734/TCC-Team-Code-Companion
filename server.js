'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const AUTH_USER = process.env.BASIC_AUTH_USER || '';
const AUTH_PASS = process.env.BASIC_AUTH_PASS || '';
const MAX_BODY = '5mb';
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 300;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- validation / sanitising ---------- */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEVS = new Set(['high', 'medium', 'low']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function countMap(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const k of Object.keys(v).slice(0, 500)) {
    if (BAD_KEYS.has(k)) continue;
    out[k.slice(0, 100)] = int(v[k]);
  }
  return out;
}

function sanitize(input) {
  if (!isObj(input)) throw new Error('State must be a JSON object.');
  const S = {
    reviews: [], muted: [], accepted: countMap(input.accepted),
    rejected: countMap(input.rejected), seen: countMap(input.seen), custom: [], log: []
  };
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

  S.muted = arr(input.muted, 200).filter(x => typeof x === 'string').map(x => x.slice(0, 100));

  S.custom = arr(input.custom, 100).filter(isObj).map(c => ({
    id: str(c.id, 60), name: str(c.name, 120), pattern: str(c.pattern, 500),
    msg: str(c.msg, 500), sev: SEVS.has(c.sev) ? c.sev : 'medium'
  })).filter(c => {
    if (!c.id || !c.name || !c.pattern) return false;
    try { new RegExp(c.pattern); return true; } catch { return false; }
  });

  S.log = arr(input.log, 40).filter(isObj).map(l => ({
    t: l.t === 'r' ? 'r' : 'a', rid: str(l.rid, 100), text: str(l.text, 1000), d: str(l.d, 40)
  }));

  S.reviews = arr(input.reviews, 30).filter(isObj).map(r => ({
    id: str(r.id, 60), date: str(r.date, 40), lang: str(r.lang, 30),
    code: str(r.code, 200000), skipped: int(r.skipped),
    fs: arr(r.fs, 2000).filter(isObj).map(f => ({
      rid: str(f.rid, 100), line: int(f.line), text: str(f.text, 2000), prior: int(f.prior),
      status: ['open', 'accepted', 'rejected'].includes(f.status) ? f.status : 'open'
    }))
  })).filter(r => r.id && r.date);
  return S;
}

/* ---------- persistence (atomic writes, serialised) ---------- */
let state = null;
let rev = 0;
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state = sanitize(raw.state);
  rev = int(raw.rev);
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('Could not read existing state, starting empty:', e.message);
}

let writeChain = Promise.resolve();
function persist() {
  const payload = JSON.stringify({ rev, state });
  writeChain = writeChain.then(async () => {
    const tmp = DATA_FILE + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, payload);
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch(err => console.error('Persist failed:', err));
  return writeChain;
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  next();
});

// health check stays public (for hosting platforms)
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// optional HTTP Basic auth
if (AUTH_USER && AUTH_PASS) {
  const sha = s => crypto.createHash('sha256').update(s).digest();
  const wantU = sha(AUTH_USER), wantP = sha(AUTH_PASS);
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0) {
        const okU = crypto.timingSafeEqual(sha(decoded.slice(0, i)), wantU);
        const okP = crypto.timingSafeEqual(sha(decoded.slice(i + 1)), wantP);
        if (okU && okP) return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="TCC", charset="UTF-8"').status(401).send('Authentication required');
  });
}

// tiny in-memory rate limiter for the API
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();
app.use('/api', (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > RATE_LIMIT) return res.status(429).json({ error: 'Too many requests. Slow down.' });
  next();
});

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/state', (req, res) => {
  res.json(state ? { exists: true, rev, state } : { exists: false, rev, state: null });
});

app.put('/api/state', express.json({ limit: MAX_BODY }), async (req, res) => {
  let clean;
  try { clean = sanitize(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  state = clean;
  rev += 1;
  await persist();
  res.json({ ok: true, rev });
});

app.delete('/api/state', async (req, res) => {
  state = null;
  rev += 1;
  await persist();
  res.json({ ok: true, rev });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// error handler (bad JSON, oversized body, ...)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api')) {
    return res.status(status).json({ error: status === 413 ? 'Payload too large.' : status < 500 ? 'Bad request.' : 'Server error.' });
  }
  res.status(status).send('Error');
});

const server = app.listen(PORT, () => console.log(`TCC running on http://localhost:${PORT} (data: ${DATA_FILE})`));

function shutdown() {
  server.close(() => writeChain.finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
