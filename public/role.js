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
let mainChosen = false;      // 受付: main product (綿飴) tapped; now choosing its topping
let makingSpare = false;
let helpBusy = false;
let lastCreated = null;          // { order, at } for the server's "hand over ticket #" callout

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

  const list = R.list();
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
  // Everything is on screen at once: the main product (綿飴) on the left with 「トッピングなし」 under it,
  // the toppings on the right. The toppings and 「トッピングなし」 unlock only after 綿飴 is selected.
  const [main, ...toppings] = Object.keys(products);
  // Daily caps: 300 cotton candy in total, 100 per topping. A topping is also limited by the cotton candy left.
  const sales = state.sales ?? { total: 0, byProduct: {}, dailyCap: Infinity, toppingCap: Infinity };
  const mainLeft = Math.max(0, sales.dailyCap - sales.total);
  const left = (k) => (k === main ? mainLeft
    : Math.min(mainLeft, Math.max(0, sales.toppingCap - (sales.byProduct[k] ?? 0))));
  const capLabel = (k) => (left(k) === 0 ? '本日分終了' : `残り ${left(k)}`);
  if (mainLeft === 0) mainChosen = false;
  if (selectedProduct && (left(selectedProduct) === 0 || !mainChosen)) selectedProduct = null;
  const split = (k) => products[k].name.split('/'); // "brand/日本語"
  const locked = !mainChosen || creating;
  const hint = (text) => (text ? `<small>${text}</small>` : '');
  // Prices (set in admin): 綿飴's price, plus each topping's extra charge. Hidden until set.
  const base = products[main].price;
  const total = (k) => (base == null ? null : k === main ? base : base + (products[k].price ?? 0));
  const priceTag = (k) => {
    if (k === main) return base == null ? '' : `<span class="pprice">${yen(base)}</span>`;
    return products[k].price == null ? '' : `<span class="pprice">+${yen(products[k].price)}</span>`;
  };

  const option = (k, label, sub, cls = '') => `
    <button class="product-btn p${k} ${cls} ${selectedProduct === k ? 'selected' : ''}" data-action="select" data-product="${k}"
            ${left(k) === 0 || locked ? 'disabled' : ''}>
      <span class="pname">${esc(label)}</span>${sub ? `<span class="psub">${esc(sub)}</span>` : ''}
      ${priceTag(k)}
      ${hint(left(k) === 0 ? '本日分終了' : !mainChosen || selectedProduct === k ? '' : 'タップして選択')}
      ${left(k) === 0 ? '' : `<span class="pleft">${capLabel(k)}</span>`}
    </button>`;

  const [brand, ja] = split(main);
  const buttons = `
    <div class="order-main">
      <button class="product-btn main-btn p${main} ${mainChosen ? 'selected' : ''}" data-action="main"
              ${mainLeft === 0 || creating ? 'disabled' : ''}>
        <span class="pname">${esc(brand)}</span>${ja ? `<span class="psub">${esc(ja)}</span>` : ''}
        ${priceTag(main)}
        ${hint(mainLeft === 0 ? '本日分終了' : '')}
        ${mainLeft === 0 ? '' : `<span class="pleft">本日 ${sales.total} / ${sales.dailyCap}・残り ${mainLeft}</span>`}
      </button>
      ${option(main, 'トッピングなし', ja ? `${ja}のみ` : '', 'plain-btn')}
    </div>
    <div class="order-toppings">
      ${toppings.map((k) => option(k, ...split(k))).join('')}
    </div>`;

  // Last step: confirm (or back out) before the order is registered.
  const toppingLabel = selectedProduct === main ? 'トッピングなし' : selectedProduct ? products[selectedProduct].name : '';
  const confirmBar = selectedProduct ? `
    <div class="confirm-bar">
      <div class="confirm-text"><span class="chip p${main}">${esc(split(main)[0])}</span> ＋
        <span class="chip p${selectedProduct}">${esc(toppingLabel)}</span> を注文しますか？
        ${total(selectedProduct) == null ? '' : `<div class="confirm-total">合計 <b>${yen(total(selectedProduct))}</b></div>`}</div>
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
        <b>#${pad(order.ticket_no)}</b>
        <div style="font-size:16px;opacity:.8">${esc(productName(order))}</div>
        ${total(order.product) == null ? '' : `<div class="callout-price">お会計 ${yen(total(order.product))}</div>`}
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
    </div>`);
}

// --- 受け渡し (handoff) ----------------------------------------------------
// Orders waiting at the counter. The topping is shown large: it is added here, just before handing over.
function renderHandoff(list) {
  setHTML(right, `
    <h2>お渡し待ち (${list.length})</h2>
    ${list.map(handoffCard).join('')
      || '<p class="empty-note">運搬済みの注文が届くとここに表示されます</p>'}`);
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
    <div class="card big handoff-card ${isNew ? 'new' : ''}">
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
         <span>🆘 ヘルプ要請中… <small>管理者の対応を待っています</small></span>
         <button class="btn secondary" data-action="help-cancel" data-help="${mine.id}" type="button">取消</button>
       </div>`
    : `<div class="help-bar"><button class="btn help-btn wide" data-action="help" type="button" ${helpBusy ? 'disabled' : ''}>
         🆘 ヘルプを呼ぶ</button></div>`;
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
    if (lastCreated?.order.id === order.id) lastCreated = null;
    toast(`#${pad(order.ticket_no)} を取り消しました`);
  }
});

right.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !state) return;
  const id = Number(el.dataset.id);
  const order = state.active.find((o) => o.id === id);

  switch (el.dataset.action) {
    case 'main':
      mainChosen = !mainChosen; // tap again to deselect
      selectedProduct = null;
      return render();
    case 'select':
      selectedProduct = selectedProduct === el.dataset.product ? null : el.dataset.product;
      return render();
    case 'unselect':
      selectedProduct = null;
      mainChosen = false;
      return render();
    case 'create':
      selectedProduct = null;
      mainChosen = false;
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
  if (r.ok) toast('ヘルプを呼びました — 管理画面に通知されています');
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
    // No timed undo here: every order has its own 取消 button in the progress list on the left.
    toast(`#${pad(order.ticket_no)} ${productName(order)} を登録しました`);
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
