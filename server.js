// Candy Cloud 注文管理 (cotton candy orders) — single-process server.
// Zero dependencies: node:http for the API, Server-Sent Events for live push, node:sqlite for storage.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'festival.db');

// Staff passcode. Unset (local Wi-Fi setup) → everything is open, as before.
// Set (public hosting, e.g. Railway) → every page and API except the customer display needs the passcode.
const PASSCODE = process.env.STAFF_PASSCODE || '';
// The login cookie holds a value derived from the passcode, so changing STAFF_PASSCODE signs every device out.
const AUTH_TOKEN = PASSCODE ? createHmac('sha256', PASSCODE).update('wataame-staff-v1').digest('hex') : '';
const AUTH_COOKIE = 'wataame_auth';

// Google Sheets backup (optional): every order change is POSTed to an Apps Script web app.
const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL || '';
const SHEETS_SECRET = process.env.SHEETS_SECRET || '';
// Optional link to the backup spreadsheet itself, shown in /admin so it can be found quickly during a restore.
// Served only to signed-in staff (never in the public live feed, which the customer display also reads).
const SHEETS_VIEW_URL = /^https:\/\//.test(process.env.SHEETS_VIEW_URL || '') ? process.env.SHEETS_VIEW_URL : '';

// Each start gets a new id; screens reload themselves when it changes so they always match the server.
const BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
const STARTED_AT = Date.now();

// True when server.js or a page file was edited after this process started, i.e. the running server is
// older than the files the browsers load. Screens show a "restart the server" warning in that case.
function codeChangedSinceStart() {
  const files = [path.join(ROOT, 'server.js'),
    ...readdirSync(path.join(ROOT, 'public')).map((f) => path.join(ROOT, 'public', f))];
  return files.some((f) => {
    try {
      return statSync(f).mtimeMs > STARTED_AT;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
// A row with ticket_no = NULL is a 予備 (spare): cotton candy the cook made before anyone ordered it.
// Spares are all identical (toppings go on at the counter), so any spare can fill any order.
const ORDERS_SCHEMA = `
  CREATE TABLE orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    day          INTEGER NOT NULL,
    ticket_no    INTEGER,
    product      TEXT,
    status       TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    made_at      INTEGER,
    delivered_at INTEGER,
    completed_at INTEGER,
    cancelled_at INTEGER,
    updated_by   TEXT,
    is_spare     INTEGER NOT NULL DEFAULT 0, -- 1 if this candy was made as a spare
    bundle       INTEGER -- one customer's several orders share this (the first order's id); NULL if ordered alone
  )`;
// Ticket numbers are reused (e.g. the admin restarts the counter at 1), so they are not unique in the table.
// createOrder() only refuses a number that belongs to an order still in progress.

// Migrate older databases by rebuilding the table and copying rows across:
//  - before spares existed (no is_spare; ticket_no/product NOT NULL)
//  - before ticket numbers could be reused (UNIQUE (day, ticket_no))
const orderCols = db.prepare(`PRAGMA table_info(orders)`).all();
const orderSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'`).get()?.sql ?? '';
if (orderCols.length === 0) {
  db.exec(ORDERS_SCHEMA);
} else if (!orderCols.some((c) => c.name === 'is_spare') || /UNIQUE/i.test(orderSql)) {
  const copy = ['id', 'day', 'ticket_no', 'product', 'status', 'created_at', 'made_at', 'delivered_at',
    'completed_at', 'cancelled_at', 'updated_by', 'is_spare', 'bundle']
    .filter((c) => orderCols.some((col) => col.name === c)).join(', ');
  db.exec(`
    BEGIN;
    ALTER TABLE orders RENAME TO orders_old;
    ${ORDERS_SCHEMA};
    INSERT INTO orders (${copy}) SELECT ${copy} FROM orders_old;
    DROP TABLE orders_old;
    COMMIT;`);
} else if (!orderCols.some((c) => c.name === 'bundle')) {
  db.exec(`ALTER TABLE orders ADD COLUMN bundle INTEGER`); // before carts (several orders per customer)
}
db.exec(`CREATE INDEX IF NOT EXISTS orders_status ON orders (status, ticket_no)`);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    device      TEXT,
    at          INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Changes waiting to be sent to Google Sheets. Kept in the database so nothing is lost if the
  -- internet drops or the server restarts; rows are deleted once the sheet confirms them.
  CREATE TABLE IF NOT EXISTS sync_outbox (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT    NOT NULL
  );
`);

// Order lifecycle. `cancelled` sits outside the main flow.
const FLOW = ['ordered', 'made', 'delivered', 'completed'];
const STATUSES = [...FLOW, 'cancelled'];
const TS_COL = { made: 'made_at', delivered: 'delivered_at', completed: 'completed_at' };

const DEFAULT_CONFIG = {
  products: {
    // price: 綿飴 ¥100; each topping adds ¥50. cap: how many of it sell per day (null = only the daily total).
    A: { name: 'barbe à./綿飴', price: 100, cap: null },
    B: { name: 'Caramella al./ピュレレモン', price: 50, cap: 100 },
    C: { name: 'Gemma f./パチパチ', price: 50, cap: 100 },
    D: { name: 'Gommose/ピュレブドウ', price: 50, cap: 100 },
  },
  day: 1,
  nextTicket: 1,
  backlogCount: 8,    // pending orders above this → backlog mode
  backlogMinutes: 10, // oldest pending order older than this → backlog mode
  dailyCap: 300,      // cotton candy per day (all orders, with or without a topping)
};

function getConfig() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'config'`).get();
  if (!row) return structuredClone(DEFAULT_CONFIG);
  const { toppingCap, ...saved } = JSON.parse(row.value);
  // Merge products too, so a product added to DEFAULT_CONFIG appears in an existing database.
  const products = mergeProducts(saved.products ?? {});
  // Before per-product caps, one toppingCap applied to every topping: carry it over to each of them.
  if (Number.isInteger(toppingCap)) {
    for (const k of Object.keys(products).slice(1)) if (saved.products?.[k]?.cap === undefined) products[k].cap = toppingCap;
  }
  return { ...DEFAULT_CONFIG, ...saved, products };
}

// Saved settings keep custom product names, but the old placeholder names (トッピングA…) are replaced by the
// current defaults, so an existing database picks up the real product names without anyone retyping them.
function mergeProducts(saved) {
  const merged = structuredClone(DEFAULT_CONFIG.products);
  for (const [key, p] of Object.entries(saved)) {
    const placeholder = /^トッピング[A-Z]$/.test(p.name ?? '');
    merged[key] = { ...merged[key], ...p, ...(placeholder && merged[key] ? { name: merged[key].name } : {}) };
  }
  return merged;
}

function saveConfig(cfg) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('config', ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cfg));
}

const logEvent = db.prepare(
  `INSERT INTO events (order_id, from_status, to_status, device, at) VALUES (?, ?, ?, ?, ?)`
);
const enqueueSync = db.prepare(`INSERT INTO sync_outbox (payload) VALUES (?)`);

// Every order change goes through here: it is logged locally and, if Sheets backup is on, queued with the
// order's full current row so the sheet always holds enough to rebuild the order.
function recordEvent(orderId, from, to, device, at) {
  logEvent.run(orderId, from, to, device, at);
  if (SHEETS_URL) {
    enqueueSync.run(JSON.stringify({ event: { at, from, to, device }, order: getOrder(orderId) }));
  }
}

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function createOrder(product, device) {
  const cfg = getConfig();
  const p = cfg.products[product];
  if (!p) throw new HttpError(400, 'unknown_product');
  // Daily caps: 300 cotton candy in total, and each product's own cap (set per product in admin).
  const sold = salesToday(cfg.day);
  if (sold.total >= cfg.dailyCap) throw new HttpError(409, 'daily_cap', { cap: cfg.dailyCap });
  if (p.cap != null && (sold.byProduct[product] ?? 0) >= p.cap) {
    throw new HttpError(409, 'product_cap', { cap: p.cap, name: p.name });
  }

  // Node is single-threaded and DatabaseSync is synchronous, so this read-increment-write is atomic.
  // Skip only numbers still in use by an in-progress order; numbers of finished or cancelled orders are free,
  // so restarting the counter at 1 really starts at #1.
  let ticket = Math.max(1, cfg.nextTicket);
  const inUse = db.prepare(
    `SELECT 1 FROM orders WHERE ticket_no = ? AND status IN ('ordered', 'made', 'delivered')`
  );
  while (inUse.get(ticket)) ticket++;
  cfg.nextTicket = ticket + 1;
  saveConfig(cfg);

  const now = Date.now();

  // Use a spare if there is one: prefer one already at the counter (customer gets it immediately),
  // then one still being carried. The order skips the stages the spare has already passed.
  const spare = db
    .prepare(`SELECT * FROM orders WHERE ticket_no IS NULL AND status IN ('delivered', 'made')
              ORDER BY CASE status WHEN 'delivered' THEN 0 ELSE 1 END, made_at, id LIMIT 1`)
    .get();
  if (spare) {
    db.prepare(`UPDATE orders SET day = ?, ticket_no = ?, product = ?, created_at = ?, updated_by = ?
                WHERE id = ?`)
      .run(cfg.day, ticket, product, now, device, spare.id);
    recordEvent(spare.id, 'spare', spare.status, device, now);
    return getOrder(spare.id);
  }

  const { lastInsertRowid } = db
    .prepare(`INSERT INTO orders (day, ticket_no, product, status, created_at, updated_by)
              VALUES (?, ?, ?, 'ordered', ?, ?)`)
    .run(cfg.day, ticket, product, now, device);
  recordEvent(lastInsertRowid, null, 'ordered', device, now);
  return getOrder(lastInsertRowid);
}

// One customer's purchase: several cotton candies at once, one order (and number) each. The caps are checked
// for the whole purchase first and it runs in one transaction, so it is all or nothing; the numbers come out
// consecutive (unless one is still in use).
function createOrders(products, device) {
  const cfg = getConfig();
  if (!products.length || products.length > 50) throw new HttpError(400, 'bad_items');
  if (products.some((p) => !cfg.products[p])) throw new HttpError(400, 'unknown_product');
  const sold = salesToday(cfg.day);
  if (sold.total + products.length > cfg.dailyCap) throw new HttpError(409, 'daily_cap', { cap: cfg.dailyCap });
  for (const p of new Set(products)) {
    const n = products.filter((x) => x === p).length;
    const { cap, name } = cfg.products[p];
    if (cap != null && (sold.byProduct[p] ?? 0) + n > cap) throw new HttpError(409, 'product_cap', { cap, name });
  }
  db.exec('BEGIN');
  try {
    let orders = products.map((p) => createOrder(p, device));
    // Several orders: tie them together so every screen shows them as one customer's bundle.
    if (orders.length > 1) {
      const tag = db.prepare(`UPDATE orders SET bundle = ? WHERE id = ?`);
      for (const o of orders) tag.run(orders[0].id, o.id);
      orders = orders.map((o) => getOrder(o.id));
    }
    db.exec('COMMIT');
    return orders;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Admin "reset this day": the day's orders leave the stats and order list and the ticket counter restarts.
// Nothing is deleted — the orders move to day 0 (リセット済み), so they stay in the CSV export and the sheet.
// Orders still in progress are cancelled; spares (real candy waiting to be used) are left alone.
function resetDay(day, device) {
  const now = Date.now();
  const rows = db.prepare(`SELECT id, status FROM orders WHERE day = ? AND ticket_no IS NOT NULL`).all(day);
  let cancelled = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (['ordered', 'made', 'delivered'].includes(r.status)) {
        db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_by = ? WHERE id = ?`)
          .run(now, device, r.id);
        cancelled++;
      }
      db.prepare(`UPDATE orders SET day = 0 WHERE id = ?`).run(r.id);
      recordEvent(r.id, r.status, 'reset', device, now);
    }
    const cfg = getConfig();
    if (cfg.day === day) {
      cfg.nextTicket = 1;
      saveConfig(cfg);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { reset: rows.length, cancelled };
}

// Cook made one cotton candy without a specific order. If an order is waiting, it fills the oldest one
// (same as pressing 完成). Otherwise it becomes a spare that later orders will pick up.
function makeSpare(device) {
  const waiting = db
    .prepare(`SELECT id FROM orders WHERE status = 'ordered' ORDER BY created_at, id LIMIT 1`)
    .get();
  if (waiting) return { assigned: transition(waiting.id, 'ordered', 'made', device) };

  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO orders (day, ticket_no, product, status, created_at, made_at, updated_by, is_spare)
              VALUES (?, NULL, NULL, 'made', ?, ?, ?, 1)`)
    .run(getConfig().day, now, now, device);
  recordEvent(lastInsertRowid, null, 'spare', device, now);
  return { spare: getOrder(lastInsertRowid) };
}

// Orders sold on a day (cancelled ones and unclaimed spares don't count), in total and per product.
function salesToday(day) {
  const rows = db.prepare(`SELECT product, COUNT(*) AS n FROM orders
                           WHERE day = ? AND ticket_no IS NOT NULL AND status != 'cancelled' GROUP BY product`).all(day);
  const byProduct = Object.fromEntries(rows.map((r) => [r.product, r.n]));
  return { total: rows.reduce((a, r) => a + r.n, 0), byProduct };
}

function getOrder(id) {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
}

// Compare-and-set: only succeeds if the order is still in `from`.
// Two devices tapping the same order → exactly one wins, the other gets 409.
function transition(id, from, to, device) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to) || from === to) {
    throw new HttpError(400, 'bad_transition');
  }
  const before = getOrder(id);
  if (!before) throw new HttpError(404, 'not_found');
  // A spare has no ticket, so it can't be handed to a customer or sent back to the order queue.
  if (before.ticket_no == null && (to === 'ordered' || to === 'completed')) {
    throw new HttpError(400, 'spare_has_no_order');
  }
  const now = Date.now();
  const sets = ['status = ?', 'updated_by = ?'];
  const params = [to, device];

  if (to === 'cancelled') {
    sets.push('cancelled_at = ?');
    params.push(now);
  } else {
    sets.push('cancelled_at = NULL');
    const k = FLOW.indexOf(to);
    FLOW.slice(1).forEach((stage, i) => {
      const col = TS_COL[stage];
      // Keep existing timestamps for stages already reached (so undo → redo doesn't lose history),
      // clear timestamps for stages after the target.
      if (i + 1 <= k) {
        sets.push(`${col} = COALESCE(${col}, ?)`);
        params.push(now);
      } else {
        sets.push(`${col} = NULL`);
      }
    });
  }

  const { changes } = db
    .prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND status = ?`)
    .run(...params, id, from);

  if (changes === 0) throw new HttpError(409, 'conflict', { order: getOrder(id) });
  recordEvent(id, from, to, device, now);

  // Cancelling an order whose candy already exists: the candy isn't wasted, it goes back to the spares.
  if (to === 'cancelled' && before.ticket_no != null && (from === 'made' || from === 'delivered')) {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO orders (day, ticket_no, product, status, created_at, made_at, delivered_at,
                                    updated_by, is_spare)
                VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, 1)`)
      .run(before.day, from, before.made_at, before.made_at, before.delivered_at, device);
    recordEvent(lastInsertRowid, null, 'spare', device, now);
  }
  return getOrder(id);
}

// ---------------------------------------------------------------------------
// Snapshot pushed to every device
// ---------------------------------------------------------------------------

function queueInfo(active, cfg, now) {
  const pending = active.filter((o) => o.status === 'ordered' || o.status === 'made');
  const oldestPendingMs = pending.length ? now - Math.min(...pending.map((o) => o.created_at)) : 0;

  // Estimated wait: pending orders ÷ recent delivery rate (last 15 min). Fallback 1.5 min/order.
  // The rate is measured over the span actually observed (min 3 min), so it isn't underestimated
  // right after opening when only a minute or two of data exists.
  const windowMs = 15 * 60 * 1000;
  const { n, first } = db
    .prepare(`SELECT COUNT(*) AS n, MIN(delivered_at) AS first FROM orders
              WHERE delivered_at >= ? AND status IN ('delivered','completed')`)
    .get(now - windowMs);
  const spanMin = Math.max(3, (now - (first ?? now)) / 60_000);
  const perMinute = n >= 3 ? n / spanMin : 1 / 1.5;
  const estWaitMin = Math.ceil(pending.length / perMinute);

  const backlog =
    pending.length > cfg.backlogCount || oldestPendingMs > cfg.backlogMinutes * 60 * 1000;

  return {
    ordered: active.filter((o) => o.status === 'ordered').length,
    made: active.filter((o) => o.status === 'made').length,
    delivered: active.filter((o) => o.status === 'delivered').length,
    pending: pending.length,
    oldestPendingMs,
    estWaitMin,
    backlog,
  };
}

function snapshot() {
  const now = Date.now();
  const cfg = getConfig();
  const active = db
    .prepare(`SELECT * FROM orders WHERE ticket_no IS NOT NULL AND status IN ('ordered','made','delivered')
              ORDER BY created_at, id`)
    .all();
  const spares = db
    .prepare(`SELECT * FROM orders WHERE ticket_no IS NULL AND status IN ('made','delivered')
              ORDER BY made_at, id`)
    .all();
  // Cancelled in the last 10 minutes: every screen shows them greyed out, so staff elsewhere (e.g. the cook)
  // can see what happened. Only today's orders, so a day reset doesn't flood the list.
  const recentCancelled = db
    .prepare(`SELECT * FROM orders WHERE status = 'cancelled' AND ticket_no IS NOT NULL AND day = ?
              AND cancelled_at >= ? ORDER BY created_at, id`)
    .all(cfg.day, now - 10 * 60_000);
  const recentCompleted = db
    .prepare(`SELECT * FROM orders WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 8`)
    .all();
  // Every member of each bundle still in progress (handed over and cancelled ones too), so screens can show
  // the whole customer's order: e.g. "#012 is still being made" next to the ones already at the counter.
  const bundleMembers = db.prepare(`SELECT id, ticket_no, product, status FROM orders WHERE bundle = ? ORDER BY id`);
  const bundles = Object.fromEntries([...new Set(active.map((o) => o.bundle).filter((b) => b != null))]
    .map((b) => [b, bundleMembers.all(b)]));
  return {
    now,
    boot: BOOT_ID,
    codeUpdated: codeChangedSinceStart(),
    config: cfg,
    active,
    recentCancelled,
    spares,
    recentCompleted,
    bundles,
    queue: {
      ...queueInfo(active, cfg, now),
      sparesMade: spares.filter((s) => s.status === 'made').length,           // at the cook / being carried
      sparesReady: spares.filter((s) => s.status === 'delivered').length,     // waiting at the counter
    },
    devices: [...clients.values()].map(({ role, name, since }) => ({ role, name, since })),
    lan: lanUrls(),
    sync: syncInfo(),
    sales: { ...salesToday(cfg.day), dailyCap: cfg.dailyCap }, // each product's own cap is in config.products
    help: helpRequests,
    auth: Boolean(PASSCODE),
  };
}

// Addresses other devices on the same Wi-Fi use to reach this machine.
function lanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

const clients = new Map(); // res → { role, name, since }

// Open help requests ({ id, device, role, at }). Kept in memory: they only matter while someone is waiting.
const helpRequests = [];
let helpSeq = 0;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let broadcastQueued = false;
function broadcast() {
  // Coalesce bursts (e.g. carrier batch) into a single push.
  if (broadcastQueued) return;
  broadcastQueued = true;
  setImmediate(() => {
    broadcastQueued = false;
    const snap = snapshot();
    for (const res of clients.keys()) send(res, 'state', snap);
  });
}

setInterval(() => {
  for (const res of clients.keys()) send(res, 'ping', Date.now());
}, 10_000);
// Periodic refresh so time-based backlog rules kick in without any taps.
setInterval(broadcast, 15_000);

// ---------------------------------------------------------------------------
// Admin queries
// ---------------------------------------------------------------------------

function stats(day) {
  const byStatus = db
    .prepare(`SELECT product, status, COUNT(*) AS n FROM orders WHERE day = ? GROUP BY product, status`)
    .all(day);
  // Orders filled from a spare were made/carried before they were ordered, so they are left out of the
  // cook and carry averages, and their counter wait starts when the order was placed.
  const avg = db
    .prepare(`SELECT
        AVG(CASE WHEN is_spare = 0 THEN made_at - created_at END)   AS cook_ms,
        AVG(CASE WHEN is_spare = 0 THEN delivered_at - made_at END) AS carry_ms,
        AVG(completed_at - MAX(delivered_at, created_at))           AS handoff_ms,
        AVG(completed_at - created_at)                              AS total_ms,
        COUNT(*)                                                    AS n
      FROM orders WHERE day = ? AND status = 'completed'`)
    .get(day);
  const spares = db
    .prepare(`SELECT COUNT(*) AS made, COUNT(ticket_no) AS used FROM orders WHERE day = ? AND is_spare = 1`)
    .get(day);
  const hourly = db
    .prepare(`SELECT strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS hour, COUNT(*) AS n
              FROM orders WHERE day = ? AND ticket_no IS NOT NULL AND status != 'cancelled'
              GROUP BY hour ORDER BY hour`)
    .all(day);
  return { day, byStatus, avg, spares, hourly };
}

// ---------------------------------------------------------------------------
// Google Sheets backup
// ---------------------------------------------------------------------------

const syncStatus = { lastOkAt: null, lastError: null };
let syncDelay = 3000;

// Sends queued changes in batches. On failure it backs off (up to 1 min) and retries; the queue stays in the
// database, so an internet outage or a restart only delays the backup.
// The <title> (or first text) of an HTML reply, kept short for the /admin status card.
function describeHtml(text) {
  const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  return (title || text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120) || 'empty reply';
}

function sheetsHint(text) {
  if (!/script\.google(usercontent)?\.com\/macros/.test(SHEETS_URL)) {
    return 'SHEETS_WEBHOOK_URL が Apps Script の /exec URL ではありません';
  }
  if (/accounts\.google\.com|ServiceLogin|サインイン|Sign in/i.test(text)) {
    return 'Apps Script のアクセスが「全員 (Anyone)」になっていません';
  }
  return 'Apps Script からの応答が読めません（デプロイを確認してください）';
}

async function flushSync() {
  const rows = db.prepare(`SELECT id, payload FROM sync_outbox ORDER BY id LIMIT 200`).all();
  if (!rows.length) return;
  try {
    const res = await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify({ secret: SHEETS_SECRET, config: getConfig(), items: rows.map((r) => JSON.parse(r.payload)) }),
      redirect: 'follow', // Apps Script answers via a redirect
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Not our script's JSON reply: usually the spreadsheet's own URL was used instead of the /exec URL,
      // or Google returned an error/sign-in page. Show what came back so /admin can say what is wrong.
      throw new Error(`${sheetsHint(text)} (HTTP ${res.status}: ${describeHtml(text)})`);
    }
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    db.prepare(`DELETE FROM sync_outbox WHERE id <= ?`).run(rows.at(-1).id);
    syncStatus.lastOkAt = Date.now();
    syncStatus.lastError = null;
    syncDelay = 3000;
  } catch (err) {
    syncStatus.lastError = String(err.message || err);
    syncDelay = Math.min(syncDelay * 2, 60_000);
  }
}

function scheduleSync() {
  setTimeout(async () => {
    await flushSync();
    scheduleSync();
  }, syncDelay);
}
if (SHEETS_URL) scheduleSync();

function syncInfo() {
  if (!SHEETS_URL) return { enabled: false };
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM sync_outbox`).get();
  return { enabled: true, pending: n, ...syncStatus };
}

// ---------------------------------------------------------------------------
// Restore (import) — rebuilds orders from the sheet's "orders" tab or from /api/export.csv
// ---------------------------------------------------------------------------

const ORDER_COLS = ['id', 'day', 'ticket_no', 'product', 'status', 'created_at', 'made_at',
  'delivered_at', 'completed_at', 'cancelled_at', 'updated_by', 'is_spare', 'bundle'];

// Accepts epoch milliseconds (the sheet) or ISO dates (the CSV export).
function toMs(v, field, line) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, 'bad_import', { line, field, value: s });
  return t;
}

function importOrders(rows, mode) {
  if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, 'bad_import', { reason: 'no_rows' });
  const clean = rows.map((r, i) => {
    const line = i + 2; // +1 for the header, +1 for 1-based numbering
    const id = Number(r.id);
    const status = String(r.status ?? '').trim();
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_import', { line, field: 'id' });
    if (!STATUSES.includes(status)) throw new HttpError(400, 'bad_import', { line, field: 'status' });
    const created = toMs(r.created_at, 'created_at', line);
    if (created == null) throw new HttpError(400, 'bad_import', { line, field: 'created_at' });
    const ticket = String(r.ticket_no ?? '').trim();
    return [
      id,
      String(r.day ?? '').trim() === '' ? 1 : Number(r.day) || 0,
      ticket ? Number(ticket) : null,
      String(r.product ?? '').trim() || null,
      status,
      created,
      toMs(r.made_at, 'made_at', line),
      toMs(r.delivered_at, 'delivered_at', line),
      toMs(r.completed_at, 'completed_at', line),
      toMs(r.cancelled_at, 'cancelled_at', line),
      String(r.updated_by ?? '').trim() || 'import',
      Number(r.is_spare) === 1 ? 1 : 0,
      Number(r.bundle) > 0 ? Number(r.bundle) : null, // missing in older exports and the sheet
    ];
  });

  const upsert = db.prepare(`
    INSERT INTO orders (${ORDER_COLS.join(', ')}) VALUES (${ORDER_COLS.map(() => '?').join(', ')})
    ON CONFLICT (id) DO UPDATE SET ${ORDER_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`);
  db.exec('BEGIN');
  try {
    if (mode === 'replace') db.exec('DELETE FROM orders');
    for (const values of clean) upsert.run(...values);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { imported: clean.length, mode };
}

function csv(rows) {
  const cols = ORDER_COLS;
  const iso = (v) => (v ? new Date(v).toISOString() : '');
  const lines = rows.map((r) =>
    cols.map((c) => (c.endsWith('_at') ? iso(r[c]) : String(r[c] ?? '')).replaceAll('"', '""'))
      .map((v) => `"${v}"`).join(',')
  );
  return '﻿' + [cols.join(','), ...lines].join('\n'); // BOM so Excel reads UTF-8
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const PAGES = {
  '/': 'index.html',
  '/server': 'role.html',
  '/cook': 'role.html',
  '/carrier': 'role.html',
  '/handoff': 'role.html',
  '/display': 'display.html',
  '/admin': 'admin.html',
  '/login': 'login.html',
};
// Pages that need the passcode (when one is set). /display stays public for the customer monitor.
const PROTECTED_PAGES = new Set(['/', '/server', '/handoff', '/cook', '/carrier', '/admin']);

// ---------------------------------------------------------------------------
// Passcode
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Browsers send the login cookie; scripts (simulator) may send the passcode in an X-Passcode header.
function isAuthed(req) {
  if (!PASSCODE) return true;
  const header = req.headers['x-passcode'];
  if (header && safeEqual(header, PASSCODE)) return true;
  const cookie = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  return Boolean(cookie) && safeEqual(cookie, AUTH_TOKEN);
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// Slow down guessing: 10 wrong passcodes from one address → locked out for 10 minutes.
const loginFailures = new Map(); // ip → { count, until }

function authCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  if (!PASSCODE) return json(res, 200, { ok: true });
  const ip = clientIp(req);
  const rec = loginFailures.get(ip);
  if (rec && rec.count >= 10 && Date.now() < rec.until) throw new HttpError(429, 'too_many_attempts');
  if (!safeEqual(String(body.passcode ?? ''), PASSCODE)) {
    const count = rec && Date.now() < rec.until ? rec.count + 1 : 1;
    loginFailures.set(ip, { count, until: Date.now() + 10 * 60_000 });
    throw new HttpError(401, 'wrong_passcode');
  }
  loginFailures.delete(ip);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': authCookie(req, AUTH_TOKEN, 60 * 60 * 24 * 14), // stays signed in for 2 weeks
  });
  res.end(JSON.stringify({ ok: true }));
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 64_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, 'too_large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function deviceOf(body) {
  return String(body.device || 'unknown').slice(0, 40);
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform stops proxies (e.g. a Cloudflare tunnel) from compressing — and so buffering — the stream.
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    // A comment line of padding first: some proxies hold back the first few KB before passing anything on.
    res.write(`:${' '.repeat(2048)}\n\n`);
    clients.set(res, {
      role: url.searchParams.get('role') || '?',
      name: url.searchParams.get('name') || '?',
      since: Date.now(),
    });
    req.on('close', () => {
      clients.delete(res);
      broadcast();
    });
    broadcast(); // new device appears in the admin device list; also delivers its first snapshot
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, snapshot());

  if (req.method === 'POST' && pathname === '/api/spares') {
    const body = await readBody(req);
    const result = makeSpare(deviceOf(body));
    broadcast();
    return json(res, 201, result);
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    // { products: [...] } is one customer's whole purchase (受付); { product } is a single order.
    if (Array.isArray(body.products)) {
      const orders = createOrders(body.products.map(String), deviceOf(body));
      broadcast();
      return json(res, 201, { orders });
    }
    const order = createOrder(String(body.product), deviceOf(body));
    broadcast();
    return json(res, 201, { order });
  }

  const m = pathname.match(/^\/api\/orders\/(\d+)\/transition$/);
  if (req.method === 'POST' && m) {
    const body = await readBody(req);
    const order = transition(Number(m[1]), body.from, body.to, deviceOf(body));
    broadcast();
    return json(res, 200, { order });
  }

  if (req.method === 'GET' && pathname === '/api/orders') {
    const day = Number(url.searchParams.get('day')) || getConfig().day;
    const rows = db.prepare(`SELECT * FROM orders WHERE day = ? ORDER BY id DESC`).all(day);
    return json(res, 200, { orders: rows });
  }

  if (req.method === 'GET' && pathname === '/api/backup-info') return json(res, 200, { sheetUrl: SHEETS_VIEW_URL });

  // Queue every order for the sheet — for orders created before the backup was set up, or a fresh sheet.
  // Help requests from staff screens (the cook's 「ヘルプを呼ぶ」). Shown on /admin until handled.
  if (req.method === 'POST' && pathname === '/api/help') {
    const body = await readBody(req);
    const device = deviceOf(body);
    let request = helpRequests.find((h) => h.device === device);
    if (!request) {
      request = { id: ++helpSeq, device, role: String(body.role || '?').slice(0, 20), at: Date.now() };
      helpRequests.push(request);
      console.log(`  🆘 HELP requested by ${device}`);
    }
    broadcast();
    return json(res, 201, { help: request });
  }

  const hm = pathname.match(/^\/api\/help\/(\d+)\/resolve$/);
  if (req.method === 'POST' && hm) {
    const i = helpRequests.findIndex((h) => h.id === Number(hm[1]));
    if (i >= 0) helpRequests.splice(i, 1);
    broadcast();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/reset-day') {
    const body = await readBody(req);
    const day = Number(body.day);
    if (!Number.isInteger(day) || day < 1) throw new HttpError(400, 'bad_day');
    const result = resetDay(day, deviceOf(body));
    broadcast();
    return json(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/api/backup-resend') {
    if (!SHEETS_URL) throw new HttpError(409, 'sheets_not_configured');
    const all = db.prepare(`SELECT * FROM orders ORDER BY id`).all();
    db.exec('BEGIN');
    for (const order of all) enqueueSync.run(JSON.stringify({ order }));
    db.exec('COMMIT');
    syncDelay = 0; // send right away instead of waiting out a back-off
    broadcast();
    return json(res, 200, { queued: all.length });
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    const day = Number(url.searchParams.get('day')) || getConfig().day;
    return json(res, 200, stats(day));
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    const cfg = getConfig();
    for (const key of Object.keys(cfg.products)) {
      const p = body.products?.[key];
      if (!p) continue;
      if (typeof p.name === 'string' && p.name.trim()) cfg.products[key].name = p.name.trim().slice(0, 30);
      // Price in yen: 綿飴's price for the first product, the extra charge for a topping. Blank = not set.
      if ('price' in p) {
        const yen = Number(p.price);
        cfg.products[key].price = p.price === '' || p.price == null ? null
          : Number.isInteger(yen) && yen >= 0 && yen < 100_000 ? yen : cfg.products[key].price;
      }
      // How many of this product sell per day. Blank = no limit of its own (only the daily total).
      if ('cap' in p) {
        const n = Number(p.cap);
        cfg.products[key].cap = p.cap === '' || p.cap == null ? null
          : Number.isInteger(n) && n >= 0 && n < 100_000 ? n : cfg.products[key].cap;
      }
    }
    const prev = { day: cfg.day, nextTicket: cfg.nextTicket };
    for (const key of ['day', 'nextTicket', 'backlogCount', 'backlogMinutes', 'dailyCap']) {
      const v = Number(body[key]);
      if (Number.isInteger(v) && v >= 0 && v < 100_000) cfg[key] = v;
    }
    // Switching day restarts ticket numbers, unless the admin also typed a specific number.
    if (cfg.day !== prev.day && cfg.nextTicket === prev.nextTicket) cfg.nextTicket = 1;
    saveConfig(cfg);
    broadcast();
    return json(res, 200, { config: cfg });
  }

  if (req.method === 'POST' && pathname === '/api/login') return handleLogin(req, res);

  if (req.method === 'POST' && pathname === '/api/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': authCookie(req, '', 0) });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && pathname === '/api/import') {
    const body = await readBody(req, 5_000_000); // a full two-day history is well under 1 MB
    const result = importOrders(body.rows, body.mode === 'replace' ? 'replace' : 'merge');
    broadcast();
    return json(res, 200, result);
  }

  if (req.method === 'GET' && pathname === '/api/export.csv') {
    const rows = db.prepare(`SELECT * FROM orders ORDER BY id`).all();
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="orders.csv"',
    });
    return res.end(csv(rows));
  }

  throw new HttpError(404, 'not_found');
}

async function handleStatic(req, res, url) {
  const file = PAGES[url.pathname] ?? url.pathname.slice(1);
  const publicDir = path.join(ROOT, 'public');
  const resolved = path.join(publicDir, path.normalize(file));
  if (!resolved.startsWith(publicDir + path.sep)) throw new HttpError(403, 'forbidden');
  try {
    const content = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    throw new HttpError(404, 'not_found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // Public: the live feed (the customer display needs it) and login/logout themselves.
      // /api/state is the polling fallback for the same feed, so it is public too (read-only).
      const open = (req.method === 'GET' && (url.pathname === '/api/events' || url.pathname === '/api/state'))
        || url.pathname === '/api/login' || url.pathname === '/api/logout';
      if (!open && !isAuthed(req)) throw new HttpError(401, 'unauthorized');
      await handleApi(req, res, url);
    } else if (PROTECTED_PAGES.has(url.pathname) && !isAuthed(req)) {
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname)}` });
      res.end();
    } else {
      await handleStatic(req, res, url);
    }
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) json(res, status, { error: err.code || 'server_error', ...(err.extra || {}) });
  }
});

// Most common start-up mistake: a server is already running (often in another terminal tab).
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n  ⚠ ポート ${PORT} はすでに使われています — サーバーがもう起動しています。`);
  console.error(`    起動中のサーバーのターミナルで Ctrl+C を押して止めてから、もう一度 npm start してください。`);
  console.error(`  ⚠ Port ${PORT} is already in use — a server is already running.`);
  console.error(`    Stop it with Ctrl+C in its terminal tab, then run npm start again.\n`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Candy Cloud 注文管理 running\n`);
  console.log(`  This machine : http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Other devices: ${u}`);
  console.log(`\n  Pages: /server  /cook  /carrier  /display  /admin`);
  console.log(`  Passcode     : ${PASSCODE ? 'on (STAFF_PASSCODE)' : 'off — anyone on this network can use every page'}`);
  console.log(`  Sheets backup: ${SHEETS_URL ? 'on (SHEETS_WEBHOOK_URL)' : 'off'}\n`);
});
