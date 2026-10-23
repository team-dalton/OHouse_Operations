# Candy Cloud 注文管理 (Cotton candy order tracker)

School-festival order flow for staff devices + a customer display. Runs on a local Wi-Fi network, or hosted
online (e.g. Railway) with a staff passcode. No install beyond Node.js.

```
受付 (server) ──▶ 調理 (cook) ──▶ 運搬 (carrier) ──▶ 受渡 (server) ──▶ archived
   ordered            made           delivered          completed
```

## Run

Requires Node.js 22.13+ (uses the built-in `node:sqlite`). No `npm install` needed.

```bash
npm start
```

The terminal prints the address other devices should open, e.g. `http://192.168.0.10:3000`.

| Device | Open | Screen |
|---|---|---|
| Tablet 1 | `/server` | 受付: register orders (綿飴 → topping or none → 注文を確定) and hand over the 食券 #. |
| Tablet 1b | `/handoff` | 受け渡し: orders waiting at the counter, topping shown large → お渡し完了. |
| Tablet 2 | `/cook` | Next order to make (完成), queue, 予備, and 「ヘルプを呼ぶ」 (alerts /admin). |
| Phone/tablet 3 | `/carrier` | Right: finished orders to carry; select some (or none = all) → 運搬完了. |
| Host laptop → TV | `/display` | Customer call screen. Ready numbers + chime. Backlog mode lists every waiting number with an estimated wait. |
| Host laptop | `/admin` | Topping names, sold-out, day 1/2, ticket counter, backlog thresholds, stats, fix any order, CSV export. |

### 予備 (spares)

Every cotton candy is identical until the topping goes on at the counter, so the cook can make some ahead of time.
When no order is waiting, the cook screen shows 「予備を1つ作った」. A spare is carried to the counter like an
order. When the server registers an order, it uses a spare automatically: one at the counter means the order is
ready immediately; one still being carried means the order skips the cook. Cancelling an order that was already
made returns the candy to the spares.

Every screen: tap once on the start overlay (enables sound). Each action shows a 10-second 「取り消す」 (undo).
If two devices act on the same order, only the first succeeds; the other sees 「他の端末で処理済みです」.

## Rehearse without people

```bash
RATE=6 SPEED=4 npm run simulate
```

Plays cook/carrier/server automatically (one cook, ~25–45 s per cotton candy) so you can watch backlog mode kick in.

```bash
npm test
```

All tests, each against a throwaway database: concurrency (simultaneous orders, double taps, undo, spares),
passcode, Google Sheets backup queue, and restore. If the server has a passcode, run the simulator with
`PASSCODE=... npm run simulate`.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on (Railway sets this). |
| `DB_PATH` | `data/festival.db` | Database file. **On Railway, point this at a Volume** (e.g. `/data/festival.db`). |
| `STAFF_PASSCODE` | *(off)* | Staff passcode. When set, every page except `/display` needs it. **Required when hosted online.** |
| `SHEETS_WEBHOOK_URL` | *(off)* | Google Apps Script web app URL for the backup sheet. |
| `SHEETS_SECRET` | | Must match `SECRET` in `google-sheets/Code.gs`. |
| `SHEETS_VIEW_URL` | *(off)* | The backup spreadsheet's own link (`https://docs.google.com/spreadsheets/d/…`). Shows a 「スプレッドシートを開く」 button in `/admin` (staff only). |

## Staff passcode

With `STAFF_PASSCODE` set, opening any staff page shows a login screen. Each device enters the passcode once and
stays signed in for 2 weeks. `/display` (the customer monitor) never needs it. Changing `STAFF_PASSCODE` signs out
every device. 10 wrong attempts lock that network address out for 10 minutes. `/admin` has a ログアウト button.

## Google スプレッドシート バックアップ (backup)

Every order change is sent to a Google Sheet. Changes are queued in the database first, so an internet outage or
a restart only delays the backup — nothing is lost. `/admin` shows the backup status and how many changes are waiting.

1. Create a new Google Sheet (e.g. 「Candy Cloud 注文履歴」) in the account that should own the data.
2. **Extensions → Apps Script**. Replace the code with `google-sheets/Code.gs` from this repo.
3. In that code, change `SECRET` to a long random text. Save.
4. **Deploy → New deployment** → type **Web app** → Execute as **Me** → Who has access **Anyone** → Deploy →
   authorize. Copy the **Web app URL** (ends in `/exec`). Opening it in a browser should show `{"ok":true,...}`.
5. On the server set `SHEETS_WEBHOOK_URL` = that URL and `SHEETS_SECRET` = the same secret. Restart.

The sheet gets three tabs: **orders** (one row per order, latest state — this is what you restore from), **log**
(every change, with time and device), **settings** (topping names, day, next ticket number).

If you edit `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## データ復元 (restore)

If the server's data is lost (e.g. a redeploy without a Volume):

1. In the sheet, open the **orders** tab → **File → Download → CSV**.
   (The `/admin` 「CSV エクスポート」 file works too.)
2. Open `/admin` → 「データ復元」 → choose the file (or paste its contents).
3. Pick 「すべて置き換え」 for an empty/broken server, or 「追加・更新」 to merge (same id = overwrite) → 「復元する」.
4. Check 次の食券番号 in 設定 (the sheet's **settings** tab shows the last value).

In-progress orders come back where they were; their ticket numbers won't be handed out again until they finish.

## Deploy on Railway

1. Push this repo to GitHub (private is fine).
2. Railway → **New Project → GitHub Repository** → pick the repo. It detects Node and runs `npm start`.
3. Service → **Variables**: `STAFF_PASSCODE`, `DB_PATH=/data/festival.db`, and (optional) `SHEETS_WEBHOOK_URL`,
   `SHEETS_SECRET`.
4. Service → right-click → **Attach Volume** → mount path `/data`. Without it, every redeploy wipes the orders.
5. Service → **Settings → Networking → Generate Domain**. Open `https://<domain>/` on each device and log in;
   open `https://<domain>/display` on the big screen.
6. Keep it to **one instance** (no replicas): live updates are sent from the server's memory.

Every push to GitHub redeploys; open screens reload themselves when the new server starts.

## Festival-day checklist

- Local setup: dedicated Wi-Fi router; host laptop on AC power, sleep disabled. Hosted setup: check `/admin`
  shows the backup as 正常 before opening.
- Set every tablet's auto-lock to "never" (browsers can't keep the screen on over plain http).
- Add each page to the home screen for full-screen mode.
- Local data lives in `data/festival.db`. Delete it after rehearsal for a clean start (or start a fresh sheet too).
- In `/admin`: set topping names, set 営業日 to 2 on day 2 (ticket numbers restart at 1 automatically).
- Keep a paper fallback list in case the laptop dies.
