# YetiSlots — Rainbet wager leaderboard

Live at **https://yetislotsrewards.com/**

A one-page static site showing a $250 monthly wager leaderboard for Rainbet
affiliate code **YETISLOTS**. Generated from the Forge Partners leaderboard
template — do not hand-edit, see *Making changes* below.

## How it works

The site never calls the Rainbet API. The API takes its key as a URL query
parameter, so any browser-side call would publish the key to every visitor.
Instead:

```
GitHub Actions (holds the key)
  -> calls the Rainbet affiliate API
  -> masks usernames, computes ranks and prizes
  -> writes data/leaderboard.json
  -> commits it to this repo
  -> GitHub Pages rebuilds on the push
  -> the browser reads static JSON
```

GitHub Pages has no per-path cache configuration, so the page fetches its data
with a unique query string and `cache: 'no-store'`. That is the only thing
keeping a refreshed board from being served stale off the CDN — do not remove
it.

The board therefore keeps working if the API is down, and costs nothing to serve.

## Settings

| Setting | Value |
| --- | --- |
| Affiliate code | `YETISLOTS` |
| Referral link | https://rainbet.com?r=yetislots |
| Prize pool | $250 across 5 places |
| Split | 1st $100 · 2nd $60 · 3rd $40 · 4th $30 · 5th $20 |
| Cycle | Calendar month — 1st to the last day of the month |
| First cycle | 2026-10-01 — earlier months are never shown as past winners |
| Timezone | Europe/London |
| Refresh | 2 0 * * * and 2 23 * * * (UTC) |
| Weekly board | off — set "weekly" in the creator config to switch it on |
| Username masking | OFF — full usernames are published |

## Go-live checklist

1. **Create the repo** and push this folder to it.
2. **Add the API key** — Settings → Secrets and variables → Actions → New
   repository secret, named exactly `RAINBET_API_KEY`.
3. **Check the default branch.** Scheduled workflows only run on the
   repository's default branch. If you pushed to anything other than the
   default, the cron will never fire.
4. **Turn on GitHub Pages** — Settings → Pages → Source: *Deploy from a
   branch*, branch `main`, folder `/ (root)`. The repo must be public; Pages
   will not serve a private repo on a free plan. The `CNAME` file already in
   this repo sets the custom domain on the first build.
5. **Point the domain at GitHub.** At your registrar, four A records on the
   apex — `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
   `185.199.111.153` — and a `www` CNAME to `<your-user>.github.io`. Then wait
   for the certificate: Settings → Pages shows when HTTPS is available, and
   only then can you tick **Enforce HTTPS**. Do not announce the site before
   that, or visitors get a certificate warning.
6. **Run the workflow once by hand** — Actions → Refresh leaderboard → Run
   workflow. Confirm it produces a data commit authored by
   `github-actions[bot]`.
7. **Load the site** and check the board, the countdown and the username search.

## Making changes

Colours, fonts, copy, prizes, socials and the cycle all live in
`creators/yetislots.json` in the template repo. Edit that, re-run
`node new-creator.mjs yetislots`, and copy the regenerated files over. The cycle
constants appear in two files (`assets/app.js` and
`scripts/fetch-leaderboard.mjs`) and must always agree — regenerating is what
guarantees that.

`data/leaderboard.json` and `data/history/*.json` are written by the workflow.
Never hand-merge them: if you hit a rebase conflict there, regenerate instead.

## Local preview

`crypto.subtle` — which the username search uses — is unavailable on `file://`,
so the page must be served:

```
npx serve .
# or
python3 -m http.server 8000
```
