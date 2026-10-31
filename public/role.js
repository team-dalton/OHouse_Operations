// One script for the three staff screens. Left pane is shared; right pane depends on the role.
import {
  FLOW, ROLE_LABEL, STATUS_LABEL, beep, connect, deviceName, errorMessage, esc, groupBundles, pad, post,
  progressHTML, setHTML, startElapsedTicker, startOverlay, toast, transition,
} from './common.js';

const role = location.pathname.replaceAll('/', '');
const device = deviceName(role);
const left = document.getElementById('left');
const right = document.getElementById('right');

document.title = `Candy Cloud — ${ROLE_LABEL[role]}`;
document.getElementById('role-label').textContent = ROLE_LABEL[role];
document.getElementById('device-label').textContent = device;

let state = null;
const busy = new Set();          // order ids with a request in flight
const selected = new Set();      // carrier multi-select
const flashUntil = new Map();    // order id → timestamp; cards flash while new
let seen = null;                 // ids already shown in this role's action list
let creating = false;
let cart = {}; // 受付: product → how many, for the customer at the counter; not yet confirmed
let makingSpare = false;
let helpBusy = false;
// Instant feedback for 完成 / お渡し完了: the card slides out right away (completing) and then stays hidden
// (finished) without waiting for the server's next update, so it can't be tapped twice.
const completing = new Set();
const finished = new Set();
let lastCreated = null;          // { orders, at } for the server's "hand over ticket #" callout

const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
const productName = (o) => state.config.products[o.product]?.name ?? o.product;

// Each role acts on orders in one status, and moves them to the next one.
const ROLES = {
  // 受付 only takes orders now (its list stays empty, so it never beeps for arrivals).
  server: { acts: 'ordered', to: null, sound: [1047, 0.15, 2], render: renderServer, list: () => [] },
  // 受け渡し: the second person at the counter hands finished orders to customers.
  handoff: { acts: 'delivered', to: 'completed', sound: [1047, 0.15, 2], render: renderHandoff },
  cook: { acts: 'ordered', to: 'made', sound: [660, 0.12, 1], render: renderCook },
  // The carrier moves spares too: they need to reach the counter just like orders.
  carrier: {
    acts: 'made', to: 'delivered', sound: [880, 0.12, 2], render: renderCarrier,
    list: () => [...state.active, ...(state.spares ?? [])].filter((o) => o.status === 'made')
      .sort((a, b) => a.made_at - b.made_at),
  },
};
for (const r of Object.values(ROLES)) r.list ??= () => state.active.filter((o) => o.status === r.acts);
const R = ROLES[role];

const tick = startElapsedTicker(() => state?.config.backlogMinutes ?? 10);
startOverlay(`${ROLE_LABEL[role]} 画面`);
connect({ role, name: device, onState: (s) => { state = s; render(); } });

// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  setHTML(left, progressHTML(state, R.acts, { cancel: role === 'server' }));

  const all = R.list();
  for (const id of finished) if (!all.some((o) => o.id === id)) finished.delete(id); // server caught up
  const list = all.filter((o) => !finished.has(o.id));
  // An order this screen was working on got cancelled elsewhere (e.g. at 受付): say so, loudly.
  if (seen && role !== 'server') {
    const gone = (state.recentCancelled ?? []).filter((o) => seen.has(o.id));
    for (const o of gone) {
      toast(`#${pad(o.ticket_no)} は取り消されました`, { kind: 'error', ms: 8000 });
      beep(440, 0.25, 2);
    }
  }
  if (seen) {
    const fresh = list.filter((o) => !seen.has(o.id));
    if (fresh.length) beep(...R.sound);
    for (const o of fresh) flashUntil.set(o.id, Date.now() + 3000);
  }
  seen = new Set(list.map((o) => o.id));

  R.render(list);
  tick();
}

// Spares (予備) have no ticket or topping yet.
const isSpare = (o) => o.ticket_no == null;

function card(o, { label, big = false, selectable = false, showProduct = true } = {}) {
  const isNew = (flashUntil.get(o.id) ?? 0) > Date.now();
  const cls = ['card', big && 'big', isNew && 'new', completing.has(o.id) && 'completing', selectable && 'selectable', selected.has(o.id) && 'selected',
    isSpare(o) && 'spare'].filter(Boolean).join(' ');
  const attrs = selectable ? `data-action="toggle" data-id="${o.id}"` : '';
  return `
    <div class="${cls}" ${attrs}>
      ${selectable ? '<span class="check">✓</span>' : ''}
      <span class="tno">${isSpare(o) ? '予備' : `#${pad(o.ticket_no)}`}</span>
      <div class="meta">
        ${isSpare(o) ? '<span class="chip spare">注文なし</span>'
          : showProduct ? `<span class="chip p${esc(o.product)}">${esc(productName(o))}</span>` : ''}
        ${bundleTag(o)}
        <span>${isSpare(o) ? '作成から' : '待ち'}
          <span class="elapsed" data-since="${isSpare(o) ? o.made_at : o.created_at}"></span></span>
      </div>
      ${label ? `<button class="btn ${big ? 'big' : ''}" data-action="advance" data-id="${o.id}"
                 ${busy.has(o.id) ? 'disabled' : ''}>${label}</button>` : ''}
    </div>`;
}

// One customer's several orders: "まとめ 2/4" = the 2nd of that customer's 4 食券.
function bundleMembers(o) {
  return (state.bundles?.[o.bundle] ?? []).filter((m) => m.status !== 'cancelled');
}
function bundleTag(o) {
  if (o.bundle == null) return '';
  const all = bundleMembers(o);
  const i = all.findIndex((m) => m.id === o.id);
  return all.length > 1 && i >= 0 ? `<span class="bundle-tag">まとめ ${i + 1}/${all.length}</span>` : '';
}

// --- 受付・受渡 (server) ----------------------------------------------------
function renderServer(list) {
  const { products } = state.config;
  const { pending, estWaitMin } = state.queue;
  // Four combined buttons: 綿飴 on its own, or 綿飴 + one topping. Each tap adds one to the customer's cart;
  // the cart below can be changed (− / ＋, やめる) until 注文を確定 registers it all at once.
  const keys = Object.keys(products);
  const [main] = keys;
  // Daily caps: 300 cotton candy in total, and each product's own cap (set in admin; none = only the total).
  const sales = state.sales ?? { total: 0, byProduct: {}, dailyCap: Infinity };
  const mainLeft = Math.max(0, sales.dailyCap - sales.total);
  const ownLeft = (k) => (products[k].cap == null ? Infinity : Math.max(0, products[k].cap - (sales.byProduct[k] ?? 0)));
  const left = (k) => Math.min(mainLeft, ownLeft(k));
  const count = () => Object.values(cart).reduce((a, n) => a + n, 0);
  // How many more of k this customer can add, after what is already in the cart.
  const room = (k) => Math.min(mainLeft - count(), ownLeft(k) - (cart[k] ?? 0));
  // Sold out meanwhile (another 受付): trim the cart to what is left.
  for (const k of keys) {
    if (room(k) < 0) cart[k] += room(k);
    if (!(cart[k] > 0)) delete cart[k];
  }
  const split = (k) => products[k].name.split('/'); // "brand/日本語"
  const ja = (k) => split(k)[1] || split(k)[0];
  const brand = (k) => split(k)[0];
  // Prices (set in admin): 綿飴's price, plus each topping's extra charge. Hidden until set.
  const base = products[main].price;
  const total = (k) => (base == null ? null : k === main ? base : base + (products[k].price ?? 0));
  const sum = (ks) => (base == null ? null : ks.reduce((a, k) => a + total(k), 0));
  const label = (k) => (k === main ? 'トッピングなし' : ja(k)); // short, so a cart line fits on a phone

  const combo = (k) => `
    <button class="product-btn combo-btn ${cart[k] ? 'selected' : ''}" data-action="add" data-product="${k}"
            ${room(k) <= 0 || creating ? 'disabled' : ''}>
      ${cart[k] ? `<span class="pqty">×${cart[k]}</span>` : ''}
      <span class="pdots"><i style="background:var(--p${k})"></i></span>
      <span class="pname">${k === main ? 'トッピングなし' : `${esc(brand(main))} <span class="nowrap">＋ ${esc(brand(k))}</span>`}</span>
      <span class="psub">${esc(ja(main))}${k === main ? '' : ` <span class="nowrap">＋ ${esc(ja(k))}</span>`}</span>
      ${total(k) == null ? '' : `<span class="pprice">${yen(total(k))}</span>`}
      ${left(k) === 0 ? '<span class="pleft">本日分終了</span>'
        : products[k].cap == null ? '' : `<span class="pleft">残り ${left(k)}</span>`}
    </button>`;
  const buttons = keys.map(combo).join('');
  // How much cotton candy is left today, out of the daily cap (e.g. 292 / 300). Toppings show their own 残り.
  const stock = Number.isFinite(sales.dailyCap)
    ? `<div class="stock-total ${mainLeft === 0 ? 'out' : ''}">本日の総数 <b>${mainLeft}</b> / ${sales.dailyCap}</div>`
    : '';

  // Last step: check the cart with the customer (fix it with − / ＋), then confirm or back out.
  const items = keys.filter((k) => cart[k]);
  const all = items.flatMap((k) => Array(cart[k]).fill(k));
  const confirmBar = items.length ? `
    <div class="confirm-bar">
      <ul class="cart">${items.map((k) => `
        <li>
          <span class="chip p${k}">${esc(label(k))}</span>
          ${total(k) == null ? '' : `<span class="cart-price">${yen(total(k) * cart[k])}</span>`}
          <span class="stepper">
            <button data-action="dec" data-product="${k}" type="button" ${creating ? 'disabled' : ''} aria-label="1つ減らす">−</button>
            <b>${cart[k]}</b>
            <button data-action="inc" data-product="${k}" type="button" ${room(k) <= 0 || creating ? 'disabled' : ''} aria-label="1つ増やす">＋</button>
          </span>
        </li>`).join('')}
      </ul>
      <div class="confirm-total">合計 <b>${all.length}</b>個${sum(all) == null ? '' : ` <b>${yen(sum(all))}</b>`}</div>
      <div class="confirm-actions">
        <button class="btn secondary" data-action="clear" type="button">やめる</button>
        <button class="btn big" data-action="create" type="button" ${creating ? 'disabled' : ''}>注文を確定</button>
      </div>
    </div>` : '';

  let callout = '';
  if (lastCreated) {
    const { orders } = lastCreated;
    const faded = Date.now() - lastCreated.at > 15_000;
    // Spares: an order may already be at the counter or on its way.
    const ready = orders.filter((o) => o.status === 'delivered').length;
    const onWay = orders.filter((o) => o.status === 'made').length;
    const note = [
      ready && `予備を使用 — ${orders.length > 1 ? `${ready}個は` : ''}すぐにお渡しできます`,
      onWay && `予備を使用 — ${orders.length > 1 ? `${onWay}個は` : ''}運搬中です`,
    ].filter(Boolean).map((t) => `<div class="callout-note">${t}</div>`).join('');
    const what = keys
      .map((k) => [k, orders.filter((o) => o.product === k).length]).filter(([, n]) => n)
      .map(([k, n]) => `<span class="nowrap">${esc(label(k))}${orders.length > 1 ? ` ×${n}` : ''}</span>`).join('・');
    const price = sum(orders.map((o) => o.product).filter((k) => products[k]));
    callout = `
      <div class="callout ${faded ? 'fade' : ''} ${orders.length > 1 ? 'multi' : ''}">
        <b>${orders.map((o) => `<span>#${pad(o.ticket_no)}</span>`).join(' ')}</b>
        <div style="font-size:16px;opacity:.8">${what}</div>
        ${price == null ? '' : `<div class="callout-price">お会計 ${yen(price)}</div>`}
        ${note}
      </div>`;
  }

  const { sparesReady, sparesMade } = state.queue;
  const spareInfo = sparesReady + sparesMade
    ? `<div class="spare-banner ${sparesReady ? 'ready' : ''}">
         予備 — 受け取り口 <b>${sparesReady}</b>個 / 運搬中 <b>${sparesMade}</b>個
         ${sparesReady ? '<small>次の注文はすぐにお渡しできます</small>' : ''}
       </div>`
    : '';

  setHTML(right, `
    <div class="section">
      <h2>新規注文 <small style="font-weight:400;color:var(--muted);font-size:14px">
        現在 ${pending}件待ち・約${estWaitMin}分</small></h2>
      ${spareInfo}
      <div class="product-buttons">${buttons}</div>
      ${stock}
      ${confirmBar}
      ${confirmBar ? '' : callout}
    </div>`);
}

// --- 受け渡し (handoff) ----------------------------------------------------
// Orders waiting at the counter. The topping is shown large: it is added here, just before handing over.
function renderHandoff(list) {
  setHTML(right, `
    <h2>お渡し待ち (${list.length})</h2>
    ${groupBundles(list).map((g) => (g.bundle == null ? handoffCard(g[0]) : handoffBundle(g))).join('')
      || '<p class="empty-note">運搬済みの注文が届くとここに表示されます</p>'}`);
}

// One customer's 食券 together, with the ones not at the counter yet named, so they are handed over as a set.
function handoffBundle(g) {
  const all = bundleMembers(g[0]);
  const NOT_YET = { ordered: '調理待ち', made: '運搬中' };
  const missing = all.filter((m) => NOT_YET[m.status]);
  const handed = all.filter((m) => m.status === 'completed').length;
  const status = missing.length
    ? `<span class="bundle-wait">まだ ${missing.map((m) => `<span class="nowrap">#${pad(m.ticket_no)} ${NOT_YET[m.status]}</span>`).join('・')}</span>`
    : '<span class="bundle-all">全部そろいました</span>';
  return `
    <div class="bundle-box">
      <div class="bundle-head">
        <span>1名様分 <b>${all.length}</b>枚${handed ? `<small>・お渡し済 ${handed}</small>` : ''}</span>
        ${status}
      </div>
      ${g.map(handoffCard).join('')}
    </div>`;
}

// Spells out exactly what to hand over: the cotton candy, then the topping to add (or none).
function handoffCard(o) {
  const { products } = state.config;
  const [main] = Object.keys(products);
  const [mainBrand, mainJa] = products[main].name.split('/');
  const [brand, ja] = (products[o.product]?.name ?? o.product).split('/');
  const isNew = (flashUntil.get(o.id) ?? 0) > Date.now();
  const topping = o.product === main
    ? '<div class="give-topping none">トッピングなし</div>'
    : `<div class="give-topping p${esc(o.product)}"><i></i>＋ ${esc(ja ?? brand)}${ja ? ` <small>${esc(brand)}</small>` : ''}</div>`;
  return `
    <div class="card big handoff-card ${isNew ? 'new' : ''} ${completing.has(o.id) ? 'completing' : ''}">
      <span class="tno">#${pad(o.ticket_no)}</span>
      <div class="give">
        <div class="give-main">${esc(mainJa ?? mainBrand)} <small>${esc(mainBrand)}</small></div>
        ${topping}
        <span class="give-wait">待ち <span class="elapsed" data-since="${o.created_at}"></span></span>
      </div>
      <button class="btn big" data-action="advance" data-id="${o.id}" ${busy.has(o.id) ? 'disabled' : ''}>お渡し完了</button>
    </div>`;
}

// --- 調理 (cook) -----------------------------------------------------------
// Toppings go on at the counter, so the cook only sees order numbers — every cotton candy is the same.
function renderCook(list) {
  const [first, ...rest] = list;

  // With orders waiting, 完成 is the button. With none waiting, the cook can make 予備 ahead of time.
  const spareSection = `
    <div class="spare-maker">
      <button class="btn big wide spare-btn" data-action="spare" ${makingSpare ? 'disabled' : ''}>
        予備を1つ作った (+1)
      </button>
    </div>`;

  setHTML(right, `
    ${helpButton()}
    <h2>調理待ち (${list.length})</h2>
    ${first
      ? card(first, { label: '完成', big: true, showProduct: false })
      : `<p class="empty-note">調理待ちの注文はありません<br>手が空いたら予備を作れます</p>${spareSection}`}
    ${rest.length ? `<h3>次の注文</h3>${rest.map((o) => card(o, { label: '完成', showProduct: false })).join('')}` : ''}`);
}

// Help: the cook can call the admin. While a request is open, the button shows it and can cancel it.
function helpButton() {
  const mine = (state.help ?? []).find((h) => h.device === device);
  return mine
    ? `<div class="help-bar active">
         <span>📣 会計・先生を呼び出し中…</span>
         <button class="help-cancel" data-action="help-cancel" data-help="${mine.id}" type="button">取消</button>
       </div>`
    : `<div class="help-bar"><button class="help-btn" data-action="help" type="button" ${helpBusy ? 'disabled' : ''}>
         📣 会計・先生を呼ぶ</button></div>`;
}

// --- 運搬 (carrier) --------------------------------------------------------
function renderCarrier(list) {
  for (const id of selected) if (!list.some((o) => o.id === id)) selected.delete(id);
  const n = selected.size;
  const anyBusy = list.some((o) => busy.has(o.id));
  const label = n ? `選択した ${n}件を運搬完了` : `すべて (${list.length}件) 運搬完了`;
  const spareCount = list.filter(isSpare).length;

  setHTML(right, `
    <h2>運搬待ち (${list.length})${spareCount ? ` <small style="font-weight:400;color:var(--muted)">うち予備 ${spareCount}</small>` : ''}</h2>
    ${list.length ? `
      ${list.map((o) => card(o, { selectable: true })).join('')}
      <button class="btn big wide" data-action="carry" ${anyBusy ? 'disabled' : ''}>${label}</button>`
    : '<p class="empty-note">運ぶ注文はありません</p>'}`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// 受付: cancel any order from the progress list (asks first, so a stray tap can't cancel one).
left.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action=cancel]');
  if (!el || !state) return;
  const order = state.active.find((o) => o.id === Number(el.dataset.id));
  if (!order || !confirm(`#${pad(order.ticket_no)} ${productName(order)} を取り消しますか？`)) return;
  const done = await moveTo([order], 'cancelled');
  if (done.length) {
    if (lastCreated) {
      lastCreated.orders = lastCreated.orders.filter((o) => o.id !== order.id);
      if (!lastCreated.orders.length) lastCreated = null;
    }
    toast(`#${pad(order.ticket_no)} を取り消しました`);
  }
});

right.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !state) return;
  const id = Number(el.dataset.id);
  const order = state.active.find((o) => o.id === id);

  switch (el.dataset.action) {
    case 'add': // a product button: one more of it (render() disables it when the caps are reached)
    case 'inc':
      cart[el.dataset.product] = (cart[el.dataset.product] ?? 0) + 1;
      return render();
    case 'dec':
      if (!(--cart[el.dataset.product] > 0)) delete cart[el.dataset.product];
      return render();
    case 'clear':
      cart = {};
      return render();
    case 'create': {
      // The cart is kept until the server accepts it, so a failed request (e.g. sold out) can be fixed and retried.
      const products = Object.keys(state.config.products).flatMap((k) => Array(cart[k] ?? 0).fill(k));
      return createOrders(products);
    }
    case 'advance':
      if (!order || completing.has(order.id)) return;
      completing.add(order.id); // slide out now…
      setTimeout(() => { completing.delete(order.id); finished.add(order.id); render(); }, 250); // …then hide
      return advance([order], R.to);
    case 'toggle':
      selected.has(id) ? selected.delete(id) : selected.add(id);
      return render();
    case 'carry': {
      const list = R.list();
      const targets = selected.size ? list.filter((o) => selected.has(o.id)) : list;
      selected.clear();
      return advance(targets, 'delivered');
    }
    case 'help':
      return callHelp();
    case 'help-cancel':
      return post(`/api/help/${el.dataset.help}/resolve`, { device }).then(render);
    case 'spare':
      return makeSpare();
  }
});

async function callHelp() {
  helpBusy = true;
  render();
  const r = await post('/api/help', { device, role });
  helpBusy = false;
  if (r.ok) toast('会計・先生を呼びました');
  else toast(errorMessage(r), { kind: 'error' });
  render();
}

async function makeSpare() {
  makingSpare = true;
  render();
  const r = await post('/api/spares', { device });
  makingSpare = false;
  if (!r.ok) {
    toast(errorMessage(r), { kind: 'error' });
  } else if (r.data.assigned) {
    // An order arrived just before the tap — the candy went straight to it.
    const o = r.data.assigned;
    toast(`注文 #${pad(o.ticket_no)} に割り当てました`, {
      action: '取り消す', ms: 10_000, onAction: () => moveTo([o], 'ordered'),
    });
  } else {
    const s = r.data.spare;
    beep(1200, 0.08);
    toast('予備を1つ登録しました', {
      action: '取り消す', ms: 10_000, onAction: () => moveTo([s], 'cancelled'),
    });
  }
  render();
}

// One customer's whole cart: one order (and number) per cotton candy, registered together.
async function createOrders(products) {
  if (!products.length) return;
  creating = true;
  render();
  const r = await post('/api/orders', { products, device });
  creating = false;
  if (!r.ok) {
    toast(errorMessage(r), { kind: 'error' });
  } else {
    const { orders } = r.data;
    cart = {};
    lastCreated = { orders, at: Date.now() };
    beep(1200, 0.08);
    // No timed undo here: every order has its own 取消 button in the progress list on the left.
    toast(orders.length === 1
      ? `#${pad(orders[0].ticket_no)} ${productName(orders[0])} を登録しました`
      : `${orders.map((o) => `#${pad(o.ticket_no)}`).join(' ')} (${orders.length}個) を登録しました`);
    setTimeout(render, 15_500); // fade the callout
  }
  render();
}

async function advance(orders, to) {
  if (!orders.length) return;
  const back = FLOW[FLOW.indexOf(to) - 1];
  const done = await moveTo(orders, to);
  // Anything that didn't go through (e.g. another device got there first) comes back on screen.
  for (const o of orders) {
    if (!done.some((d) => d.id === o.id)) { completing.delete(o.id); finished.delete(o.id); }
  }
  render();
  if (done.length) {
    toast(`${done.map((o) => (isSpare(o) ? '予備' : `#${pad(o.ticket_no)}`)).join(' ')} → ${STATUS_LABEL[to]}`, {
      action: '取り消す',
      ms: 10_000,
      onAction: () => { done.forEach((o) => finished.delete(o.id)); return moveTo(done, back); },
    });
  }
}

// Sends compare-and-set transitions; returns the orders that actually moved.
async function moveTo(orders, to, onSuccess) {
  orders.forEach((o) => busy.add(o.id));
  render();
  const results = await Promise.all(orders.map((o) => transition(o, to, device)));
  orders.forEach((o) => busy.delete(o.id));

  const failed = results.find((r) => !r.ok);
  if (failed) toast(errorMessage(failed), { kind: 'error' });
  const done = results.filter((r) => r.ok).map((r) => r.data.order);
  if (done.length) onSuccess?.();
  render();
  return done;
}
