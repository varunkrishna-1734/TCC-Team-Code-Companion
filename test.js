'use strict';
// Smoke test: node test.js  (starts its own server on a temp port + temp data dir)
const os = require('os'), fs = require('fs'), path = require('path');
process.env.PORT = '3199';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-'));
const { server } = require('./server');
const base = 'http://localhost:3199';
const assert = require('assert');
(async () => {
  let r = await (await fetch(base + '/api/health')).json(); assert(r.ok);
  r = await (await fetch(base + '/api/state')).json(); assert.strictEqual(r.exists, false);
  const body = { reviews: [], muted: ['var'], accepted: { var: 2, __proto__: 5 }, rejected: {}, seen: {},
    custom: [{ id: 'c1', name: 'x', pattern: 'a+', msg: 'm', sev: 'high' }, { id: 'c2', name: 'bad', pattern: '(', msg: 'm', sev: 'low' }], log: [] };
  let p = await fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual(p.status, 200);
  r = await (await fetch(base + '/api/state')).json();
  assert(r.exists); assert.strictEqual(r.state.custom.length, 1); assert.strictEqual(r.state.accepted.var, 2);
  p = await fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.strictEqual(p.status, 400);
  p = await fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  assert.strictEqual(p.status, 400);
  assert.strictEqual((await fetch(base + '/')).status, 200);
  assert.strictEqual((await fetch(base + '/api/nope')).status, 404);
  await fetch(base + '/api/state', { method: 'DELETE' });
  r = await (await fetch(base + '/api/state')).json(); assert.strictEqual(r.exists, false);
  console.log('All tests passed'); server.close(); setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
