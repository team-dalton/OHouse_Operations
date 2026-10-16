// Multi-device safety test. Starts a throwaway server with a temp DB, then fires concurrent requests
// the way several tablets tapping at once would, and checks nothing is double-processed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(path.join(os.tmpdir(), 'wataame-test-'));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('running') && resolve()));

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

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

try {
  await test('50 simultaneous orders get 50 unique ticket numbers', async () => {
    const res = await Promise.all(
      Array.from({ length: 50 }, (_, i) => post('/api/orders', { product: i % 2 ? 'A' : 'B', device: `t${i % 3}` }))
    );
    assert.ok(res.every((r) => r.status === 201));
    const tickets = res.map((r) => r.data.order.ticket_no);
    assert.equal(new Set(tickets).size, 50);
  });

  await test('two cooks tapping 完成 on the same order: exactly one wins', async () => {
    const { data } = await post('/api/orders', { product: 'A', device: 'server' });
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(`/api/orders/${data.order.id}/transition`, { from: 'ordered', to: 'made', device: `cook${i}` }))
    );
    assert.equal(res.filter((r) => r.status === 200).length, 1);
    assert.equal(res.filter((r) => r.status === 409).length, 9);
  });

  await test('stale tap (order already moved on) is rejected', async () => {
    const { data } = await post('/api/orders', { product: 'B', device: 'server' });
    const id = data.order.id;
    await post(`/api/orders/${id}/transition`, { from: 'ordered', to: 'made', device: 'cook' });
    await post(`/api/orders/${id}/transition`, { from: 'made', to: 'delivered', device: 'carrier' });
    const stale = await post(`/api/orders/${id}/transition`, { from: 'ordered', to: 'made', device: 'cook' });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.order.status, 'delivered');
  });

  await test('undo keeps the original timestamps', async () => {
    const { data } = await post('/api/orders', { product: 'A', device: 'server' });
    const id = data.order.id;
    const made = await post(`/api/orders/${id}/transition`, { from: 'ordered', to: 'made', device: 'cook' });
    const delivered = await post(`/api/orders/${id}/transition`, { from: 'made', to: 'delivered', device: 'carrier' });
    const undo = await post(`/api/orders/${id}/transition`, { from: 'delivered', to: 'made', device: 'carrier' });
    assert.equal(undo.data.order.status, 'made');
    assert.equal(undo.data.order.made_at, made.data.order.made_at);
    assert.equal(undo.data.order.delivered_at, null);
    assert.ok(delivered.data.order.delivered_at);
  });

  await test('topping C can be ordered', async () => {
    const r = await post('/api/orders', { product: 'C', device: 'server' });
    assert.equal(r.status, 201);
    assert.equal(r.data.order.product, 'C');
  });

  // --- 予備 (spares) ---
  // Finish leftover orders first so spares aren't auto-assigned to orders from earlier tests.
  const leftovers = await fetch(`${BASE}/api/state`).then((r) => r.json());
  for (const o of leftovers.active) {
    let status = o.status;
    for (const to of ['made', 'delivered', 'completed'].slice(['ordered', 'made', 'delivered'].indexOf(status))) {
      await post(`/api/orders/${o.id}/transition`, { from: status, to, device: 'test' });
      status = to;
    }
  }

  await test('cook makes a spare when no order is waiting', async () => {
    const r = await post('/api/spares', { device: 'cook' });
    assert.equal(r.status, 201);
    assert.equal(r.data.spare.ticket_no, null);
    assert.equal(r.data.spare.status, 'made');
  });

  await test('spare at the counter fills a new order immediately (status = delivered)', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const spare = s.spares[0];
    await post(`/api/orders/${spare.id}/transition`, { from: 'made', to: 'delivered', device: 'carrier' });
    const r = await post('/api/orders', { product: 'C', device: 'server' });
    assert.equal(r.data.order.id, spare.id);
    assert.equal(r.data.order.status, 'delivered');
    assert.ok(r.data.order.ticket_no > 0);
  });

  await test('spare button with an order waiting fills that order instead', async () => {
    const { data } = await post('/api/orders', { product: 'A', device: 'server' });
    assert.equal(data.order.status, 'ordered');
    const r = await post('/api/spares', { device: 'cook' });
    assert.equal(r.data.assigned.id, data.order.id);
    assert.equal(r.data.assigned.status, 'made');
  });

  await test('two simultaneous orders with one spare: exactly one gets it', async () => {
    await post('/api/spares', { device: 'cook' });
    const res = await Promise.all([
      post('/api/orders', { product: 'A', device: 's1' }),
      post('/api/orders', { product: 'B', device: 's2' }),
    ]);
    const statuses = res.map((r) => r.data.order.status).sort();
    assert.deepEqual(statuses, ['made', 'ordered']);
  });

  await test('cancelling a made order returns the candy to the spares', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const made = s.active.find((o) => o.status === 'made');
    const before = s.spares.length;
    await post(`/api/orders/${made.id}/transition`, { from: 'made', to: 'cancelled', device: 'server' });
    const after = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(after.spares.length, before + 1);
  });

  await test('a spare cannot be marked handed over', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const spare = s.spares[0];
    const r = await post(`/api/orders/${spare.id}/transition`, { from: spare.status, to: 'completed', device: 'x' });
    assert.equal(r.status, 400);
  });

  await test('restarting the ticket counter at 1 reuses #1 (finished orders free their number)', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const inProgress = new Set(s.active.map((o) => o.ticket_no));
    await post('/api/settings', { nextTicket: 1 });
    const r = await post('/api/orders', { product: 'A', device: 'server' });
    // #1 was completed earlier in this test run; the counter skips only numbers still in progress.
    let expected = 1;
    while (inProgress.has(expected)) expected++;
    assert.equal(r.data.order.ticket_no, expected);
    const after = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(after.config.nextTicket, expected + 1);
  });

  await test('restarted counter skips a number that is still in progress', async () => {
    const a = await post('/api/orders', { product: 'A', device: 'server' }); // stays 'ordered'
    await post('/api/settings', { nextTicket: a.data.order.ticket_no });
    const b = await post('/api/orders', { product: 'B', device: 'server' });
    assert.notEqual(b.data.order.ticket_no, a.data.order.ticket_no);
  });

  await test('sold-out product cannot be ordered', async () => {
    await post('/api/settings', { products: { B: { soldOut: true } } });
    const r = await post('/api/orders', { product: 'B', device: 'server' });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'sold_out');
  });
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? '\nFAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
