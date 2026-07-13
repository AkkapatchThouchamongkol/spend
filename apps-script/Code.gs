/**
 * Spend — Google Sheet backend.
 *
 * Paste this into the Apps Script editor of a Google Sheet you own, set SECRET
 * below, then deploy it as a Web App. Setup steps are in tracker/README.md.
 *
 * The app is local-first: it logs to the phone instantly and calls this only to
 * sync. So this script does one job — merge records by id, last write wins.
 *
 * Nothing here is public: the Web App runs as YOU, and every request must carry
 * the shared secret.
 */

// CHANGE THIS. Any long random string. It must match what you paste into the app.
const SECRET = "CHANGE-ME-to-a-long-random-string";

/**
 * Which copy of this file is actually deployed.
 *
 * Bump it whenever you change this file. Then `doGet` — just open the /exec URL in a
 * browser — tells you which version is live, in one look. Without it there is no way
 * to tell a successful redeploy from a failed one: the Web App answers happily either
 * way, and a stale deployment looks exactly like a fresh one until data goes missing.
 */
const VERSION = "2026-07-13 paid-vs-full-price";

/**
 * Each kind is one tab, with human-readable columns so you can just open it.
 *
 * Two timestamps, because they do different jobs and mixing them is a bug:
 *   `updated` — the CLIENT's clock. Used only to decide who edited last when the
 *               phone and the laptop both touched the same record.
 *   `seq`     — the SERVER's clock, stamped here on write. Used only as the "what
 *               changed since I last synced" cursor. Keeping the cursor on server
 *               time means a phone whose clock is a few minutes off still syncs
 *               correctly — otherwise edits and deletes get silently skipped.
 */
const SHEETS = {
  // `amount` is what actually left your pocket. `full` is the sticker price, present
  // only when you paid less than it (a government co-pay, a promotion) — the gap
  // between the two columns is the subsidy, and it is what comes back when the
  // campaign ends. Storing one number instead of two loses that forever.
  expenses: ["id", "date", "meal", "item", "amount", "category", "context",
             "wishlist", "full", "discount", "wishId", "updated", "deleted", "seq"],
  bills:    ["id", "name", "amount", "cadence", "varies", "active",
             "updated", "deleted", "seq"],
  // What was actually paid, one row per bill per month — because electric and phone
  // are not the same number every month, and the range is what you budget against.
  payments: ["id", "billId", "period", "amount", "updated", "deleted", "seq"],
  // `price` = what you listed it at. `paid` = what it cost when you actually bought it.
  wishes:   ["id", "name", "price", "bought", "paid", "bought_date", "from_fund",
             "txId", "updated", "deleted", "seq"],
};

// Favourites and settings are single blobs, not tables of records, so they live in
// their own key/value tab. Without this a lost phone would take your quick-add tiles
// and your wishlist fund balance with it, even though everything else restored.
const META = ["key", "value", "updated", "seq"];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SECRET) return json({ error: "bad token" });

    const since = Number(body.since) || 0;
    const pull = {};

    // A lock: two devices syncing at once must not interleave row writes, and the
    // seq counter below must not be handed out twice.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let seq;
    try {
      seq = nextSeq();

      // Read BEFORE writing, so a device is never handed back its own push.
      for (const kind of Object.keys(SHEETS)) {
        pull[kind] = readSince(kind, since);
      }
      var metaOut = readMeta();
      for (const kind of Object.keys(SHEETS)) {
        upsert(kind, (body.push && body.push[kind]) || [], seq);
      }
      upsertMeta(body.meta || [], seq);
    } finally {
      lock.releaseLock();
    }

    // The cursor is this request's seq. Rows written above carry exactly `seq`, so
    // `seq > since` excludes them next time — no echo, no missed row.
    // Meta is always returned in full: it is two small rows, and the client keeps
    // its own copy only when the remote one is genuinely newer.
    return json({ ok: true, now: seq, pull: pull, meta: metaOut });
  } catch (err) {
    return json({ error: String(err) });
  }
}

/**
 * A GET is a health check: open the /exec URL in a browser and it tells you which
 * version is live and which columns that version knows about. No secret needed — it
 * returns no data, only the shape, and the shape is public in the repo anyway.
 */
function doGet() {
  return json({ ok: true, service: "spend", version: VERSION, columns: SHEETS });
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * A strictly increasing counter, one per sync request.
 *
 * Deliberately NOT Date.now(): a millisecond is coarse enough that two writes can
 * land on the same value, and then `seq > since` skips a row — a lost edit that
 * nobody would ever notice. An integer counter cannot collide. Callers hold the
 * script lock, so the read-increment-write below is atomic.
 */
function nextSeq() {
  const props = PropertiesService.getScriptProperties();
  const next = (Number(props.getProperty("seq")) || 0) + 1;
  props.setProperty("seq", String(next));
  return next;
}

function tab(kind) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(kind);
  if (!sh) {
    sh = ss.insertSheet(kind);
    sh.appendRow(kind === "meta" ? META : SHEETS[kind]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Where each column actually lives in THIS sheet, by name.
 *
 * Read from the sheet's own header row, never from the position of a name in SHEETS.
 * A sheet created by an older version of the app has fewer columns, and if a newer
 * version added one in the middle, every index after it would shift: `seq` would be
 * read from a blank cell, every existing row would look older than the cursor, and
 * a new device would quietly pull nothing. Nobody would see an error.
 *
 * So: names that are missing are APPENDED to the header, existing columns never move,
 * and old rows keep reading correctly.
 */
function headerIndex(sh, cols) {
  const width = Math.max(sh.getLastColumn(), cols.length);
  const have = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) {
    return String(v).trim();
  });

  const named = have.filter(function (v) { return v; }).length;
  const missing = cols.filter(function (c) { return have.indexOf(c) === -1; });
  if (missing.length) {
    sh.getRange(1, named + 1, 1, missing.length).setValues([missing]);
    missing.forEach(function (c, i) { have[named + i] = c; });
  }

  const idx = {};
  have.forEach(function (c, i) { if (c) idx[c] = i; });
  return idx;
}

/** Every meta blob, keyed by name. Two rows: settings, quick. */
function readMeta() {
  const sh = tab("meta");
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, META.length).getValues();
  return values
    .filter(function (v) { return v[0]; })
    .map(function (v) {
      return { key: v[0], value: v[1], updated: Number(v[2]) || 0 };
    });
}

/** Upsert blobs by key. A stale blob loses, exactly as a stale record does. */
function upsertMeta(rows, seq) {
  if (!rows.length) return;
  const sh = tab("meta");
  const last = sh.getLastRow();

  const index = {};
  if (last > 1) {
    const keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) index[String(keys[i][0])] = i + 2;
  }

  const appends = [];
  rows.forEach(function (r) {
    const updated = Number(r.updated) || 0;
    if (!r.key || !updated) return;          // never let an unstamped blob overwrite
    const row = [r.key, r.value, updated, seq];
    const at = index[String(r.key)];
    if (at) {
      const mine = Number(sh.getRange(at, 3, 1, 1).getValue()) || 0;
      if (updated < mine) return;            // stale — drop it
      sh.getRange(at, 1, 1, META.length).setValues([row]);
    } else {
      appends.push(row);
    }
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, META.length)
      .setValues(appends);
  }
}

/**
 * Merge incoming records into the tab, keyed by id.
 *
 * A stale write must lose: if the laptop pushes an edit it made before the phone's
 * newer edit, we keep the phone's. That's the `updated` comparison. `seq` is always
 * re-stamped with server time, so the row surfaces to other devices either way.
 */
function upsert(kind, records, seq) {
  if (!records.length) return;
  const cols = SHEETS[kind];
  const sh = tab(kind);
  const idx = headerIndex(sh, cols);
  const width = Object.keys(idx).length;
  const last = sh.getLastRow();
  const uAt = idx["updated"];
  const sAt = idx["seq"];

  // id -> sheet row number
  const index = {};
  if (last > 1) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) index[String(ids[i][0])] = i + 2;
  }

  const appends = [];
  records.forEach(function (r) {
    const row = [];
    for (let i = 0; i < width; i++) row.push("");
    cols.forEach(function (c) {
      if (idx[c] !== undefined && r[c] !== undefined) row[idx[c]] = r[c];
    });
    row[sAt] = seq;                                  // server stamps the cursor
    const at = index[String(r.id)];
    if (at) {
      const existing = sh.getRange(at, 1, 1, width).getValues()[0];
      const mine = Number(existing[uAt]) || 0;
      if ((Number(r.updated) || 0) < mine) return;   // stale write — drop it
      sh.getRange(at, 1, 1, width).setValues([row]);
    } else {
      appends.push(row);
    }
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, width).setValues(appends);
  }
}

/** Everything written since that device last synced — by SERVER seq, not clock. */
function readSince(kind, since) {
  const cols = SHEETS[kind];
  const sh = tab(kind);
  const idx = headerIndex(sh, cols);
  const width = Object.keys(idx).length;
  const last = sh.getLastRow();
  if (last < 2) return [];

  const values = sh.getRange(2, 1, last - 1, width).getValues();
  const sAt = idx["seq"];
  const out = [];

  values.forEach(function (v) {
    if ((Number(v[sAt]) || 0) <= since) return;
    const o = {};
    cols.forEach(function (c) {
      if (idx[c] !== undefined) o[c] = v[idx[c]];
    });
    out.push(o);
  });
  return out;
}
