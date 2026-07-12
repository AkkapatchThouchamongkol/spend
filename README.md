# Spend — a one-tap expense tracker

A single-page offline expense tracker. No accounts, no server, no tracking.
Everything you log stays in your own browser.

## Deploying it (free, ~10 minutes, once)

GitHub Pages serves this repo **publicly**, so no personal figures live in the
code — see "Your private numbers" below.

1. **Create a free GitHub account** at <https://github.com/signup> if you don't
   have one.
2. **Create a new repository**: <https://github.com/new>
   - Name: `spend`
   - **Public** (Pages is free only for public repos)
   - Do **not** tick "Add a README" — this folder already has one.
3. **Push this folder.** From inside `tracker/`:

   ```bash
   git init
   git add .
   git commit -m "Spend: expense tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/spend.git
   git push -u origin main
   ```

4. **Turn on Pages**: repo → **Settings** → **Pages** → under *Build and
   deployment*, set **Source: Deploy from a branch**, **Branch: `main` / `(root)`**
   → **Save**.
5. Wait ~1 minute. Your app is live at:

   ```
   https://YOUR-USERNAME.github.io/spend/
   ```

6. **On your phone**: open that URL in Chrome or Samsung Internet →
   **⋮ → Add to Home screen** (or "Install app"). It now opens like a real app and
   works with no signal.

## Your private numbers

This page is public. Anyone with the URL can read its source, so **no rent, phone
bill, or salary figure is written into the code**. Those live only in your phone's
browser storage.

`my-data.json` holds your real bills and take-home pay. It is listed in
`.gitignore` and **must never be committed**. To load it:

> App → **Data** tab → **Restore from backup** → pick `my-data.json`

Do that once, on the phone, after installing. Keep the file somewhere private
(your PC, or a personal cloud drive).

## Syncing to a Google Sheet (phone ↔ computer)

Without this, your data lives in one browser and dies if you clear history. With
it, everything lands in a Sheet in **your own Drive**, syncs across devices, and
you can open the raw numbers whenever you like.

The app stays **local-first**: entries save and appear instantly, then sync in the
background. Logging still works with no signal — anything you enter offline is
queued and goes up next time you're online.

1. **Make a Sheet**: <https://sheets.new>. Name it `Spend`.
2. **Extensions → Apps Script.** Delete the placeholder code.
3. Paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs).
4. **Change `SECRET`** at the top to a long random string. Keep a copy.
5. **Deploy → New deployment** → gear icon → **Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   - **Deploy**, then authorise it (Google will warn it's unverified — it's your own
     script; choose *Advanced → Go to Spend*).

   > "Anyone" means anyone who has the URL *and* your secret. Without the secret
   > every request is rejected, so don't share either.

6. Copy the **Web app URL** (ends in `/exec`).
7. In the app: **Data** tab → paste the URL and the secret → **Save** → **Sync now**.
8. Do the same on your other device. It will pull everything down.

The Sheet grows three tabs — `expenses`, `bills`, `wishes` — with plain readable
columns. `updated` and `seq` are bookkeeping for the sync; ignore them.

**If two devices edit the same entry, the most recent edit wins.** Deletes sync too.

### Careful

- Editing a row **by hand in the Sheet** won't sync back unless you also bump its
  `updated` number — the app only accepts a change that looks newer than its own.
- **Never commit your secret.** It belongs in the Sheet's script and in the app on
  your phone, nowhere else.

## Backups

Your data lives in one browser on one device. Clearing browser data erases it.

- **Data → Full backup (JSON)** — do this occasionally. It restores everything.
- **Data → Spending CSV** — feeds the analysis: drop it in `data/expenses.csv` and
  run `python analyze.py`.

## Updating the app

Edit the files, then bump `CACHE` in `sw.js` (e.g. `spend-v1` → `spend-v2`),
otherwise installed phones keep serving the cached old copy. Then:

```bash
git add . && git commit -m "Update" && git push
```

Pages redeploys in about a minute.
