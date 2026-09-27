/* YetiSlots — monthly Rainbet wager leaderboard.
   Data is a static JSON snapshot refreshed by a scheduled job; nothing here
   touches the Rainbet API directly, so the affiliate key never reaches a browser.

   GENERATED FILE. The cycle constants below are written by new-creator.mjs from
   creators/yetislots.json, which is also what writes them into
   scripts/fetch-leaderboard.mjs. Editing them here alone makes the countdown
   disagree with the data — change the config and regenerate instead. */
(() => {
  'use strict';

  /* --8<-- pure logic: constants, timezone maths and the cycle model.
     test/run-tests.mjs extracts everything between these fences verbatim and
     table-tests it, so the code under test is the code that ships. --8<-- */
  const TZ = 'Europe/London';
  /** 'monthly' = 1st to the last day of the month. 'offset' = day N to day N-1 of the next month. */
  const CYCLE_MODE = 'monthly';
  const CYCLE_START_DAY = 1;
  const DATA_URL = 'data/leaderboard.json';
  const HISTORY_INDEX_URL = 'data/history/index.json';
  /* A weekly board runs alongside the monthly one, funded separately by the
     creator. The code ships to every site; only this flag turns it on. */
  const WEEKLY_ENABLED = false;
  const WEEK_DATA_URL = 'data/weekly.json';
  const WEEK_HISTORY_INDEX_URL = 'data/history-weekly/index.json';

  const $ = (id) => document.getElementById(id);

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });
  const moneyExact = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  /* ---------- Timezone helpers ---------------------------------------- */

  /** How far the given zone is from UTC at a specific instant, in ms. */
  function zoneOffsetMs(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
    const f = {};
    for (const p of parts) f[p.type] = p.value;
    const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour % 24, +f.minute, +f.second);
    return asUtc - instant.getTime();
  }

  /** UTC timestamp for a wall-clock midnight in the leaderboard's timezone. */
  function zonedMidnight(year, month, day) {
    const naive = Date.UTC(year, month - 1, day);
    let ts = naive;
    // Two passes settle the DST edge cases around the shift itself.
    for (let i = 0; i < 2; i++) ts = naive - zoneOffsetMs(new Date(ts), TZ);
    return ts;
  }

  /** Today's calendar date in the leaderboard's timezone. */
  function zonedToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  /* ---------- Cycle model ---------------------------------------------- */

  const pad = (n) => String(n).padStart(2, '0');
  const nextMonth = (y, m) => (m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 });
  /** Day count of a month. Date.UTC(y, m, 0) is the last day of month m (1-based). */
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  /** Midnight at the start of the cycle after the one containing `today`. */
  function nextResetTs(today) {
    const { year, month, day } = today;
    if (CYCLE_MODE === 'monthly') {
      const n = nextMonth(year, month);
      return zonedMidnight(n.year, n.month, 1);
    }
    if (day < CYCLE_START_DAY) return zonedMidnight(year, month, CYCLE_START_DAY);
    const n = nextMonth(year, month);
    return zonedMidnight(n.year, n.month, CYCLE_START_DAY);
  }

  /* ---------- Weekly cycle model ---------------------------------------
     Weeks run Monday 00:00 to Sunday 23:59 in the leaderboard's timezone.
     The arithmetic is done on whole UTC days, which is exact regardless of
     DST; only the countdown target is converted back to a zoned midnight. */

  const DAY_MS = 86400000;
  const isoFromTs = (ts) => {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };

  /** The Monday-to-Sunday week containing the given date. */
  function weekContaining({ year, month, day }) {
    const ts = Date.UTC(year, month - 1, day);
    // getUTCDay is 0 for Sunday, so shift it to "days since Monday".
    const sinceMonday = (new Date(ts).getUTCDay() + 6) % 7;
    const start = ts - sinceMonday * DAY_MS;
    return { id: isoFromTs(start), start: isoFromTs(start), end: isoFromTs(start + 6 * DAY_MS) };
  }

  /** The week that closed immediately before the given one. */
  function weekBefore(week) {
    const [y, m, d] = week.start.split('-').map(Number);
    const start = Date.UTC(y, m - 1, d) - 7 * DAY_MS;
    return { id: isoFromTs(start), start: isoFromTs(start), end: isoFromTs(start + 6 * DAY_MS) };
  }

  /** Midnight opening the week after the one containing `today`. */
  function nextWeeklyResetTs(today) {
    const [y, m, d] = weekContaining(today).end.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d) + DAY_MS);
    return zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }

  /** "1 - 30 Sep 2026", dropping the year on the start when both match. */
  function periodLabel(startISO, endISO) {
    const start = new Date(`${startISO}T00:00:00Z`);
    const end = new Date(`${endISO}T00:00:00Z`);
    const fmt = (d, opts) => d.toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
    const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
    const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
    const from = sameMonth
      ? fmt(start, { day: 'numeric' })
      : fmt(start, sameYear
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' });
    return `${from} – ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }

  /* --8<-- end of extracted region --8<-- */

  /* ---------- Countdown ------------------------------------------------ */

  /* ---------- Views ----------------------------------------------------
     The monthly board is the headline and always the one that loads first.
     A weekly board, when the creator funds one, is a second dataset with the
     same shape — so switching view is a matter of swapping which files are
     read, not of rendering anything differently. */

  const VIEWS = {
    monthly: {
      dataUrl: DATA_URL,
      historyIndexUrl: HISTORY_INDEX_URL,
      historyDir: 'data/history',
      nextReset: nextResetTs,
      periodWord: 'cycle',
    },
    weekly: {
      dataUrl: WEEK_DATA_URL,
      historyIndexUrl: WEEK_HISTORY_INDEX_URL,
      historyDir: 'data/history-weekly',
      nextReset: nextWeeklyResetTs,
      periodWord: 'week',
    },
  };

  let view = 'monthly';        // which tab is selected: monthly, weekly or history
  let boardView = 'monthly';   // which live board the countdown and data belong to
  const cache = {};

  const cd = { d: $('cd-days'), h: $('cd-hours'), m: $('cd-mins'), s: $('cd-secs') };
  let resetTs = VIEWS[boardView].nextReset(zonedToday());

  function tickCountdown() {
    let remaining = resetTs - Date.now();
    if (remaining <= 0) {
      // Cycle just rolled over: re-target and pull the fresh board.
      resetTs = VIEWS[boardView].nextReset(zonedToday());
      remaining = Math.max(0, resetTs - Date.now());
      delete cache[boardView];
      loadBoard();
    }
    const total = Math.floor(remaining / 1000);
    cd.d.textContent = pad(Math.floor(total / 86400));
    cd.h.textContent = pad(Math.floor(total / 3600) % 24);
    cd.m.textContent = pad(Math.floor(total / 60) % 60);
    cd.s.textContent = pad(total % 60);
  }

  tickCountdown();
  setInterval(tickCountdown, 1000);

  /* ---------- Rendering ------------------------------------------------ */

  const MEDALS = ['🥇', '🥈', '🥉'];
  let board = null;
  let showingAll = false;

  function renderPodium(entries) {
    const host = $('podium');
    const top = entries.slice(0, 3);
    if (!top.length) { host.innerHTML = ''; return; }
    host.innerHTML = top.map((e) => `
      <article class="pod pod--${e.rank}">
        <div class="pod__medal">${MEDALS[e.rank - 1]}</div>
        <p class="pod__rank">Rank ${e.rank}</p>
        <p class="pod__name">${escapeHtml(e.masked)}</p>
        <p class="pod__wagered">Wagered <strong>${moneyExact.format(e.wagered)}</strong></p>
        <span class="pod__prize">${money.format(e.prize)}</span>
      </article>`).join('');
  }

  /** "1 October 2026", for the not-open-yet notice. */
  function longDate(iso) {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function renderRows(entries) {
    const tbody = $('lb-body');
    if (!entries.length) {
      // A board for a period before the competition opened says so, rather
      // than inviting people to compete in something that is not running.
      tbody.innerHTML = board?.startsOn
        ? `<tr class="lb__empty"><td colspan="4">
             The ${money.format(board.prizePool)} competition starts on
             <strong>${escapeHtml(longDate(board.startsOn))}</strong>. Wagers
             from before then do not count.</td></tr>`
        : `<tr class="lb__empty"><td colspan="4">
             No wagers recorded yet this cycle — be the first on the board.</td></tr>`;
      return;
    }
    const cut = board?.boardSize || 25;
    const visible = showingAll ? entries : entries.slice(0, cut);
    const rows = visible.map((e) => `
      <tr data-hash="${e.hash}" class="${e.prize > 0 ? 'is-top' : ''}">
        <td><span class="lb__rank">${e.rank}</span></td>
        <td class="lb__name">${escapeHtml(e.masked)}</td>
        <td class="num">${moneyExact.format(e.wagered)}</td>
        <td class="num ${e.prize > 0 ? 'lb__prize' : 'lb__prize--none'}">${e.prize > 0 ? money.format(e.prize) : '—'}</td>
      </tr>`).join('');

    const hidden = entries.length - visible.length;
    const toggle = (hidden > 0 || showingAll)
      ? `<tr class="lb__empty"><td colspan="4">
           <button class="btn btn--ghost btn--sm" id="toggle-all" type="button">
             ${showingAll ? 'Show top ' + cut : 'Show all ' + entries.length + ' players'}
           </button></td></tr>`
      : '';

    tbody.innerHTML = rows + toggle;
    const btn = $('toggle-all');
    if (btn) btn.addEventListener('click', () => { showingAll = !showingAll; renderRows(entries); });
  }

  /* A place nobody is standing in yet shows a dash, not an amount. With fewer
     players than paid places, printing "5th $20" would advertise a prize that
     is not going anywhere this cycle. */
  function renderPrizes(prizes, playerCount) {
    $('prize-grid').innerHTML = prizes.map((amount, i) => {
      const claimed = i < playerCount;
      return `
      <li class="prize prize--${i + 1}${claimed ? '' : ' prize--unclaimed'}">
        <span class="prize__rank">${ordinal(i + 1)}</span>
        <span class="prize__amt">${claimed ? money.format(amount) : '\u2014'}</span>
      </li>`;
    }).join('');
  }

  function placesPhrase(n) {
    return n === 1 ? 'single top wagerer' : `top ${n} wagerers`;
  }

  function renderBoard(data) {
    board = data;
    const word = VIEWS[boardView].periodWord;
    const places = data.prizes.length;
    $('period-label').textContent = periodLabel(data.periodStart, data.periodEnd);
    $('stat-players').textContent = data.playerCount.toLocaleString('en-GB');
    $('stat-wagered').textContent = money.format(data.totalWagered);
    // Pool and paid places come from the board itself, so the headline figures
    // can never drift from the prizes the data actually pays out.
    $('stat-pool').textContent = money.format(data.prizePool);
    $('stat-places').textContent = String(places);
    $('stat-wagered-label').textContent = `Wagered this ${word}`;
    $('prizes-sub').textContent =
      `${money.format(data.prizePool)} shared across the ${placesPhrase(places)}, paid at the end of every ${word}.`;
    $('updated-at').textContent = new Date(data.updatedAt)
      .toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }) + ' UK';
    renderPodium(data.entries);
    renderRows(data.entries);
    renderPrizes(data.prizes, data.playerCount);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadBoard() {
    const active = boardView;
    if (cache[active]) { renderBoard(cache[active]); return; }
    try {
      const res = await fetch(`${VIEWS[active].dataUrl}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cache[active] = data;
      // The viewer may have switched tabs while this was in flight.
      if (boardView === active && view !== 'history') renderBoard(data);
    } catch (err) {
      console.error('Could not load leaderboard', err);
      if (boardView !== active || view === 'history') return;
      $('lb-body').innerHTML = `<tr class="lb__empty"><td colspan="4">
        Leaderboard is temporarily unavailable. Please refresh in a moment.</td></tr>`;
    }
  }

  /* ---------- Search --------------------------------------------------- */

  /* Rows ship with a hash of the username rather than the username itself, so a
     player can prove which row is theirs without the board exposing anyone else. */
  async function hashUsername(name) {
    const bytes = new TextEncoder().encode(name.trim().toLowerCase());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  const searchResult = $('search-result');

  function setResult(message, state) {
    searchResult.textContent = message;
    searchResult.className = `search__result${state ? ' search__result--' + state : ''}`;
  }

  async function runSearch() {
    const query = $('search-input').value.trim();
    document.querySelectorAll('tr.is-you').forEach((tr) => tr.classList.remove('is-you'));

    if (!query) { setResult('Enter your Rainbet username to find your position.', null); return; }
    if (!board) { setResult('Leaderboard is still loading — try again in a second.', 'miss'); return; }
    if (!window.crypto?.subtle) {
      setResult('Search needs a secure (https) connection.', 'miss');
      return;
    }

    const hash = await hashUsername(query);
    const match = board.entries.find((e) => e.hash === hash);

    if (!match) {
      setResult(`No wagers found for "${query}" this cycle. Make sure you signed up with code YETISLOTS and that the spelling matches exactly.`, 'miss');
      return;
    }

    // Reveal the whole board if their row sits below the default cut-off.
    if (match.rank > (board.boardSize || 25) && !showingAll) {
      showingAll = true;
      renderRows(board.entries);
    }

    const prize = match.prize > 0
      ? ` You're in the money for ${money.format(match.prize)}.`
      : ` ${money.format(0)} so far — the top 5 wagerers get paid, keep climbing.`;
    setResult(`${query} — rank #${match.rank} with ${moneyExact.format(match.wagered)} wagered.${prize}`, 'hit');

    const row = document.querySelector(`tr[data-hash="${hash}"]`);
    if (row) {
      row.classList.add('is-you');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  $('search-btn').addEventListener('click', runSearch);
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });

  /* ---------- Copy code ------------------------------------------------ */

  const copyBtn = $('copy-code');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.code);
      copyBtn.textContent = 'Copied!';
    } catch {
      copyBtn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  });

  /* ---------- Past winners --------------------------------------------- */

  /* Closed periods are archived by the workflow, one file each, with an index
     per competition. Both indexes are read once on load: they decide whether
     the "Past winners" tab exists at all, so a site with nothing closed yet
     never offers an empty tab. */

  const historyIndex = { monthly: [], weekly: [] };
  let historyScope = 'monthly';

  async function loadIndex(which) {
    try {
      const res = await fetch(`${VIEWS[which].historyIndexUrl}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return [];
      return (await res.json()).cycles || [];
    } catch { return []; }
  }

  async function showPeriod(id) {
    const scope = historyScope;
    const champ = $('history-champion');
    const body = $('history-body');
    const cycles = historyIndex[scope];
    const meta = cycles.find((c) => c.id === id) || cycles[0];
    $('history-period').textContent = meta ? periodLabel(meta.start, meta.end) : '—';
    body.innerHTML = `<tr class="lb__empty"><td colspan="4">Loading…</td></tr>`;
    try {
      const res = await fetch(`${VIEWS[scope].historyDir}/${encodeURIComponent(id)}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const past = await res.json();
      if (historyScope !== scope) return;   // switched competition mid-flight
      const winners = past.entries.filter((e) => e.prize > 0);

      $('history-period').textContent = periodLabel(past.periodStart, past.periodEnd);

      if (!winners.length) {
        champ.innerHTML = '';
        body.innerHTML = `<tr class="lb__empty"><td colspan="4">No winners recorded for this period.</td></tr>`;
        return;
      }

      const [first] = winners;
      champ.innerHTML = `
        <div class="champion">
          <span class="champion__crown">👑</span>
          <span class="champion__body">
            <span class="champion__tag">${scope === 'weekly' ? 'Weekly champion' : 'Monthly champion'} · ${escapeHtml(periodLabel(past.periodStart, past.periodEnd))}</span>
            <span class="champion__name">${escapeHtml(first.masked)}</span>
            <span class="champion__meta">${moneyExact.format(first.wagered)} wagered</span>
          </span>
          <span class="champion__prize">${money.format(first.prize)}</span>
        </div>`;

      body.innerHTML = winners.map((e) => `
        <tr class="is-top">
          <td><span class="lb__rank">${e.rank}</span></td>
          <td class="lb__name">${escapeHtml(e.masked)}</td>
          <td class="num">${moneyExact.format(e.wagered)}</td>
          <td class="num lb__prize">${money.format(e.prize)}</td>
        </tr>`).join('');
    } catch {
      if (historyScope !== scope) return;
      champ.innerHTML = '';
      body.innerHTML = `<tr class="lb__empty"><td colspan="4">Could not load this period.</td></tr>`;
    }
  }

  function renderHistory() {
    const cycles = historyIndex[historyScope];
    const select = $('history-select');
    select.innerHTML = cycles
      .map((c) => `<option value="${c.id}">${periodLabel(c.start, c.end)}</option>`).join('');
    // A single closed period leaves nothing to choose between.
    select.hidden = cycles.length < 2;
    if (!cycles.length) {
      $('history-champion').innerHTML = '';
      $('history-period').textContent = '—';
      $('history-body').innerHTML = `<tr class="lb__empty"><td colspan="4">
        No ${historyScope === 'weekly' ? 'week' : 'month'} has closed yet.</td></tr>`;
      return;
    }
    showPeriod(cycles[0].id);
  }

  function setScope(next) {
    if (next === historyScope) return;
    historyScope = next;
    for (const name of ['monthly', 'weekly']) {
      const chip = $(`scope-${name}`);
      const on = name === historyScope;
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-selected', String(on));
    }
    renderHistory();
  }

  /* ---------- Tabs ------------------------------------------------------ */

  const LIVE = ['countdown-wrap', 'stats', 'live-board'];

  function setView(next) {
    if (next === view) return;
    view = next;
    for (const name of ['monthly', 'weekly', 'history']) {
      const tab = $(`tab-${name}`);
      if (!tab) continue;
      const on = name === view;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    }

    const past = view === 'history';
    for (const id of LIVE) $(id).hidden = past;
    $('history').hidden = !past;
    $('board-title').textContent = past ? 'Past winners' : 'Current leaderboard';
    $('board-sub').textContent = past
      ? 'Final standings from every period that has closed, straight from Rainbet.'
      : 'Search below to find your own position.';

    if (past) { renderHistory(); return; }

    // Back to a live board.
    boardView = view;
    showingAll = false;
    board = null;
    resetTs = VIEWS[boardView].nextReset(zonedToday());
    setResult('Enter your Rainbet username to find your position.', null);
    $('lb-body').innerHTML = `<tr class="lb__empty"><td colspan="4">Loading leaderboard…</td></tr>`;
    loadBoard();
  }

  async function wireTabs() {
    historyIndex.monthly = await loadIndex('monthly');
    if (WEEKLY_ENABLED) historyIndex.weekly = await loadIndex('weekly');

    const hasHistory = historyIndex.monthly.length > 0 || historyIndex.weekly.length > 0;
    if (WEEKLY_ENABLED || hasHistory) $('board-tabs').hidden = false;
    if (WEEKLY_ENABLED) $('tab-weekly').hidden = false;
    if (hasHistory) $('tab-history').hidden = false;

    // The competition chips only earn their place when both have closed periods
    // to show. With one, the tab is unambiguous already.
    if (historyIndex.monthly.length && historyIndex.weekly.length) {
      $('history-scope').hidden = false;
    } else if (historyIndex.weekly.length) {
      historyScope = 'weekly';
    }

    for (const name of ['monthly', 'weekly', 'history']) {
      $(`tab-${name}`).addEventListener('click', () => setView(name));
    }
    $('scope-monthly').addEventListener('click', () => setScope('monthly'));
    $('scope-weekly').addEventListener('click', () => setScope('weekly'));
    $('history-select').addEventListener('change', () => showPeriod($('history-select').value));
  }

  /* ---------- Rules popup --------------------------------------------- */

  /* A native <dialog> so Escape, the backdrop and focus handling come for
     free. showModal() is unavailable on very old browsers, in which case the
     rules are still in the page and simply shown inline rather than modally. */
  const rules = $('rules-dialog');
  $('rules-btn').addEventListener('click', () => {
    if (typeof rules.showModal === 'function') rules.showModal();
    else rules.setAttribute('open', '');
  });
  $('rules-close').addEventListener('click', () => {
    if (typeof rules.close === 'function') rules.close();
    else rules.removeAttribute('open');
  });
  // Clicking the backdrop closes it. The dialog's own box swallows its clicks,
  // so a click that lands on the element itself came from outside the box.
  rules.addEventListener('click', (e) => {
    if (e.target === rules && typeof rules.close === 'function') rules.close();
  });

  loadBoard();
  wireTabs();
})();