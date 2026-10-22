// Rehearsal simulator: plays all three staff roles against a running server so you can watch the
// screens (especially /display backlog mode) without real people.
//
//   RATE=3 npm run simulate      # orders per minute (default 3; >2 per minute backs up a single cook)
//   SPEED=4 npm run simulate     # run 4× faster than real time
//   BASE=http://192.168.0.10:3000 npm run simulate
const BASE = process.env.BASE || 'http://localhost:3000';
const RATE = Number(process.env.RATE || 3);
const SPEED = Number(process.env.SPEED || 1);

const COOK_SEC = [25, 45];   // time to spin one cotton candy
const CARRY_SEC = [8, 20];   // made → at the counter
const HANDOFF_SEC = [5, 25]; // at counter → customer picks it up
const SPARE_TARGET = Number(process.env.SPARES ?? 2); // 予備 the idle cook keeps on hand

const rand = ([a, b]) => (a + Math.random() * (b - a)) * 1000 / SPEED;
// If the server has STAFF_PASSCODE set, run with PASSCODE=... so the simulator is allowed in.
const AUTH = process.env.PASSCODE ? { 'X-Passcode': process.env.PASSCODE } : {};
const post = (p, body) =>
  fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(body) })
    .then((r) => r.json());
const move = (o, to) => post(`/api/orders/${o.id}/transition`, { from: o.status, to, device: 'simulator' });

const due = new Map(); // `${id}:${status}` → timestamp when the simulated person finishes
let cookFreeAt = 0;

console.log(`Simulating ${RATE} orders/min at ${SPEED}× speed against ${BASE} (Ctrl+C to stop)`);

let offline = false;
setInterval(() =>
  tick().then(
    () => {
      if (offline) console.log('  reconnected');
      offline = false;
    },
    () => {
      if (!offline) console.log(`  cannot reach ${BASE} — is the server running? (npm start) Retrying…`);
      offline = true;
    },
  ), 1000);

async function tick() {
  const now = Date.now();

  if (Math.random() < (RATE / 60) * SPEED) {
    const { order } = await post('/api/orders', { product: 'ABCD'[Math.floor(Math.random() * 4)], device: 'simulator' });
    if (order) console.log(`  new #${order.ticket_no}`);
  }

  const { active, spares } = await fetch(`${BASE}/api/state`, { headers: AUTH }).then((r) => r.json());

  // One cook, oldest order first.
  const next = active.find((o) => o.status === 'ordered');
  if (next) {
    const key = `${next.id}:ordered`;
    if (!due.has(key)) {
      due.set(key, Math.max(now, cookFreeAt) + rand(COOK_SEC));
      cookFreeAt = due.get(key);
    }
    if (now >= due.get(key)) await move(next, 'made');
  } else if (spares.length < SPARE_TARGET && now >= cookFreeAt) {
    // Idle cook makes 予備 ahead of time, up to SPARE_TARGET.
    if (!due.has('spare')) due.set('spare', now + rand(COOK_SEC));
    if (now >= due.get('spare')) {
      due.delete('spare');
      await post('/api/spares', { device: 'simulator' });
      console.log('  +1 予備');
    }
  }

  // Carrier carries orders and spares; server hands over orders (spares wait at the counter).
  for (const o of [...active, ...spares]) {
    if (o.ticket_no == null && o.status === 'delivered') continue;
    const spec = { made: ['delivered', CARRY_SEC], delivered: ['completed', HANDOFF_SEC] }[o.status];
    if (!spec) continue;
    const key = `${o.id}:${o.status}`;
    if (!due.has(key)) due.set(key, now + rand(spec[1]));
    if (now >= due.get(key)) await move(o, spec[0]);
  }
}
