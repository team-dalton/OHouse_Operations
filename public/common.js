// Shared client helpers: live connection, API calls, timers, toasts, sound, progress list.

export const STATUS_LABEL = {
  ordered: '受付済',
  made: '調理完了',
  delivered: '運搬完了',
  completed: '注文完了',
  cancelled: '取消',
};
export const FLOW = ['ordered', 'made', 'delivered', 'completed'];
const STEP_LABEL = ['受付', '調理', '運搬', '完了'];

export const ROLE_LABEL = {
  server: '受付', handoff: '受け渡し', cook: '調理', carrier: '運搬', display: '呼び出し', admin: '管理',
};

export const pad = (n) => String(n).padStart(3, '0');

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- Server clock --------------------------------------------------------
// Device clocks may disagree; measure everything against the server's clock.
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Re-render "elapsed" labels every second without touching the rest of the DOM.
export function startElapsedTicker(warnMinutes) {
  const tick = () => {
    const now = serverNow();
    const limit = warnMinutes() * 60_000;
    for (const el of document.querySelectorAll('[data-since]')) {
      const ms = now - Number(el.dataset.since);
      el.textContent = fmtElapsed(ms);
      el.classList.toggle('late', ms > limit);
      el.classList.toggle('warn', ms > limit / 2 && ms <= limit);
    }
  };
  setInterval(tick, 1000);
  return tick;
}

// --- Device identity -----------------------------------------------------
export function deviceName(role) {
  const key = `device-name-${role}`;
  try {
    let name = localStorage.getItem(key);
    if (!name) {
      name = `${role}-${Math.random().toString(36).slice(2, 6)}`;
      localStorage.setItem(key, name);
    }
    return name;
  } catch {
    return `${role}-tmp`;
  }
}

// --- Live connection (Server-Sent Events) --------------------------------
export function connect({ role, name, onState }) {
  const badge = document.getElementById('conn');
  let es;
  let lastMsg = Date.now();
  let gotStream = false; // has the live stream delivered anything yet?
  let polling = false;   // fallback: fetch the state every 1.5s instead of streaming

  const setConn = (ok) => {
    if (!badge) return;
    badge.className = ok ? 'conn ok' : 'conn bad';
    badge.textContent = ok ? '● 接続中' : '● 接続切れ — 再接続中…';
    document.body.classList.toggle('offline', !ok);
  };

  let boot = null;
  const handleState = (state) => {
    lastMsg = Date.now();
    // Server restarted (possibly with new code): reload so this screen runs the matching version.
    if (boot && state.boot && state.boot !== boot) return location.reload();
    boot = state.boot ?? boot;
    clockOffset = state.now - Date.now();
    setConn(true);
    systemBanner(state.codeUpdated
      ? 'サーバーのコードが更新されています — ホストPCで npm start を再起動してください'
      : '');
    try {
      onState(state);
    } catch (err) {
      // Never leave the screen silently stuck on "connecting".
      console.error(err);
      systemBanner(`画面の更新に失敗しました (${err.message}) — サーバーを再起動してください`);
    }
  };

  const open = () => {
    es = new EventSource(`/api/events?role=${encodeURIComponent(role)}&name=${encodeURIComponent(name)}`);
    es.addEventListener('state', (e) => {
      gotStream = true;
      handleState(JSON.parse(e.data));
    });
    es.addEventListener('ping', () => {
      lastMsg = Date.now();
      setConn(true);
    });
    es.onerror = () => setConn(false);
  };

  // Some tunnels/proxies (e.g. a free Cloudflare quick tunnel) hold back streamed responses, so the live
  // stream never delivers anything. If nothing has arrived after 6s, switch to polling the state instead.
  const startPolling = () => {
    if (polling) return;
    polling = true;
    es.close();
    const poll = async () => {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        if (res.status === 401) return toLogin();
        if (!res.ok) throw new Error(res.status);
        handleState(await res.json());
      } catch {
        setConn(false);
      }
    };
    poll();
    setInterval(poll, 1500);
  };
  setTimeout(() => { if (!gotStream) startPolling(); }, 6000);

  // Watchdog: if the stream goes quiet for 25s (server pings every 10s), force a fresh connection.
  setInterval(() => {
    if (polling) return;
    if (Date.now() - lastMsg > 25_000) {
      setConn(false);
      es.close();
      open();
      lastMsg = Date.now();
    }
  }, 5000);

  open();
}

function systemBanner(message) {
  let el = document.getElementById('system-banner');
  if (!message) return el?.remove();
  if (!el) {
    el = document.createElement('div');
    el.id = 'system-banner';
    document.body.prepend(el);
  }
  el.textContent = `⚠ ${message}`;
}

// --- API -----------------------------------------------------------------
export async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return toLogin();
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'network' } };
  }
}

export async function getJSON(path) {
  const res = await fetch(path);
  if (res.status === 401) return toLogin();
  return res.json();
}

// Signed out (passcode changed, or cookie expired): go to the login page and come back here afterwards.
function toLogin() {
  location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  return new Promise(() => {}); // never resolves; the page is navigating away
}

export function transition(order, to, device) {
  return post(`/api/orders/${order.id}/transition`, { from: order.status, to, device });
}

export function errorMessage(r) {
  if (r.status === 0) return '通信エラー — 接続を確認してください';
  if (r.data.error === 'conflict') return '他の端末で処理済みです';
  if (r.data.error === 'sold_out') return '売り切れです';
  if (r.data.error === 'spare_has_no_order') return '予備には注文がありません';
  if (r.status === 404) return 'サーバーが古いバージョンです — npm start を再起動してください';
  return `エラー (${r.data.error || r.status})`;
}

// --- Only touch the DOM when content actually changed --------------------
// Avoids swallowing taps that land mid-render.
export function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

// --- Toasts --------------------------------------------------------------
export function toast(message, { kind = 'info', action, onAction, ms = 4000 } = {}) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action;
    btn.onclick = () => {
      el.remove();
      onAction();
    };
    el.append(btn);
  }
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

// --- Sound ---------------------------------------------------------------
let audio;
export function beep(freq = 880, duration = 0.15, times = 1) {
  if (!audio) return;
  for (let i = 0; i < times; i++) {
    const t = audio.currentTime + i * (duration + 0.08);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + duration);
  }
}

// Turns sound on; must be called from a tap/click (browsers block audio until then).
export async function enableSound() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
    return true;
  } catch {
    return false;
  }
}

// Browsers block audio / fullscreen / wake lock until the user taps once.
export function startOverlay(title, { fullscreen = false } = {}) {
  const ov = document.createElement('div');
  ov.className = 'start-overlay';
  ov.innerHTML = `<div><h1>${esc(title)}</h1><p>タップして開始</p><small>Tap to start (enables sound)</small></div>`;
  document.body.append(ov);
  ov.addEventListener('click', async () => {
    ov.remove();
    try {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      await audio.resume();
    } catch {}
    if (fullscreen) document.documentElement.requestFullscreen?.().catch(() => {});
    try {
      await navigator.wakeLock?.request('screen');
    } catch {}
  });
}

// --- Left pane: overall progress -----------------------------------------
export function progressHTML(state, highlightStatus) {
  const { active, config, queue } = state;
  const rows = active
    .map((o) => {
      const step = FLOW.indexOf(o.status);
      const dots = STEP_LABEL.map(
        (label, i) => `<span class="step ${i <= step ? 'done' : ''} ${i === step ? 'cur' : ''}">${label}</span>`
      ).join('<span class="bar"></span>');
      return `
        <li class="${o.status === highlightStatus ? 'mine' : ''}">
          <span class="tno">#${pad(o.ticket_no)}</span>
          <span class="chip p${esc(o.product)}">${esc(config.products[o.product]?.name ?? o.product)}</span>
          <span class="steps">${dots}</span>
          <span class="elapsed" data-since="${o.created_at}"></span>
        </li>`;
    })
    .join('');

  return `
    <div class="pane-head">
      <h2>全体の進捗</h2>
      <div class="counts">
        <span>受付 <b>${queue.ordered}</b></span>
        <span>調理済 <b>${queue.made}</b></span>
        <span>到着 <b>${queue.delivered}</b></span>
        <span>予備 <b>${(queue.sparesMade ?? 0) + (queue.sparesReady ?? 0)}</b></span>
      </div>
    </div>
    ${queue.backlog ? `<div class="backlog-flag">⚠ 混雑中 — 待ち ${queue.pending}件 / 約${queue.estWaitMin}分</div>` : ''}
    <ul class="progress">${rows || '<li class="empty">進行中の注文はありません</li>'}</ul>`;
}
