// Customer-facing call screen (TV on the host laptop). Read-only.
import { beep, connect, esc, pad, setHTML, startOverlay } from './common.js';

const readyEl = document.getElementById('ready');
const banner = document.getElementById('banner');
const clock = document.getElementById('clock');

const flashUntil = new Map();
let seen = null;

// --- Live tracker (準備中) ----------------------------------------------------
// Rows are kept and updated in place (not re-rendered), so CSS can animate an order moving to its next step.
const STEPS = ['受付', '調理', '運搬', 'お渡し'];
const ACTIVE_STEP = { ordered: 1, made: 2 }; // 受付 is done once ordered; the active dot is where the order is now
const trkList = document.getElementById('trk-list');
const trkViewport = document.getElementById('trk-viewport');
const trkPages = document.getElementById('trk-pages');
const trkEmpty = document.getElementById('trk-empty');
const rows = new Map(); // order id → { el, status }
let page = 0;
let trackerReady = false; // rows present when the screen first loads appear without the slide-in

function makeRow(o, products) {
  const el = document.createElement('div');
  el.className = 'trk-row';
  el.style.setProperty('--dot', `var(--p${o.product})`);
  el.innerHTML = `
    <div class="trk-no">${pad(o.ticket_no)}<small>${esc(products[o.product]?.name ?? o.product)}</small></div>
    <div class="trk-track"><span class="trk-fill"></span>${STEPS.map((s) => `<span class="trk-step"><i></i>${s}</span>`).join('')}</div>`;
  return el;
}

function setStep(el, k) {
  el.style.setProperty('--k', k);
  el.querySelectorAll('.trk-step').forEach((s, i) => {
    s.classList.toggle('done', i < k);
    s.classList.toggle('active', i === k);
  });
}

function renderTracker(pending, products) {
  const ids = new Set(pending.map((o) => o.id));

  // Ready or cancelled: slide out, then remove.
  for (const [id, r] of rows) {
    if (ids.has(id) || r.leaving) continue;
    r.leaving = true;
    r.el.classList.add('leaving');
    setTimeout(() => { r.el.remove(); rows.delete(id); layout(); }, 700);
  }

  pending.forEach((o, i) => {
    let r = rows.get(o.id);
    if (!r) {
      r = { el: makeRow(o, products), status: null };
      rows.set(o.id, r);
      trkList.append(r.el); // orders arrive oldest-first, so new rows belong at the end
      if (trackerReady) {
        r.el.classList.add('entering');
        r.el.addEventListener('animationend', () => r.el.classList.remove('entering'), { once: true });
      }
    }
    if (r.status !== o.status) {
      setStep(r.el, ACTIVE_STEP[o.status]);
      if (r.status) {
        // Moved to the next step: flash the row and send out a big ping.
        r.el.classList.remove('advanced', 'entering');
        void r.el.offsetWidth;
        r.el.classList.add('advanced');
        r.el.addEventListener('animationend', (e) => e.target === r.el && r.el.classList.remove('advanced'), { once: true });
      }
      r.status = o.status;
    }
    r.el.style.setProperty('--d', `${(i % 8) * 0.18}s`); // stagger pings into a wave down the list
  });

  trkEmpty.hidden = pending.length > 0;
  trackerReady = true;
  layout();
}

// Show as many rows as fit; if there are more, page through them automatically.
function layout() {
  const rowEls = [...trkList.children].filter((el) => !el.classList.contains('leaving'));
  const first = rowEls[0];
  if (!first) {
    trkList.style.transform = '';
    trkPages.innerHTML = '';
    return;
  }
  const listStyle = getComputedStyle(trkList);
  const gap = parseFloat(listStyle.rowGap) || 0;
  const rowH = first.offsetHeight + gap;
  // Fit whole rows only: size the viewport to an exact number of rows so none is cut in half.
  const avail = trkViewport.parentElement.clientHeight - trkPages.offsetHeight;
  const perPage = Math.max(1, Math.floor((avail + gap) / rowH));
  trkViewport.style.flex = 'none';
  trkViewport.style.height = `${perPage * rowH - gap}px`;
  // Each page is one grid column of perPage rows; pages are laid out left to right.
  trkList.style.gridTemplateRows = `repeat(${perPage}, ${first.offsetHeight}px)`;
  const pages = Math.ceil(rowEls.length / perPage);
  if (page >= pages) page = 0;
  const pageW = trkViewport.clientWidth + (parseFloat(listStyle.columnGap) || 0);
  trkList.style.transform = `translateX(${-page * pageW}px)`;
  trkPages.innerHTML = pages <= 1 ? ''
    : pages <= 8 ? Array.from({ length: pages }, (_, i) => `<i class="${i === page ? 'on' : ''}"></i>`).join('')
    : `<span class="trk-page-no">${page + 1} / ${pages}</span>`;
}

setInterval(() => { page++; layout(); }, 7000);
window.addEventListener('resize', layout);

startOverlay('呼び出し画面', { fullscreen: true });
connect({ role: 'display', name: 'display', onState: render });

setInterval(() => {
  clock.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}, 1000);

function render(state) {
  const ready = state.active.filter((o) => o.status === 'delivered');
  const pending = state.active.filter((o) => o.status === 'ordered' || o.status === 'made');
  const { backlog, estWaitMin } = state.queue;

  // Chime for numbers that just became ready.
  if (seen) {
    const fresh = ready.filter((o) => !seen.has(o.id));
    if (fresh.length) {
      beep(784, 0.35);
      setTimeout(() => beep(659, 0.5), 380);
    }
    for (const o of fresh) flashUntil.set(o.id, Date.now() + 5000);
  }
  seen = new Set(ready.map((o) => o.id));

  setHTML(readyEl, ready.length
    ? `<div class="nums">${ready.map((o) =>
        `<div class="num ${(flashUntil.get(o.id) ?? 0) > Date.now() ? 'new' : ''}">${pad(o.ticket_no)}</div>`).join('')}</div>`
    : `<p class="idle">お呼び出しする番号が<br>ここに表示されます</p>`);

  renderTracker(pending, state.config.products);
  document.getElementById('trk-count').textContent = pending.length ? `${pending.length}件` : '';
  document.getElementById('trk-wait').textContent = pending.length ? `待ち 約${estWaitMin}分` : '';

  banner.className = backlog ? 'backlog' : 'normal';
  setHTML(banner, `<span>${backlog
    ? `ただいま混雑しています — 待ち時間 約${estWaitMin}分`
    : ''}</span>`);
}
