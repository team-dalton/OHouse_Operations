// Host / admin screen: settings, stats, device list, and manual override of any order.
import {
  ROLE_LABEL, STATUS_LABEL, beep, connect, enableSound, errorMessage, esc, fmtElapsed, getJSON, pad, post, serverNow,
  toast, transition,
} from './common.js';

const form = document.getElementById('settings');
const ordersEl = document.getElementById('orders');
const statsEl = document.getElementById('stats');
let state = null;
let orders = [];
let formDirty = false;
let refreshTimer;

form.addEventListener('input', () => (formDirty = true));

connect({
  role: 'admin',
  name: 'admin',
  onState: (s) => {
    state = s;
    if (!formDirty) fillForm(s.config);
    renderDevices(s);
    renderSync(s.sync);
    renderHelp(s.help ?? []);
    document.getElementById('logout').hidden = !s.auth;
    // Debounce the heavier queries.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  },
});

function fillForm(cfg) {
  const keys = Object.keys(cfg.products);
  const fields = document.getElementById('product-fields');
  if (fields.dataset.keys !== keys.join()) {
    fields.dataset.keys = keys.join();
    fields.innerHTML = keys.map((k) => `
      <label>トッピング${k} 名前 <input type="text" name="name${k}"></label>
      <label>トッピング${k} 売り切れ <input type="checkbox" name="soldOut${k}"></label>`).join('');
  }
  for (const k of keys) {
    form[`name${k}`].value = cfg.products[k].name;
    form[`soldOut${k}`].checked = cfg.products[k].soldOut;
  }
  form.day.value = cfg.day;
  form.nextTicket.value = cfg.nextTicket;
  form.backlogCount.value = cfg.backlogCount;
  form.backlogMinutes.value = cfg.backlogMinutes;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/api/settings', {
    products: Object.fromEntries(Object.keys(state.config.products).map((k) =>
      [k, { name: form[`name${k}`].value, soldOut: form[`soldOut${k}`].checked }])),
    day: form.day.value,
    nextTicket: form.nextTicket.value,
    backlogCount: form.backlogCount.value,
    backlogMinutes: form.backlogMinutes.value,
  });
  if (r.ok) {
    formDirty = false;
    toast('保存しました');
  } else {
    toast(errorMessage(r), { kind: 'error' });
  }
});

function renderDevices(s) {
  document.getElementById('devices').innerHTML =
    s.devices
      .map((d) => `<div class="dev"><span>${esc(ROLE_LABEL[d.role] ?? d.role)}</span><small>${esc(d.name)}</small></div>`)
      .join('') || '<p class="empty-note">なし</p>';
  const base = s.lan?.[0] ?? location.origin;
  document.getElementById('links').innerHTML = ['server', 'handoff', 'cook', 'carrier', 'display']
    .map((p) => `<a href="/${p}" target="_blank">${ROLE_LABEL[p]}</a>`)
    .join('') + `<p style="margin:4px 0 10px;color:var(--muted);font-size:13px">他の端末からは <b>${esc(base)}</b>/server など</p>`;
}

async function refresh() {
  const day = state.config.day;
  const [o, st] = await Promise.all([getJSON(`/api/orders?day=${day}`), getJSON(`/api/stats?day=${day}`)]);
  if (sheetUrl === null) {
    sheetUrl = (await getJSON('/api/backup-info')).sheetUrl || '';
    renderSync();
  }
  orders = o.orders;
  renderOrders();
  renderStats(st);
}

const t = (ms) => (ms ? new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const mins = (ms) => (ms == null ? '—' : `${(ms / 60000).toFixed(1)}分`);

function renderOrders() {
  const products = state.config.products;
  ordersEl.innerHTML = `
    <tr><th>食券</th><th>商品</th><th>ステータス</th><th>受付</th><th>調理完了</th><th>運搬完了</th><th>注文完了</th><th>最終操作</th></tr>
    ${orders.map((o) => `
      <tr class="${o.status}">
        <td><b>${o.ticket_no == null ? '予備' : `#${pad(o.ticket_no)}`}</b>${o.is_spare && o.ticket_no != null ? ' <small>(予備使用)</small>' : ''}</td>
        <td>${o.product ? `<span class="chip p${esc(o.product)}">${esc(products[o.product]?.name ?? o.product)}</span>` : '<span class="chip spare">注文なし</span>'}</td>
        <td><select data-id="${o.id}">${Object.entries(STATUS_LABEL)
          .map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td>${t(o.created_at)}</td><td>${t(o.made_at)}</td><td>${t(o.delivered_at)}</td><td>${t(o.completed_at)}</td>
        <td><small>${esc(o.updated_by ?? '')}</small></td>
      </tr>`).join('')}`;
}

ordersEl.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-id]');
  if (!sel) return;
  const order = orders.find((o) => o.id === Number(sel.dataset.id));
  const r = await transition(order, sel.value, 'admin');
  if (r.ok) toast(`${order.ticket_no == null ? '予備' : `#${pad(order.ticket_no)}`} → ${STATUS_LABEL[sel.value]}`);
  else toast(errorMessage(r), { kind: 'error' });
  refresh();
});

function renderStats(st) {
  document.getElementById('stats-day').textContent = st.day;
  const count = (pred) => st.byStatus.filter(pred).reduce((a, r) => a + r.n, 0);
  const sold = (p) => count((r) => r.product === p && r.status !== 'cancelled');
  const maxHour = Math.max(1, ...st.hourly.map((h) => h.n));
  const { products } = state.config;

  statsEl.innerHTML = `
    <div class="kv">
      ${Object.entries(products).map(([k, p]) => `<span>${esc(p.name)}</span><b>${sold(k)}</b>`).join('')}
      <span>注文完了</span><b>${count((r) => r.status === 'completed')}</b>
      <span>取消</span><b>${count((r) => r.product && r.status === 'cancelled')}</b>
      <span>予備 作成 / 使用</span><b>${st.spares.made} / ${st.spares.used}</b>
      <span>平均 調理</span><b>${mins(st.avg.cook_ms)}</b>
      <span>平均 運搬</span><b>${mins(st.avg.carry_ms)}</b>
      <span>平均 受渡待ち</span><b>${mins(st.avg.handoff_ms)}</b>
      <span>平均 合計</span><b>${mins(st.avg.total_ms)}</b>
    </div>
    <h3 style="font-size:14px;color:var(--muted);margin:14px 0 6px">時間帯別の注文数</h3>
    ${st.hourly.map((h) => `
      <div class="hbar"><span>${h.hour}時</span><div style="width:${(h.n / maxHour) * 100}%"></div><span>${h.n}</span></div>`).join('')
      || '<p class="empty-note">まだ注文がありません</p>'}`;
}

// --- Google Sheets backup status -------------------------------------------

let lastSync = null;
let sheetUrl = null; // null = not fetched yet; '' = SHEETS_VIEW_URL not set

function renderSync(sync = lastSync) {
  lastSync = sync;
  const el = document.getElementById('sync');
  const link = sheetUrl
    ? `<a class="btn wide sheet-link" href="${esc(sheetUrl)}" target="_blank" rel="noopener">スプレッドシートを開く ↗</a>`
    : '';
  if (!sync?.enabled) {
    el.innerHTML = `<p class="empty-note">未設定です。README の「Google スプレッドシート バックアップ」の手順で
      SHEETS_WEBHOOK_URL を設定すると、すべての注文が自動で記録されます。</p>${link}`;
    return;
  }
  const healthy = !sync.lastError;
  el.innerHTML = `
    <div class="kv">
      <span>状態</span><b class="${healthy ? 'sync-ok' : 'sync-bad'}">${healthy ? '● 正常' : '● 送信できていません'}</b>
      <span>送信待ち</span><b>${sync.pending}件</b>
      <span>最終送信</span><b>${sync.lastOkAt ? t(sync.lastOkAt) : '—'}</b>
      ${sync.lastError ? `<span>エラー</span><b style="white-space:normal;font-weight:500">${esc(sync.lastError)}</b>` : ''}
    </div>
    <p class="hint" style="margin-top:10px">送信できない間も変更はサーバーに保存され、つながり次第まとめて送信されます。</p>
    <button class="btn wide sheet-link" type="button" data-action="resend"
      style="background:var(--ink);box-shadow:none">スプレッドシートに送信</button>
    ${link}`;
}

// Re-sends every order, e.g. orders that existed before the backup was set up, or after switching to a new sheet.
document.getElementById('sync').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-action=resend]')) return;
  if (!confirm('すべての注文をスプレッドシートに送り直します。よろしいですか？')) return;
  const r = await post('/api/backup-resend', {});
  if (r.ok) toast(`${r.data.queued}件を送信待ちにしました`);
  else toast(errorMessage(r), { kind: 'error' });
});

// --- Restore (import) ------------------------------------------------------

// Minimal RFC 4180 CSV reader: quoted fields, escaped quotes, CRLF, BOM.
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
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...data] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const keys = header.map((h) => h.trim());
  const out = data.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
  out.header = keys;
  return out;
}

const importFile = document.getElementById('import-file');
const importText = document.getElementById('import-text');

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  if (file) importText.value = await file.text();
});

document.getElementById('import-btn').addEventListener('click', async () => {
  const parsed = parseCSV(importText.value);
  const header = parsed.header ?? [];
  const fromLog = header.includes('変更後') && header.includes('id');
  if (!fromLog && !(header.includes('id') && header.includes('status'))) {
    return toast('CSV が読み込めません（orders シートか log シートの CSV を選んでください）', { kind: 'error', ms: 8000 });
  }
  if (!parsed.length) {
    return toast('CSV にデータ行がありません（見出しだけです）。log シートの CSV からも復元できます', { kind: 'error', ms: 10000 });
  }
  // The sheet's log tab: rebuild each order from its change history.
  const rows = fromLog ? rebuildFromLog(parsed, state.config.day) : parsed;
  const mode = document.querySelector('input[name=import-mode]:checked').value;
  const inProgress = rows.filter((r) => ['ordered', 'made', 'delivered'].includes(r.status)).length;
  const message = (fromLog ? `log シートの変更履歴 ${parsed.length}行から注文を組み立てました（${state.config.day}日目として復元）。\n` : '')
    + `${rows.length}件の注文を${mode === 'replace' ? '「すべて置き換え」で' : ''}復元します（うち進行中 ${inProgress}件）。`
    + (mode === 'replace' ? '\n\n⚠ 今サーバーにある注文はすべて削除されます。' : '')
    + '\n\nよろしいですか？';
  if (!confirm(message)) return;

  const r = await post('/api/import', { rows, mode });
  if (r.ok) {
    toast(`${r.data.imported}件を復元しました`);
    importText.value = '';
    importFile.value = '';
    refresh();
  } else {
    const d = r.data;
    toast(d.line ? `${d.line}行目の ${d.field} が読み込めません` : errorMessage(r), { kind: 'error', ms: 8000 });
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  await post('/api/logout', {});
  location.href = '/login';
});

// --- Reset the current day ---------------------------------------------------

document.getElementById('reset-day').addEventListener('click', async () => {
  const day = state.config.day;
  const total = orders.filter((o) => o.ticket_no != null).length;
  const inProgress = orders.filter((o) => o.ticket_no != null && ['ordered', 'made', 'delivered'].includes(o.status)).length;
  const message = `${day}日目の記録をリセットします（注文 ${total}件）。\n\n`
    + '・統計と注文一覧が空になります\n'
    + '・食券番号は 1 から始まります\n'
    + (inProgress ? `・進行中の注文 ${inProgress}件は「取消」になります\n` : '')
    + '・注文は削除されず、CSV とスプレッドシートには残ります\n\nよろしいですか？';
  if (!confirm(message)) return;
  const r = await post('/api/reset-day', { day, device: 'admin' });
  if (r.ok) {
    toast(`${day}日目をリセットしました（${r.data.reset}件）`);
    formDirty = false;
    refresh();
  } else {
    toast(errorMessage(r), { kind: 'error' });
  }
});

// Rebuilds orders from the sheet's log tab (one row per change: time, from, to, device, id, ticket, product, status).
// Used when the orders tab is lost or emptied; the log has everything needed.
const JA_STATUS = { 受付済: 'ordered', 調理完了: 'made', 運搬完了: 'delivered', 注文完了: 'completed', 取消: 'cancelled' };
const STAGE_COL = { made: 'made_at', delivered: 'delivered_at', completed: 'completed_at' };

function rebuildFromLog(events, day) {
  const orders = new Map();
  for (const e of events) {
    const id = Number(e.id);
    const t = Date.parse(`${String(e['時刻 (JST)'] ?? '').trim().replace(' ', 'T')}+09:00`);
    if (!id || Number.isNaN(t)) continue;
    const from = String(e['変更前'] ?? '').trim();
    const to = String(e['変更後'] ?? '').trim();
    const o = orders.get(id) ?? {
      id, day, ticket_no: '', product: '', status: 'ordered', created_at: t, made_at: '', delivered_at: '',
      completed_at: '', cancelled_at: '', updated_by: '', is_spare: 0,
    };
    const ticket = String(e['食券'] ?? '').trim();
    if (ticket && ticket !== '予備') o.ticket_no = Number(ticket);
    if (String(e['商品'] ?? '').trim()) o.product = String(e['商品']).trim();

    if (to === 'spare') {
      // Made as a spare (or returned to the spares when its order was cancelled).
      o.is_spare = 1;
      o.created_at = t;
      o.made_at = o.made_at || t;
    } else if (from === 'spare') {
      o.created_at = t; // a new order picked up this spare
    } else if (!from && to === 'ordered') {
      o.created_at = t;
    } else if (to === 'cancelled') {
      o.cancelled_at = t;
    } else if (to === 'reset') {
      o.day = 0;
    } else if (to === 'ordered' || STAGE_COL[to]) {
      // Forward (or undo): stages up to `to` keep/get a time, later stages are cleared.
      const k = ['ordered', 'made', 'delivered', 'completed'].indexOf(to);
      ['made', 'delivered', 'completed'].forEach((stage, i) => {
        const col = STAGE_COL[stage];
        o[col] = i + 1 <= k ? o[col] || t : '';
      });
      o.cancelled_at = '';
    }
    o.status = JA_STATUS[String(e['状態'] ?? '').trim()] ?? o.status;
    o.updated_by = String(e['端末'] ?? '').trim() || o.updated_by;
    orders.set(id, o);
  }
  return [...orders.values()];
}

// --- Help requests (e.g. the cook's 「ヘルプを呼ぶ」) ---------------------------

const helpEl = document.getElementById('help-alert');
let helpOpen = [];
let soundOn = false;

function renderHelp(list) {
  const fresh = list.some((h) => !helpOpen.some((o) => o.id === h.id));
  helpOpen = list;
  helpEl.hidden = list.length === 0;
  document.title = list.length ? `🆘 ヘルプ (${list.length}) — Candy Cloud 管理` : 'Candy Cloud 管理';
  if (!list.length) return;
  helpEl.innerHTML = `
    <h2>🆘 ヘルプ要請 (${list.length})
      <button class="help-sound" data-action="sound" type="button">${soundOn ? '🔔 通知音オン' : '🔕 通知音をオンにする'}</button></h2>
    ${list.map((h) => `
      <div class="help-row">
        <span>${esc(ROLE_LABEL[h.role] ?? h.role)}</span><small style="opacity:.8">${esc(h.device)}</small>
        <span class="since" data-help-since="${h.at}">${fmtElapsed(serverNow() - h.at)}</span>
        <button class="btn" data-action="resolve" data-id="${h.id}" type="button">対応済み</button>
      </div>`).join('')}`;
  if (fresh) beep(988, 0.25, 3);
}

helpEl.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'sound') {
    soundOn = await enableSound();
    renderHelp(helpOpen);
    if (soundOn) beep(988, 0.2, 1);
  }
  if (el.dataset.action === 'resolve') {
    const r = await post(`/api/help/${el.dataset.id}/resolve`, { device: 'admin' });
    if (!r.ok) toast(errorMessage(r), { kind: 'error' });
  }
});

// Keep the waiting time ticking, and keep reminding while a request is open (when sound is on).
setInterval(() => {
  for (const el of helpEl.querySelectorAll('[data-help-since]')) el.textContent = fmtElapsed(serverNow() - Number(el.dataset.helpSince));
}, 1000);
setInterval(() => { if (helpOpen.length) beep(988, 0.25, 2); }, 8000);
