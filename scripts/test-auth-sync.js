// Tests for the staff passcode, the Google Sheets backup queue, and restore (import).
// Runs a throwaway server with a temp DB and a fake "Apps Script" endpoint on localhost.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PASSCODE = 'test-pass-123';
const dir = mkdtempSync(path.join(os.tmpdir(), 'wataame-auth-'));

// --- Fake Apps Script web app ------------------------------------------------
let sheetsUp = true;
const received = [];
const fake = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (!sheetsUp) {
    res.writeHead(503);
    return res.end('down');
  }
  const body = JSON.parse(raw);
  if (body.secret !== 'sheet-secret') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'bad_secret' }));
  }
  received.push(...body.items);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((r) => fake.listen(3997, r));

function startServer(port, dbName) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: {
      ...process.env, PORT: String(port), DB_PATH: path.join(dir, dbName), STAFF_PASSCODE: PASSCODE,
      SHEETS_WEBHOOK_URL: 'http://localhost:3997/exec', SHEETS_SECRET: 'sheet-secret',
      SHEETS_VIEW_URL: 'https://docs.google.com/spreadsheets/d/test-sheet/edit',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve(proc)));
}

const A = 'http://localhost:3996';
const server = await startServer(3996, 'a.db');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await wait(200);
  }
  return false;
}

let cookie = '';
const req = (base, p, { method = 'GET', body, headers = {}, auth = true } = {}) =>
  fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body && JSON.stringify(body),
  });

let failed = false;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

let spareServer;
try {
  await test('staff pages redirect to /login without the passcode', async () => {
    for (const p of ['/', '/server', '/cook', '/carrier', '/admin']) {
      const r = await req(A, p, { auth: false });
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.get('location'), `/login?next=${encodeURIComponent(p)}`);
    }
  });

  await test('customer display and its live feed stay public', async () => {
    assert.equal((await req(A, '/display', { auth: false })).status, 200);
    const ctrl = new AbortController();
    const r = await fetch(`${A}/api/events?role=display`, { signal: ctrl.signal });
    assert.equal(r.status, 200);
    ctrl.abort();
  });

  await test('API refuses changes without the passcode', async () => {
    const r = await req(A, '/api/orders', { method: 'POST', body: { product: 'A' }, auth: false });
    assert.equal(r.status, 401);
    assert.equal((await req(A, '/api/export.csv', { auth: false })).status, 401);
  });

  await test('wrong passcode is rejected', async () => {
    const r = await req(A, '/api/login', { method: 'POST', body: { passcode: 'nope' }, auth: false });
    assert.equal(r.status, 401);
  });

  await test('right passcode sets a long-lived HttpOnly cookie that unlocks the API', async () => {
    const r = await req(A, '/api/login', { method: 'POST', body: { passcode: PASSCODE }, auth: false });
    assert.equal(r.status, 200);
    const set = r.headers.get('set-cookie');
    assert.match(set, /HttpOnly/);
    assert.match(set, /Max-Age=1209600/);
    cookie = set.split(';')[0];
    const o = await req(A, '/api/orders', { method: 'POST', body: { product: 'A', device: 't' } });
    assert.equal(o.status, 201);
    assert.equal((await req(A, '/server')).status, 200);
  });

  await test('spreadsheet link is only given to signed-in staff, never in the public feed', async () => {
    assert.equal((await req(A, '/api/backup-info', { auth: false })).status, 401);
    const info = await (await req(A, '/api/backup-info')).json();
    assert.equal(info.sheetUrl, 'https://docs.google.com/spreadsheets/d/test-sheet/edit');
    const ctrl = new AbortController();
    const r = await fetch(`${A}/api/events?role=display`, { signal: ctrl.signal });
    const reader = r.body.getReader();
    let feed = '';
    while (!feed.includes('event: state')) feed += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    assert.ok(!feed.includes('test-sheet'), 'sheet URL leaked into the public live feed');
  });

  await test('scripts can use the X-Passcode header', async () => {
    const r = await req(A, '/api/state', { headers: { 'X-Passcode': PASSCODE }, auth: false });
    assert.equal(r.status, 200);
  });

  await test('every change reaches the sheet (with the secret)', async () => {
    const { order } = await (await req(A, '/api/orders', { method: 'POST', body: { product: 'B', device: 't' } })).json();
    await req(A, `/api/orders/${order.id}/transition`, { method: 'POST', body: { from: 'ordered', to: 'made', device: 'cook' } });
    const ok = await until(() => received.some((it) => it.order.id === order.id && it.order.status === 'made'));
    assert.ok(ok, 'sheet never received the made update');
    const item = received.find((it) => it.order.id === order.id && it.order.status === 'made');
    assert.equal(item.event.to, 'made');
    assert.equal(item.order.product, 'B');
  });

  await test('while the sheet is down, changes wait in the queue and are sent when it comes back', async () => {
    sheetsUp = false;
    const { order } = await (await req(A, '/api/orders', { method: 'POST', body: { product: 'C', device: 't' } })).json();
    await wait(4000);
    let state = await (await req(A, '/api/state')).json();
    assert.ok(state.sync.pending >= 1, 'expected queued changes');
    assert.ok(state.sync.lastError, 'expected an error to be reported');
    assert.ok(!received.some((it) => it.order.id === order.id));
    sheetsUp = true;
    const ok = await until(() => received.some((it) => it.order.id === order.id), 70_000);
    assert.ok(ok, 'queued change never delivered');
    await until(async () => (await (await req(A, '/api/state')).json()).sync.pending === 0);
    state = await (await req(A, '/api/state')).json();
    assert.equal(state.sync.pending, 0);
    assert.equal(state.sync.lastError, null);
  });

  await test('restore into an empty server from the CSV export', async () => {
    const csv = await (await req(A, '/api/export.csv')).text();
    const rows = parseCSV(csv);
    assert.ok(rows.length >= 3);
    spareServer = await startServer(3995, 'b.db');
    const B = 'http://localhost:3995';
    const r = await req(B, '/api/import', { method: 'POST', body: { rows, mode: 'replace' } });
    assert.equal(r.status, 200, await r.clone().text());
    const original = (await (await req(A, '/api/orders')).json()).orders;
    const restored = (await (await req(B, '/api/orders')).json()).orders;
    assert.deepEqual(
      restored.map((o) => [o.id, o.ticket_no, o.product, o.status, o.created_at, o.made_at]),
      original.map((o) => [o.id, o.ticket_no, o.product, o.status, o.created_at, o.made_at]),
    );
  });

  await test('restore accepts the sheet format (millisecond timestamps) and merges by id', async () => {
    const B = 'http://localhost:3995';
    const r = await req(B, '/api/import', {
      method: 'POST',
      body: {
        mode: 'merge',
        rows: [{ id: '999', day: '2', ticket_no: '77', product: 'A', status: 'delivered', created_at: '1792144086357',
          made_at: '1792144096357', delivered_at: '1792144106357', completed_at: '', cancelled_at: '',
          updated_by: 'sheet', is_spare: '0', '受付時刻 (JST)': '2026-10-16 19:08:06', 状態: '運搬完了' }],
      },
    });
    assert.equal(r.status, 200);
    const s = await (await req(B, '/api/state')).json();
    const o = s.active.find((x) => x.id === 999);
    assert.equal(o.ticket_no, 77);
    assert.equal(o.created_at, 1792144086357);
    // New orders continue after the restored ids, and in-progress ticket #77 is not reused.
    await req(B, '/api/settings', { method: 'POST', body: { day: 2, nextTicket: 77 } });
    const n = await (await req(B, '/api/orders', { method: 'POST', body: { product: 'B', device: 't' } })).json();
    assert.ok(n.order.id > 999);
    assert.equal(n.order.ticket_no, 78);
  });

  await test('restore rejects a bad row and changes nothing', async () => {
    const B = 'http://localhost:3995';
    const before = (await (await req(B, '/api/orders?day=1')).json()).orders.length;
    const r = await req(B, '/api/import', {
      method: 'POST', body: { mode: 'replace', rows: [{ id: '1', status: 'ordered', created_at: '' }] },
    });
    assert.equal(r.status, 400);
    const after = (await (await req(B, '/api/orders?day=1')).json()).orders.length;
    assert.equal(after, before);
  });

  await test('10 wrong passcodes lock that address out', async () => {
    for (let i = 0; i < 10; i++) await req(A, '/api/login', { method: 'POST', body: { passcode: 'x' }, auth: false });
    const r = await req(A, '/api/login', { method: 'POST', body: { passcode: PASSCODE }, auth: false });
    assert.equal(r.status, 429);
  });
} finally {
  server.kill();
  spareServer?.kill();
  fake.close();
  rmSync(dir, { recursive: true, force: true });
}

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

console.log(failed ? '\nFAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
