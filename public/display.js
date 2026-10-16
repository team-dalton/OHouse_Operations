// Customer-facing call screen (TV on the host laptop). Read-only.
import { beep, connect, pad, setHTML, startOverlay } from './common.js';

const readyEl = document.getElementById('ready');
const waitingEl = document.getElementById('waiting');
const banner = document.getElementById('banner');
const clock = document.getElementById('clock');

const flashUntil = new Map();
let seen = null;

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

  // Normal: just a count. Backlogged: list every waiting number so customers can find theirs.
  if (backlog) {
    setHTML(waitingEl, `
      <div class="nums small">${pending.map((o) =>
        `<div class="num ${o.status === 'made' ? 'made' : ''}">${pad(o.ticket_no)}</div>`).join('')}</div>
      <div class="legend"><i style="background:var(--bg);border:1px solid var(--line)"></i>調理待ち<i style="background:var(--ink)"></i>調理済み・運搬中</div>`);
  } else {
    setHTML(waitingEl, pending.length
      ? `<div class="count-big">${pending.length}<small>件 準備中</small></div>`
      : `<p class="idle">すぐにお作りします</p>`);
  }

  banner.className = backlog ? 'backlog' : 'normal';
  setHTML(banner, `<span>${backlog
    ? `ただいま混雑しています — 待ち時間 約${estWaitMin}分`
    : '番号が表示されたら、食券をお持ちのうえ受け取り口へお越しください'}</span>`);
}
