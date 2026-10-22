// One script for the three staff screens. Left pane is shared; right pane depends on the role.
import {
  FLOW, ROLE_LABEL, STATUS_LABEL, beep, connect, deviceName, errorMessage, esc, pad, post,
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
let selectedProduct = null; // 受付: product tapped but not yet confirmed
let makingSpare = false;
let lastCreated = null;          // { order, at } for the server's "hand over ticket #" callout

const productName = (o) => state.config.products[o.product]?.name ?? o.product;

// Each role acts on orders in one status, and moves them to the next one.
const ROLES = {
  server: { acts: 'delivered', to: 'completed', sound: [1047, 0.15, 2], render: renderServer },
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
  setHTML(left, progressHTML(state, R.acts));

  const list = R.list();
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
  const cls = ['card', big && 'big', isNew && 'new', selectable && 'selectable', selected.has(o.id) && 'selected',
    isSpare(o) && 'spare'].filter(Boolean).join(' ');
  const attrs = selectable ? `data-action="toggle" data-id="${o.id}"` : '';
  return `
    <div class="${cls}" ${attrs}>
      ${selectable ? '<span class="check">✓</span>' : ''}
      <span class="tno">${isSpare(o) ? '予備' : `#${pad(o.ticket_no)}`}</span>
      <div class="meta">
        ${isSpare(o) ? '<span class="chip spare">注文なし</span>'
          : showProduct ? `<span class="chip p${esc(o.product)}">${esc(productName(o))}</span>` : ''}
        <span>${isSpare(o) ? '作成から' : '待ち'}
          <span class="elapsed" data-since="${isSpare(o) ? o.made_at : o.created_at}"></span></span>
      </div>
      ${label ? `<button class="btn ${big ? 'big' : ''}" data-action="advance" data-id="${o.id}"
                 ${busy.has(o.id) ? 'disabled' : ''}>${label}</button>` : ''}
    </div>`;
}

// --- 受付・受渡 (server) ----------------------------------------------------
function renderServer(list) {
  const { products } = state.config;
  const { pending, estWaitMin } = state.queue;
  if (selectedProduct && products[selectedProduct]?.soldOut) selectedProduct = null;
  const buttons = Object.keys(products).map((k) => {
    // Names are "brand/日本語"; show the brand large and the Japanese underneath.
    const [main, sub] = products[k].name.split('/');
    return `
    <button class="product-btn p${k} ${selectedProduct === k ? 'selected' : ''}" data-action="select" data-product="${k}"
            ${products[k].soldOut || creating ? 'disabled' : ''}>
      <span class="pname">${esc(main)}</span>${sub ? `<span class="psub">${esc(sub)}</span>` : ''}
      <small>${products[k].soldOut ? '売り切れ' : selectedProduct === k ? '選択中' : 'タップして選択'}</small>`;
  }).map((html) => `${html}
    </button>`).join('');

  // Second step: confirm (or back out) before the order is registered.
  const confirmBar = selectedProduct ? `
    <div class="confirm-bar">
      <div class="confirm-text"><span class="chip p${selectedProduct}">${esc(products[selectedProduct].name)}</span> を注文しますか？</div>
      <div class="confirm-actions">
        <button class="btn secondary" data-action="unselect" type="button">やめる</button>
        <button class="btn big" data-action="create" data-product="${selectedProduct}" type="button" ${creating ? 'disabled' : ''}>注文を確定</button>
      </div>
    </div>` : '';

  let callout = '';
  if (lastCreated) {
    const { order } = lastCreated;
    const faded = Date.now() - lastCreated.at > 15_000;
    const note = {
      delivered: '<div class="callout-note">予備を使用 — すぐにお渡しできます</div>',
      made: '<div class="callout-note">予備を使用 — 運搬中です</div>',
    }[order.status] ?? '';
    callout = `
      <div class="callout ${faded ? 'fade' : ''}">
        食券<b>#${pad(order.ticket_no)}</b>を渡してください
        <div style="font-size:16px;opacity:.8">${esc(productName(order))}</div>
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
      ${confirmBar}
      ${confirmBar ? '' : callout}
    </div>
    <div class="section">
      <h2>お渡し待ち (${list.length})</h2>
      ${list.map((o) => card(o, { label: 'お渡し完了' })).join('')
        || '<p class="empty-note">運搬済みの注文が届くとここに表示されます</p>'}
    </div>`);
}

// --- 調理 (cook) -----------------------------------------------------------
// Toppings go on at the counter, so the cook only sees order numbers — every cotton candy is the same.
function renderCook(list) {
  const [first, ...rest] = list;
  const { sparesReady, sparesMade } = state.queue;

  // With orders waiting, 完成 is the button. With none waiting, the cook can make 予備 ahead of time.
  const spareSection = `
    <div class="spare-maker">
      <button class="btn big wide spare-btn" data-action="spare" ${makingSpare ? 'disabled' : ''}>
        予備を1つ作った (+1)
      </button>
      <p>予備の在庫: 運搬待ち <b>${sparesMade}</b>個 / 受け取り口 <b>${sparesReady}</b>個</p>
    </div>`;

  setHTML(right, `
    <h2>調理待ち (${list.length})</h2>
    ${first
      ? card(first, { label: '完成', big: true, showProduct: false })
      : `<p class="empty-note">調理待ちの注文はありません<br>手が空いたら予備を作れます</p>${spareSection}`}
    ${rest.length ? `<h3>次の注文</h3>${rest.map((o) => card(o, { label: '完成', showProduct: false })).join('')}` : ''}`);
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
      <p style="color:var(--muted);margin:0 0 10px">タップで選択。選択なしの場合は全件が対象です。</p>
      ${list.map((o) => card(o, { selectable: true })).join('')}
      <button class="btn big wide" data-action="carry" ${anyBusy ? 'disabled' : ''}>${label}</button>`
    : '<p class="empty-note">運ぶ注文はありません</p>'}`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

right.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !state) return;
  const id = Number(el.dataset.id);
  const order = state.active.find((o) => o.id === id);

  switch (el.dataset.action) {
    case 'select':
      selectedProduct = selectedProduct === el.dataset.product ? null : el.dataset.product;
      return render();
    case 'unselect':
      selectedProduct = null;
      return render();
    case 'create':
      selectedProduct = null;
      return createOrder(el.dataset.product);
    case 'advance':
      return order && advance([order], R.to);
    case 'toggle':
      selected.has(id) ? selected.delete(id) : selected.add(id);
      return render();
    case 'carry': {
      const list = R.list();
      const targets = selected.size ? list.filter((o) => selected.has(o.id)) : list;
      selected.clear();
      return advance(targets, 'delivered');
    }
    case 'spare':
      return makeSpare();
  }
});

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

async function createOrder(product) {
  creating = true;
  render();
  const r = await post('/api/orders', { product, device });
  creating = false;
  if (!r.ok) {
    toast(errorMessage(r), { kind: 'error' });
  } else {
    const order = r.data.order;
    lastCreated = { order, at: Date.now() };
    beep(1200, 0.08);
    toast(`#${pad(order.ticket_no)} ${productName(order)} を登録しました`, {
      action: '取り消す',
      ms: 10_000,
      onAction: () => moveTo([order], 'cancelled', () => {
        if (lastCreated?.order.id === order.id) lastCreated = null;
      }),
    });
    setTimeout(render, 15_500); // fade the callout
  }
  render();
}

async function advance(orders, to) {
  if (!orders.length) return;
  const back = FLOW[FLOW.indexOf(to) - 1];
  const done = await moveTo(orders, to);
  if (done.length) {
    toast(`${done.map((o) => (isSpare(o) ? '予備' : `#${pad(o.ticket_no)}`)).join(' ')} → ${STATUS_LABEL[to]}`, {
      action: '取り消す',
      ms: 10_000,
      onAction: () => moveTo(done, back),
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
