#!/usr/bin/env node
/**
 * Pulls the Rainbet affiliate wager totals for the current competition cycle,
 * masks the usernames, and writes the static JSON the site reads.
 *
 * Endpoint: GET /v1/external/affiliates?start_at=YYYY-MM-DD&end_at=YYYY-MM-DD&key=...
 * Response: { affiliates: [{ username, id, wagered_amount }], cache_updated_at }
 * The API already returns rows sorted by wagered_amount descending; we sort
 * anyway rather than depend on it.
 *
 * GENERATED FILE. The constants below are written by new-creator.mjs from
 * creators/yetislots.json, which also writes CYCLE_MODE, CYCLE_START_DAY and TZ
 * into assets/app.js. Change the config and regenerate — editing one file alone
 * makes the countdown disagree with the data.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://services.rainbet.com/v1/external/affiliates';

/* --8<-- pure logic: constants, the cycle model and the board builder.
   test/run-tests.mjs extracts everything between these fences verbatim and
   table-tests it, so the code under test is the code that ships. --8<-- */
const TZ = 'Europe/London';
/** 'monthly' = 1st to the last day of the month. 'offset' = day N to day N-1 of the next month. */
const CYCLE_MODE = 'monthly';
const CYCLE_START_DAY = 1;
/** Highest first. Index i is the prize for rank i+1; everyone past the end gets 0. */
const PRIZES = [100,60,40,30,20];
/** Rows rendered before the "show all" toggle. Every player is still shipped so search can find them. */
const BOARD_SIZE = 25;
/**
 * The first cycle this competition ran, as a cycle id, or '' for no limit.
 * Rainbet data exists for months before the leaderboard launched, and archiving
 * one of those would publish a "winners" table for a month in which nobody was
 * competing and no prizes were paid. Earlier cycles are never archived.
 */
const FIRST_CYCLE = '2026-10-01';

/* A weekly board runs alongside the monthly one when the creator funds one.
   It has its own pool, its own archive and its own first cycle; everything
   else — masking, ranking, the board shape — is shared. */
const WEEKLY_ENABLED = false;
const WEEKLY_PRIZES = [];
const WEEKLY_BOARD_SIZE = 25;
const WEEKLY_FIRST_CYCLE = '';

/** Today's date in the leaderboard timezone, as { year, month, day }. */
function todayInTz() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const pad = (n) => String(n).padStart(2, '0');

function previousMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** Day count of a month. Date.UTC(y, m, 0) is the last day of month m (1-based). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The cycle opening in the given month.
 *
 * monthly: the 1st to the month's real last day, so February and 31-day months
 * both come out right.
 *
 * offset: opens on day N and closes on day N-1 of the following month. N is
 * constrained to 2-28, so both the start day and the end day (N-1, landing in
 * 1-27) exist in every month including a non-leap February. 29 is not safe even
 * though its end day is: a cycle opening on the 29th has no start date in a
 * 28-day February. Consecutive cycles tile the timeline with no gap and no
 * overlap.
 */
function cycleStartingIn(year, month) {
  if (CYCLE_MODE === 'monthly') {
    const start = `${year}-${pad(month)}-01`;
    return { id: start, start, end: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}` };
  }
  const end = nextMonth(year, month);
  const start = `${year}-${pad(month)}-${pad(CYCLE_START_DAY)}`;
  return {
    id: start,
    start,
    end: `${end.year}-${pad(end.month)}-${pad(CYCLE_START_DAY - 1)}`,
  };
}

/** The cycle a given date falls inside. */
function cycleContaining({ year, month, day }) {
  if (CYCLE_MODE === 'monthly') return cycleStartingIn(year, month);
  if (day < CYCLE_START_DAY) {
    const prev = previousMonth(year, month);
    return cycleStartingIn(prev.year, prev.month);
  }
  return cycleStartingIn(year, month);
}

/** The cycle that closed immediately before the given one. */
function cycleBefore(cycle) {
  const [y, m] = cycle.start.split('-').map(Number);
  const prev = previousMonth(y, m);
  return cycleStartingIn(prev.year, prev.month);
}

/* Weeks run Monday to Sunday. The arithmetic is whole UTC days, which is exact
   under DST; only the site's countdown converts back to a zoned midnight. */

const DAY_MS = 86400000;

function isoFromTs(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

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

/**
 * Whether to publish full usernames. When false the middle of each handle is
 * starred out, so a player can recognise their own row without the board
 * publishing anyone's full handle. When true the board shows handles in full,
 * which is what most casino leaderboards do - and which cannot be undone for
 * anyone who has already been published.
 */
const SHOW_FULL_USERNAMES = true;

function maskUsername(name) {
  if (SHOW_FULL_USERNAMES) return name;
  const chars = [...name];
  if (chars.length <= 2) return `${chars[0] ?? '*'}**`;
  if (chars.length <= 5) return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars.at(-1)}`;
  return `${chars.slice(0, 2).join('')}${'*'.repeat(chars.length - 4)}${chars.slice(-2).join('')}`;
}

/** Search token: the site hashes what the player types and compares locally. */
function searchHash(name) {
  return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function buildBoard(payload, cycle, prizes = PRIZES, boardSize = BOARD_SIZE, mode = CYCLE_MODE) {
  const rows = payload.affiliates
    .map((a) => ({ username: String(a.username ?? ''), wagered: Number(a.wagered_amount) }))
    .filter((a) => a.username && Number.isFinite(a.wagered) && a.wagered > 0)
    .sort((a, b) => b.wagered - a.wagered);

  const entries = rows.map((row, i) => ({
    rank: i + 1,
    masked: maskUsername(row.username),
    hash: searchHash(row.username),
    wagered: Number(row.wagered.toFixed(2)),
    prize: prizes[i] ?? 0,
  }));

  return {
    cycle: cycle.id,
    periodStart: cycle.start,
    periodEnd: cycle.end,
    cycleMode: mode,
    // A weekly cycle always opens on a Monday, so the offset day means nothing.
    cycleStartDay: mode === 'weekly' ? 1 : CYCLE_START_DAY,
    timezone: TZ,
    fullUsernames: SHOW_FULL_USERNAMES,
    prizePool: prizes.reduce((a, b) => a + b, 0),
    prizes,
    boardSize,
    totalWagered: Number(rows.reduce((sum, r) => sum + r.wagered, 0).toFixed(2)),
    playerCount: rows.length,
    cacheUpdatedAt: payload.cache_updated_at ?? null,
    updatedAt: new Date().toISOString(),
    entries,
  };
}

/**
 * An empty board for a period before the competition opened. Without this, a
 * creator who signs mid-month gets a live board of wagers people placed before
 * any competition existed, with prize amounts beside them - which reads as a
 * real leaderboard that was already running.
 */
function preLaunchBoard(cycle, prizes, boardSize, mode) {
  return {
    cycle: cycle.id,
    periodStart: cycle.start,
    periodEnd: cycle.end,
    cycleMode: mode,
    cycleStartDay: mode === 'weekly' ? 1 : CYCLE_START_DAY,
    timezone: TZ,
    fullUsernames: SHOW_FULL_USERNAMES,
    prizePool: prizes.reduce((a, b) => a + b, 0),
    prizes,
    boardSize,
    totalWagered: 0,
    playerCount: 0,
    cacheUpdatedAt: null,
    updatedAt: new Date().toISOString(),
    entries: [],
    startsOn: FIRST_CYCLE,
  };
}

/**
 * Was this stored board written under a different masking setting than the one
 * in force now? A closed period's totals are final and are never refetched -
 * but if masking has been switched since, the archive is showing names in a
 * form the site no longer uses, and it would stay that way forever.
 *
 * Archives written before this flag existed carry no `fullUsernames`, so fall
 * back to the shape of the names: masking always inserts at least one "*".
 */
function maskingChanged(stored) {
  const wasFull = typeof stored?.fullUsernames === 'boolean'
    ? stored.fullUsernames
    : !(stored?.entries ?? []).every((e) => String(e.masked).includes('*'));
  return wasFull !== SHOW_FULL_USERNAMES;
}

/* --8<-- end of extracted region --8<-- */

const KEY = process.env.RAINBET_API_KEY;
if (!KEY) {
  console.error('RAINBET_API_KEY is not set.');
  process.exit(1);
}

async function fetchCycle({ start, end }) {
  const url = `${ENDPOINT}?start_at=${start}&end_at=${end}&key=${encodeURIComponent(KEY)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Rainbet API ${res.status}: ${body.slice(0, 200)}`);

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Rainbet API returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (!Array.isArray(json.affiliates)) throw new Error(`Unexpected payload: ${body.slice(0, 200)}`);
  return json;
}

const exists = (p) => access(p).then(() => true, () => false);

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

const today = todayInTz();

/**
 * Refreshes one board: writes the current snapshot, archives the period that
 * just closed (once, since a closed period's totals are final), and rebuilds
 * the index of closed periods from what is actually on disk.
 */
async function refresh({ label, dir, file, cycle, previous, prizes, boardSize, firstCycle, periodOf, mode }) {
  // firstCycle guards the live board as well as the archive. Wagers placed
  // before the competition opened are not competition entries.
  const beforeLaunch = firstCycle && cycle.id < firstCycle;
  const board = beforeLaunch
    ? preLaunchBoard(cycle, prizes, boardSize, mode)
    : buildBoard(await fetchCycle(cycle), cycle, prizes, boardSize, mode);
  await writeJson(join(ROOT, 'data', file), board);
  console.log(beforeLaunch
    ? `${label} ${cycle.start}..${cycle.end} is before the first cycle (${firstCycle}) — empty board, nothing fetched`
    : `${label} ${cycle.start}..${cycle.end}: ${board.playerCount} players, $${board.totalWagered} wagered`);

  const archivePath = join(ROOT, 'data', dir, `${previous.id}.json`);
  let stale = false;
  if (await exists(archivePath)) {
    try {
      stale = maskingChanged(JSON.parse(await readFile(archivePath, 'utf8')));
    } catch { stale = false; }
  }
  if (firstCycle && previous.id < firstCycle) {
    console.log(`${label} ${previous.id} is before the first cycle (${firstCycle}) — not archiving`);
  } else if ((await exists(archivePath)) && !stale) {
    console.log(`${label} ${previous.id} already archived`);
  } else {
    if (stale) console.log(`${label} ${previous.id} was archived under the old username setting — rewriting it`);
    try {
      const previousBoard = buildBoard(await fetchCycle(previous), previous, prizes, boardSize, mode);
      if (previousBoard.playerCount > 0) {
        await writeJson(archivePath, previousBoard);
      } else {
        console.log(`${label} ${previous.start}..${previous.end} has no wagers, nothing to archive`);
      }
    } catch (err) {
      console.warn(`${label} could not archive ${previous.id}: ${err.message}`);
    }
  }

  // Rebuilt from disk each run so adding or removing an archive by hand stays
  // consistent. A brand-new site whose first archive attempt found no wagers
  // has no directory yet, and readdir would throw before the index is written.
  const historyDir = join(ROOT, 'data', dir);
  await mkdir(historyDir, { recursive: true });
  const cycles = (await readdir(historyDir))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort()
    .reverse()
    .map(periodOf);
  await writeJson(join(historyDir, 'index.json'), { cycles });
}

await refresh({
  label: 'monthly:',
  mode: CYCLE_MODE,
  dir: 'history',
  file: 'leaderboard.json',
  cycle: cycleContaining(today),
  previous: cycleBefore(cycleContaining(today)),
  prizes: PRIZES,
  boardSize: BOARD_SIZE,
  firstCycle: FIRST_CYCLE,
  periodOf: (id) => {
    const [y, m] = id.split('-').map(Number);
    const { start, end } = cycleStartingIn(y, m);
    return { id, start, end };
  },
});

// The weekly board is a separate competition with its own money behind it.
// Nothing is fetched or written for it unless the creator has funded one.
if (WEEKLY_ENABLED) {
  const week = weekContaining(today);
  await refresh({
    label: 'weekly:',
    mode: 'weekly',
    dir: 'history-weekly',
    file: 'weekly.json',
    cycle: week,
    previous: weekBefore(week),
    prizes: WEEKLY_PRIZES,
    boardSize: WEEKLY_BOARD_SIZE,
    firstCycle: WEEKLY_FIRST_CYCLE,
    periodOf: (id) => {
      const [y, m, d] = id.split('-').map(Number);
      return weekContaining({ year: y, month: m, day: d });
    },
  });
}
