/**
 * わたあめ注文管理 — Google Sheets backup receiver.
 *
 * Setup (see README "Google スプレッドシート バックアップ"):
 *   1. Create a Google Sheet → Extensions → Apps Script → paste this file.
 *   2. Change SECRET below (any long random text) and set the same value as SHEETS_SECRET on the server.
 *   3. Deploy → New deployment → type "Web app", Execute as "Me", Who has access "Anyone".
 *   4. Copy the Web app URL (ends in /exec) into SHEETS_WEBHOOK_URL on the server.
 *
 * Sheets written:
 *   orders   — one row per order, always its latest state. Download as CSV and import in /admin to restore.
 *   log      — every change, in order (who did what, when).
 *   settings — the latest server settings (topping names, day, next ticket number, …).
 */
const SECRET = 'change-me-to-a-long-random-text';

const ORDER_COLS = ['id', 'day', 'ticket_no', 'product', 'status', 'created_at', 'made_at', 'delivered_at',
  'completed_at', 'cancelled_at', 'updated_by', 'is_spare'];
const READABLE_COLS = ['受付時刻 (JST)', '状態'];
const LOG_COLS = ['時刻 (JST)', '変更前', '変更後', '端末', 'id', '食券', '商品', '状態'];
const STATUS_JA = { ordered: '受付済', made: '調理完了', delivered: '運搬完了', completed: '注文完了', cancelled: '取消' };

function doPost(e) {
  // Any problem is reported back as {ok:false, error}, which the server shows on the /admin backup card.
  let lock;
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return reply({ ok: false, error: 'bad_secret: SECRET と SHEETS_SECRET が一致しません' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return reply({ ok: false, error: 'not_bound: スプレッドシートの「拡張機能 → Apps Script」から作成したスクリプトに貼り付けてください' });
    }
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    writeOrders(ss, body.items || []);
    writeLog(ss, body.items || []);
    if (body.config) writeSettings(ss, body.config);
    return reply({ ok: true, received: (body.items || []).length });
  } catch (err) {
    return reply({ ok: false, error: 'script_error: ' + err });
  } finally {
    if (lock) lock.releaseLock();
  }
}

// Opening the URL in a browser shows this — handy to check the deployment works.
// It also says which spreadsheet the script writes to.
function doGet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return reply({ ok: true, service: 'wataame-backup', spreadsheet: ss ? ss.getName() : null,
    note: ss ? undefined : 'not_bound: スプレッドシートの「拡張機能 → Apps Script」から作成してください' });
}

function writeOrders(ss, items) {
  const header = ORDER_COLS.concat(READABLE_COLS);
  const sheet = getSheet(ss, 'orders', header, (s) => {
    // Plain number format so CSV downloads keep exact millisecond timestamps (no 1.79E+12).
    s.getRange('A:C').setNumberFormat('0');
    s.getRange('F:J').setNumberFormat('0');
    s.getRange('L:L').setNumberFormat('0');
    s.getRange('M:N').setNumberFormat('@');
  });

  const last = sheet.getLastRow();
  const data = last > 1 ? sheet.getRange(2, 1, last - 1, header.length).getValues() : [];
  const rowOf = new Map(data.map((row, i) => [String(row[0]), i]));

  for (const item of items) {
    const o = item.order;
    if (!o) continue;
    const values = ORDER_COLS.map((c) => (o[c] == null ? '' : o[c]))
      .concat([o.created_at ? jst(o.created_at) : '', STATUS_JA[o.status] || o.status]);
    const i = rowOf.get(String(o.id));
    if (i == null) {
      rowOf.set(String(o.id), data.length);
      data.push(values);
    } else {
      data[i] = values;
    }
  }
  if (data.length) sheet.getRange(2, 1, data.length, header.length).setValues(data);
}

function writeLog(ss, items) {
  const sheet = getSheet(ss, 'log', LOG_COLS, (s) => s.getRange('A:H').setNumberFormat('@'));
  const rows = items.filter((it) => it.order && it.event).map((it) => [
    jst(it.event.at), it.event.from || '', it.event.to || '', it.event.device || '',
    String(it.order.id), it.order.ticket_no == null ? '予備' : String(it.order.ticket_no),
    it.order.product || '', STATUS_JA[it.order.status] || it.order.status,
  ]);
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LOG_COLS.length).setValues(rows);
}

function writeSettings(ss, config) {
  const sheet = getSheet(ss, 'settings', ['key', 'value'], (s) => s.getRange('A:B').setNumberFormat('@'));
  sheet.getRange(2, 1, 2, 2).setValues([
    ['config', JSON.stringify(config)],
    ['updated (JST)', jst(Date.now())],
  ]);
}

function getSheet(ss, name, header, format) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    format(sheet);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jst(ms) {
  return Utilities.formatDate(new Date(Number(ms)), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
