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
  expenses: ["id", "date", "meal", "item", "amount", "category", "context",
             "wishlist", "updated", "deleted", "seq"],
  bills:    ["id", "name", "amount", "cadence", "varies", "active",
             "updated", "deleted", "seq"],
  // What was actually paid, one row per bill per month — because electric and phone
  // are not the same number every month, and the range is what you budget against.
  payments: ["id", "billId", "period", "amount", "updated", "deleted", "seq"],
  wishes:   ["id", "name", "price", "updated", "deleted", "seq"],
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

/** A GET is just a health check, so you can confirm the URL works in a browser. */
function doGet() {
  return json({ ok: true, service: "spend", sheets: Object.keys(SHEETS) });
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
  const last = sh.getLastRow();
  const uAt = cols.indexOf("updated");
  const sAt = cols.indexOf("seq");

  // id -> sheet row number
  const index = {};
  if (last > 1) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) index[String(ids[i][0])] = i + 2;
  }

  const appends = [];
  records.forEach(function (r) {
    const row = cols.map(function (c) { return r[c] === undefined ? "" : r[c]; });
    row[sAt] = seq;                                  // server stamps the cursor
    const at = index[String(r.id)];
    if (at) {
      const existing = sh.getRange(at, 1, 1, cols.length).getValues()[0];
      const mine = Number(existing[uAt]) || 0;
      if ((Number(r.updated) || 0) < mine) return;   // stale write — drop it
      sh.getRange(at, 1, 1, cols.length).setValues([row]);
    } else {
      appends.push(row);
    }
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, cols.length)
      .setValues(appends);
  }
}

/** Everything written since that device last synced — by SERVER seq, not clock. */
function readSince(kind, since) {
  const cols = SHEETS[kind];
  const sh = tab(kind);
  const last = sh.getLastRow();
  if (last < 2) return [];

  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const sAt = cols.indexOf("seq");
  const out = [];

  values.forEach(function (v) {
    if ((Number(v[sAt]) || 0) <= since) return;
    const o = {};
    cols.forEach(function (c, i) { o[c] = v[i]; });
    out.push(o);
  });
  return out;
}
