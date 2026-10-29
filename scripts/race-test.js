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

  await test('four products with the real names; product D can be ordered', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.deepEqual(Object.values(s.config.products).map((p) => p.name),
      ['barbe à./綿飴', 'Caramella al./ピュレレモン', 'Gemma f./パチパチ', 'Gommose/ピュレブドウ']);
    const r = await post('/api/orders', { product: 'D', device: 'server' });
    assert.equal(r.status, 201);
    assert.equal(r.data.order.product, 'D');
  });

  await test('old placeholder names (トッピングA…) are replaced, custom names are kept', async () => {
    await post('/api/settings', { products: { A: { name: 'トッピングA' }, B: { name: 'レモン特製' } } });
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(s.config.products.A.name, 'barbe à./綿飴');
    assert.equal(s.config.products.B.name, 'レモン特製');
    await post('/api/settings', { products: { B: { name: 'Caramella al./ピュレレモン' } } });
  });

  await test('resetting the day empties its stats, cancels in-progress orders, restarts tickets at #1', async () => {
    const day = (await fetch(`${BASE}/api/state`).then((r) => r.json())).config.day;
    const before = await fetch(`${BASE}/api/stats?day=${day}`).then((r) => r.json());
    assert.ok(before.byStatus.length > 0);
    const r = await post('/api/reset-day', { day, device: 'admin' });
    assert.equal(r.status, 200);
    assert.ok(r.data.reset > 0);
    const after = await fetch(`${BASE}/api/stats?day=${day}`).then((r) => r.json());
    assert.equal(after.byStatus.filter((x) => x.product).length, 0);
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(s.active.length, 0, 'in-progress orders should be cancelled');
    assert.equal(s.config.nextTicket, 1);
    // Nothing is deleted: the orders are still in the export (moved to day 0).
    const csv = await fetch(`${BASE}/api/export.csv`).then((r) => r.text());
    assert.ok(csv.trim().split('\n').length - 1 >= r.data.reset);
    const n = await post('/api/orders', { product: 'A', device: 'server' });
    assert.equal(n.data.order.ticket_no, 1);
  });

  await test('cook help request shows up for admin, once per device, until resolved', async () => {
    const r1 = await post('/api/help', { device: 'cook-x', role: 'cook' });
    const r2 = await post('/api/help', { device: 'cook-x', role: 'cook' }); // pressing again doesn't duplicate
    assert.equal(r1.status, 201);
    assert.equal(r2.data.help.id, r1.data.help.id);
    let s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.deepEqual(s.help.map((h) => [h.device, h.role]), [['cook-x', 'cook']]);
    await post(`/api/help/${r1.data.help.id}/resolve`, { device: 'admin' });
    s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(s.help.length, 0);
  });

  await test('the 受け渡し screen exists at /handoff', async () => {
    const r = await fetch(`${BASE}/handoff`);
    assert.equal(r.status, 200);
  });

  await test('a cancelled order stays visible (as cancelled) for every screen', async () => {
    const { data } = await post('/api/orders', { product: 'A', device: 'server-abcd' });
    await post(`/api/orders/${data.order.id}/transition`, { from: 'ordered', to: 'cancelled', device: 'server-abcd' });
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.ok(!s.active.some((o) => o.id === data.order.id), 'no longer active');
    const c = s.recentCancelled.find((o) => o.id === data.order.id);
    assert.ok(c, 'listed as recently cancelled');
    assert.equal(c.status, 'cancelled');
    assert.equal(c.updated_by, 'server-abcd');
  });

  await test('prices default to ¥100 + ¥50 per topping, and can be changed or cleared in admin', async () => {
    let s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.deepEqual(Object.values(s.config.products).map((p) => p.price), [100, 50, 50, 50]);
    await post('/api/settings', { products: { A: { price: '300' }, B: { price: 100 } } });
    s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(s.config.products.A.price, 300);
    assert.equal(s.config.products.B.price, 100);
    assert.equal(s.config.products.C.price, 50);
    await post('/api/settings', { products: { B: { price: '' } } });
    s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(s.config.products.B.price, null);
  });

  await test('daily caps default to 300 cotton candy and 100 per topping', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    assert.equal(s.config.dailyCap, 300);
    assert.equal(s.config.toppingCap, 100);
    assert.equal(s.sales.dailyCap, 300);
  });

  await test('a topping stops at its cap; plain 綿飴 and other toppings still sell', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const soldB = s.sales.byProduct.B ?? 0;
    await post('/api/settings', { toppingCap: soldB + 1 });
    assert.equal((await post('/api/orders', { product: 'B', device: 'server' })).status, 201);
    const over = await post('/api/orders', { product: 'B', device: 'server' });
    assert.equal(over.status, 409);
    assert.equal(over.data.error, 'topping_cap');
    assert.equal((await post('/api/orders', { product: 'A', device: 'server' })).status, 201);
    assert.equal((await post('/api/orders', { product: 'C', device: 'server' })).status, 201);
  });

  await test('the cotton candy cap stops every order, with or without a topping', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    await post('/api/settings', { dailyCap: s.sales.total, toppingCap: 100 });
    for (const product of ['A', 'D']) {
      const r = await post('/api/orders', { product, device: 'server' });
      assert.equal(r.status, 409);
      assert.equal(r.data.error, 'daily_cap');
    }
  });

  await test('cancelled orders do not count toward the cap', async () => {
    const s = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const o = s.active.find((x) => x.status === 'ordered');
    await post(`/api/orders/${o.id}/transition`, { from: 'ordered', to: 'cancelled', device: 'server' });
    assert.equal((await post('/api/orders', { product: 'A', device: 'server' })).status, 201);
    await post('/api/settings', { dailyCap: 300 });
  });
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? '\nFAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
