#!/usr/bin/env node
// seatwatch — movie seat-availability watcher for AMC and Alamo Drafthouse.
//
// AMC checks use plain HTTP first (the seat map ships as JSON inside the
// server-rendered page); if that's blocked (403/429), they fall back to a
// Chrome running with --remote-debugging-port=9222 when one is available.
// Alamo has an open JSON API. Runs single-shot and prints JSON — designed
// to be driven by agents or cron, not to daemonize.
//
// Usage:
//   seatwatch theatres <query>
//   seatwatch discover <theatre-slug> [date YYYY-MM-DD] [movie-regex]
//   seatwatch check <showtimeId...> [--want <seat-regex>] [--together N]
//   seatwatch alamo-discover [market=nyc] [movie-regex] [date]
//   seatwatch alamo-check <cinemaId/sessionId...> [--want <seat-regex>] [--together N]
//   seatwatch monitor <add|list|remove|clear|tick|status|install-cron|uninstall-cron> ...
//   seatwatch install-skill [--dev]

import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

let DatabaseSync;

const CDP_HTTP = process.env.SEATWATCH_CDP || "http://127.0.0.1:9222";
const STATE_DIR = join(homedir(), ".seatwatch");
const STATE_FILE = join(STATE_DIR, "state.json");
const MONITOR_DB = join(STATE_DIR, "seatwatch.db");
const THEATRES_CACHE_FILE = join(STATE_DIR, "theatres-cache.json");
const THEATRES_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const ETAGS_FILE = join(STATE_DIR, "etags.json");
// Politeness: max random pre-request delay (ms) so repeated polls don't fire on
// exact clock boundaries. Set SEATWATCH_JITTER_MS=0 to disable (e.g. in tests).
const JITTER_MS = Number(process.env.SEATWATCH_JITTER_MS ?? 1500);
// Fallback cooldown when we're throttled but the origin gives no Retry-After.
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HTML_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Random pre-request pause so a cron-driven poll doesn't hit the origin at the
// exact same instant every interval — cheap way to look less like a robot.
async function politeJitter() {
  if (!(JITTER_MS > 0)) return;
  await sleep(Math.floor(Math.random() * JITTER_MS));
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms.
function parseRetryAfter(res, fallbackMs = DEFAULT_COOLDOWN_MS) {
  const raw = res.headers.get("retry-after");
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  return fallbackMs;
}

// Conditional-request validators, keyed by URL, so an unchanged seat map comes
// back as a cheap 304 instead of a full re-download. Only ever engages if the
// origin actually returned an ETag/Last-Modified — otherwise it's a no-op.
function loadEtags() {
  try { return JSON.parse(readFileSync(ETAGS_FILE, "utf8")); } catch { return {}; }
}
function saveEtags(store) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ETAGS_FILE, JSON.stringify(store, null, 2));
}
function conditionalHeaders(entry) {
  const headers = {};
  if (entry?.etag) headers["If-None-Match"] = entry.etag;
  if (entry?.lastModified) headers["If-Modified-Since"] = entry.lastModified;
  return headers;
}
function storeValidators(url, res, seats) {
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (!etag && !lastModified) return; // origin ignores conditional requests
  const store = loadEtags();
  store[url] = { etag: etag || null, lastModified: lastModified || null, seats };
  saveEtags(store);
}

const STRING_OPTION = { type: "string" };
const CRON_MARKER = "# seatwatch-monitor";

function parseCommandArgs(args, options = {}) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

function compileWant(value) {
  if (value == null) return null;
  try {
    return new RegExp(value, "i");
  } catch (error) {
    throw new Error(`invalid --want regex: ${error.message}`);
  }
}

function parseCheckArgs(args, missingTargetsMessage) {
  const { values, positionals } = parseCommandArgs(args, { want: STRING_OPTION, together: STRING_OPTION });
  const together = values.together == null ? null : Number(values.together);
  if (values.together != null && (!Number.isInteger(together) || together < 1)) {
    throw new Error("--together requires a positive integer");
  }
  if (!positionals.length) throw new Error(missingTargetsMessage);
  return { targets: positionals, want: compileWant(values.want), together };
}

function transformCrontab(existing, newEntry = null) {
  const lines = existing.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept = lines.filter((line) => !line.trimEnd().endsWith(CRON_MARKER));
  if (newEntry) kept.push(newEntry);
  return kept.length ? `${kept.join("\n")}\n` : "";
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function importSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, type, ...args) {
    if (type === "ExperimentalWarning" && warning === "SQLite is an experimental feature and might change at any time") return;
    return emitWarning.call(process, warning, type, ...args);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

// ---------- shared: state, notify, ranking ----------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function notify(title, body) {
  if (process.platform !== "darwin") return;
  spawnSync("osascript", [
    "-e",
    `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`,
  ]);
}

async function notifyWebhook(url, title, text) {
  const parsed = new URL(url);
  let body = text;
  const headers = {};
  if (parsed.hostname === "discord.com" && parsed.pathname.startsWith("/api/webhooks")) {
    body = JSON.stringify({ content: text });
    headers["Content-Type"] = "application/json";
  } else if (parsed.hostname === "hooks.slack.com") {
    body = JSON.stringify({ text });
    headers["Content-Type"] = "application/json";
  } else {
    headers["Content-Type"] = "text/plain; charset=utf-8";
    headers.Title = title;
  }
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Score 0..1: prefer rows ~60% back from the screen, seats centered in the row.
function seatGeometry(seats) {
  const rows = [...new Set(seats.map((s) => s.row))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const byRow = {};
  for (const s of seats) (byRow[s.row] ||= []).push(s.col);
  for (const cols of Object.values(byRow)) cols.sort((a, b) => a - b);
  return { rows, byRow };
}

function scorePosition(rowPositions, col, cols) {
  const rowPos = rowPositions.reduce((sum, n) => sum + n, 0) / rowPositions.length;
  const colPos = cols.length > 1 ? (col - cols[0]) / (cols[cols.length - 1] - cols[0]) : 0.5;
  const score = 1 - (Math.abs(rowPos - 0.6) * 0.9 + Math.abs(colPos - 0.5) * 1.1);
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

function rankSeats(seats /* [{id, row, col, ...}] */) {
  const { rows, byRow } = seatGeometry(seats);
  return seats
    .map((s) => {
      const rowPos = rows.length > 1 ? rows.indexOf(s.row) / (rows.length - 1) : 0.6;
      return { ...s, score: scorePosition([rowPos], s.col, byRow[s.row]) };
    })
    .sort((a, b) => b.score - a.score);
}

function rankTogether(seats, count) {
  const { rows, byRow } = seatGeometry(seats);
  const openByRow = {};
  for (const seat of seats) if (seat.open) (openByRow[seat.row] ||= []).push(seat);
  const runs = [];
  for (const [row, openSeats] of Object.entries(openByRow)) {
    openSeats.sort((a, b) => a.col - b.col);
    for (let i = 0; i <= openSeats.length - count; i++) {
      const run = openSeats.slice(i, i + count);
      if (run.some((seat, j) => j > 0 && seat.col - run[j - 1].col !== 1)) continue;
      const rowPos = rows.length > 1 ? rows.indexOf(run[0].row) / (rows.length - 1) : 0.6;
      const avgCol = run.reduce((sum, seat) => sum + seat.col, 0) / run.length;
      runs.push({ seats: run.map((seat) => seat.id), score: scorePosition(run.map(() => rowPos), avgCol, byRow[row]) });
    }
  }
  return runs.sort((a, b) => b.score - a.score);
}

function diffAndReport({ state, key, allSeats, want, together }) {
  // allSeats: [{id, row, col, open}]
  const open = allSeats.filter((s) => s.open).map((s) => s.id);
  const prev = new Set(state[key]?.open || []);
  const newlyOpen = open.filter((s) => !prev.has(s) && (!want || want.test(s)));
  const bestOpen = rankSeats(allSeats)
    .filter((s) => s.open)
    .slice(0, 10)
    .map(({ id, score }) => ({ id, score }));
  const togetherRuns = together ? rankTogether(allSeats, together) : [];
  const newlyOpenSet = new Set(newlyOpen);
  const notifyTogether = togetherRuns.find((run) => run.seats.some((id) => newlyOpenSet.has(id)));
  const initialized = state[key + ":initialized"];
  state[key] = { open, total: allSeats.length, checkedAt: new Date().toISOString() };
  state[key + ":initialized"] = true;
  return {
    open,
    newlyOpen,
    bestOpen,
    bestTogether: togetherRuns.slice(0, 5),
    notifyTogether,
    total: allSeats.length,
    shouldNotify: initialized && (together ? !!notifyTogether : newlyOpen.length > 0),
  };
}

// ---------- monitor database ----------
function openMonitorDb() {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(MONITOR_DB);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain TEXT NOT NULL CHECK (chain IN ('amc', 'alamo')),
      target TEXT NOT NULL,
      label TEXT,
      want TEXT,
      notifyUrl TEXT,
      intervalMinutes INTEGER NOT NULL DEFAULT 10 CHECK (intervalMinutes >= 1),
      until TEXT,
      createdAt TEXT NOT NULL,
      lastChecked TEXT,
      lastOpenCount INTEGER,
      lastResult TEXT,
      seatState TEXT,
      initialized INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchId INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      openCount INTEGER,
      newlyOpen TEXT NOT NULL DEFAULT '[]',
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS checks_watch_ts ON checks(watchId, ts DESC);
  `);
  // Migrations for columns added after the initial schema shipped.
  const columns = db.prepare("PRAGMA table_info(watches)").all().map((c) => c.name);
  if (!columns.includes("cooldownUntil")) db.exec("ALTER TABLE watches ADD COLUMN cooldownUntil TEXT");
  if (!columns.includes("notifyUrl")) db.exec("ALTER TABLE watches ADD COLUMN notifyUrl TEXT");
  return db;
}

function monitorState(watch) {
  const key = `${watch.chain}:${watch.target}`;
  let open = [];
  try { open = JSON.parse(watch.seatState || "[]"); } catch {}
  return { key, state: { [key]: { open }, [`${key}:initialized`]: !!watch.initialized } };
}

function monitorStatusName(watch, now = Date.now()) {
  if (!watch.active) return "expired";
  return watch.until && Date.parse(watch.until) <= now ? "expired" : "active";
}

function effectiveIntervalMinutes(watch, now = Date.now()) {
  const remaining = watch.until ? Date.parse(watch.until) - now : Infinity;
  return remaining > 0 && remaining <= 2 * 60 * 60 * 1000
    ? Math.min(watch.intervalMinutes, 2)
    : watch.intervalMinutes;
}

function publicWatch(watch, now = Date.now()) {
  return {
    id: watch.id,
    chain: watch.chain,
    target: watch.target,
    label: watch.label,
    want: watch.want,
    notifyUrl: watch.notifyUrl,
    interval: watch.intervalMinutes,
    effectiveInterval: effectiveIntervalMinutes(watch, now),
    until: watch.until,
    lastChecked: watch.lastChecked,
    lastOpenCount: watch.lastOpenCount,
    cooldownUntil: watch.cooldownUntil && Date.parse(watch.cooldownUntil) > now ? watch.cooldownUntil : null,
    status: monitorStatusName(watch, now),
  };
}

// ---------- AMC via plain HTTP ----------
// The seat map lives inside the page's React flight data as escaped JSON:
//   \"seatingLayout\":{\"columns\":13,...,\"seats\":[{\"available\":true,...}]}
function extractSeatingLayout(html) {
  const text = html.replace(/\\"/g, '"');
  const anchor = text.indexOf('"seatingLayout":');
  if (anchor < 0) return null;
  const start = text.indexOf("{", anchor);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function amcFetchSeatsHttp(showtimeId) {
  const url = `https://www.amctheatres.com/showtimes/${showtimeId}/seats`;
  await politeJitter();
  const cached = loadEtags()[url];
  const res = await fetch(url, { headers: { ...HTML_HEADERS, ...conditionalHeaders(cached) } });
  if (res.status === 304 && cached?.seats) return { seats: cached.seats, notModified: true };
  if (res.status === 429 || res.status === 403) return { blocked: res.status, retryAfterMs: parseRetryAfter(res) };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const layout = extractSeatingLayout(await res.text());
  if (!layout?.seats?.length) return { error: "no seatingLayout in page (expired showtime or page change)" };
  const seats = layout.seats
    .filter((s) => s.type !== "NotASeat")
    .map((s) => ({ id: s.name || `r${s.row}c${s.column}`, row: s.row, col: s.column, open: !!s.available, tier: s.seatTier }));
  storeValidators(url, res, seats);
  return { seats };
}

// Discover: pair each showtime object with the nearest preceding
// 'Showtimes for <Movie>' anchor in the flight data.
async function amcDiscoverHttp(slug, date) {
  const url = `https://www.amctheatres.com/movie-theatres/${slug}/showtimes${date ? `?date=${date}` : ""}`;
  const res = await fetch(url, { headers: HTML_HEADERS });
  if (res.status === 429 || res.status === 403) return { blocked: res.status };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const text = (await res.text()).replace(/\\"/g, '"');
  const decode = (s) =>
    s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, "&");
  const anchors = [...text.matchAll(/aria-label":"Showtimes for ([^"]+)"/g)].map((m) => [m.index, decode(m[1])]);
  const rows = [];
  for (const m of text.matchAll(/"showtimeId":(\d+),[^{}]*?"status":"(\w+)","showDateTimeUtc":"([^"]+)"[^{}]*?"display":\{"time":"([^"]+)","amPm":"([^"]+)"/g)) {
    let movie = null;
    for (const [pos, name] of anchors) {
      if (pos < m.index) movie = name;
      else break;
    }
    rows.push({ id: m[1], movie: movie || "?", status: m[2], utc: m[3], time: `${m[4]}${m[5]}` });
  }
  return { rows };
}

// ---------- AMC via Chrome CDP (fallback when HTTP is blocked) ----------
let ws, msgId = 0, sharedContextId = null;
const pending = new Map();

async function connectBrowser() {
  const res = await fetch(`${CDP_HTTP}/json/version`).catch(() => null);
  if (!res?.ok) throw new Error(`Chrome CDP not reachable at ${CDP_HTTP} — HTTP path was blocked and no fallback browser is available`);
  const { webSocketDebuggerUrl } = await res.json();
  ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
}

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function withPage(url, fn, { timeoutMs = 25000 } = {}) {
  if (!ws) await connectBrowser();
  if (!sharedContextId) {
    ({ browserContextId: sharedContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true }));
  }
  const { targetId } = await send("Target.createTarget", { url, browserContextId: sharedContextId, background: true });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await send("Runtime.enable", {}, sessionId);
    const evaluate = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expr)) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    };
    return await fn({ evaluate, waitFor });
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function amcFetchSeatsCdp(showtimeId) {
  const url = `https://www.amctheatres.com/showtimes/${showtimeId}/seats`;
  return withPage(url, async ({ evaluate, waitFor }) => {
    const ok = await waitFor(`document.querySelectorAll('[role="checkbox"], input[type="checkbox"]').length > 0`);
    if (!ok) {
      const text = await evaluate(`document.body.innerText.slice(0, 200)`);
      if (/rate limited|error 1015|access denied/i.test(text || "")) return { blocked: 1015 };
      return { error: "seat map did not load" };
    }
    const seats = await evaluate(`(() => {
      const boxes = [...document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')];
      return boxes.map(b => b.getAttribute('aria-label') || '').filter(Boolean).map(l => {
        const occupied = /occupied/i.test(l);
        const m = l.match(/([A-Z]{1,2})(\\d{1,3})\\s*$/);
        return m ? { id: m[1] + m[2], row: m[1], col: Number(m[2]), open: !occupied } : null;
      }).filter(Boolean);
    })()`);
    return { seats };
  });
}

// ---------- Alamo (open JSON API) ----------
async function alamoDiscover(market, movieRe, date) {
  const res = await fetch(`https://drafthouse.com/s/mother/v2/schedule/market/${market}`);
  if (!res.ok) throw new Error(`alamo schedule fetch failed (${res.status})`);
  const { data } = await res.json();
  const cinemas = Object.fromEntries((data.market?.[0]?.cinemas || []).map((c) => [c.id, c.name]));
  const re = movieRe ? new RegExp(movieRe, "i") : null;
  const rows = [];
  for (const s of data.sessions || []) {
    if (re && !re.test(s.presentationSlug || "")) continue;
    if (date && !(s.showTimeClt || "").startsWith(date)) continue;
    rows.push({ id: `${s.cinemaId}/${s.sessionId}`, movie: s.presentationSlug, time: s.showTimeClt, cinema: cinemas[s.cinemaId] || s.cinemaId, status: s.status });
  }
  return rows;
}

async function alamoFetchSeats(pair) {
  const [cinemaId, sessionId] = pair.split("/");
  const url = `https://drafthouse.com/s/mother/v1/app/seats/${cinemaId}/${sessionId}`;
  await politeJitter();
  const cached = loadEtags()[url];
  const res = await fetch(url, { headers: conditionalHeaders(cached) });
  if (res.status === 304 && cached?.seats) return { seats: cached.seats, notModified: true };
  if (res.status === 429 || res.status === 403) return { blocked: res.status, retryAfterMs: parseRetryAfter(res) };
  if (!res.ok) return { error: `seat fetch failed (${res.status})` };
  const { data } = await res.json();
  const seats = [];
  for (const area of data.seatingData?.areas || [])
    for (const row of area.rows || [])
      for (const seat of row.seats || []) {
        if (seat.seatStatus === "NONE") continue;
        seats.push({
          id: `${row.name || row.rowNumber || ""}${seat.seatNumber}`,
          row: seat.rowIndex,
          col: seat.columnIndex,
          open: seat.seatStatus === "EMPTY",
        });
      }
  storeValidators(url, res, seats);
  return { seats };
}

// ---------- theatre index ----------
function decodeXml(s = "") {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseAmcTheatreSitemap(xml) {
  const attribute = (block, name) =>
    decodeXml((block.match(new RegExp(`<Attribute name="${name}">([\\s\\S]*?)<\\/Attribute>`)) || [])[1]);
  const theatres = [];
  for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const slug = (block.match(/<loc>https:\/\/www\.amctheatres\.com\/movie-theatres\/([^<]+)<\/loc>/) || [])[1];
    const name = attribute(block, "title");
    if (!slug || !name) continue;
    theatres.push({
      chain: "AMC",
      slug: decodeXml(slug),
      name,
      address: attribute(block, "addressLine1"),
      city: attribute(block, "city"),
      state: attribute(block, "state"),
      postalCode: attribute(block, "postalCode"),
    });
  }
  return theatres;
}

async function fetchAmcTheatres() {
  const root = await fetch("https://www.amctheatres.com/sitemap.xml", {
    headers: HTML_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (root.status === 403 || root.status === 429) throw new Error(`AMC sitemap blocked (HTTP ${root.status})`);
  if (!root.ok) throw new Error(`AMC sitemap fetch failed (HTTP ${root.status})`);
  const rootXml = await root.text();
  const sitemapUrl = decodeXml(
    (rootXml.match(/<loc>(https:\/\/www\.amctheatres\.com\/sitemaps\/[^<]*theatre[^<]*\.xml)<\/loc>/i) || [])[1],
  );
  if (!sitemapUrl) throw new Error("AMC theatre sitemap was not listed in sitemap.xml");
  await sleep(3000);
  const res = await fetch(sitemapUrl, { headers: HTML_HEADERS, signal: AbortSignal.timeout(30000) });
  if (res.status === 403 || res.status === 429) throw new Error(`AMC theatre sitemap blocked (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`AMC theatre sitemap fetch failed (HTTP ${res.status})`);
  const theatres = parseAmcTheatreSitemap(await res.text());
  if (!theatres.length) throw new Error("AMC theatre sitemap contained no theatres");
  return theatres;
}

function bundledAmcTheatres() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "data", "amc-theatres.json"), "utf8")).map((t) => ({
    chain: "AMC",
    ...t,
  }));
}

async function fetchAlamoTheatres() {
  const base = "https://drafthouse.com/s/mother";
  const national = await fetch(`${base}/v1/page/cclamp?useUnifiedSchedule=true`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!national.ok) throw new Error(`Alamo market index fetch failed (HTTP ${national.status})`);
  const { data } = await national.json();
  const markets = (data.marketSummaries || []).filter((m) => m.slug && !["national", "test"].includes(m.slug));
  if (!markets.length) throw new Error("Alamo market index contained no markets");
  const results = await Promise.allSettled(
    markets.map(async (market) => {
      const res = await fetch(`${base}/v1/page/cclamp/${market.slug}?useUnifiedSchedule=true`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`${market.slug}: HTTP ${res.status}`);
      const body = await res.json();
      return (body.data?.cinemaSummaries || []).map((cinema) => ({
        chain: "Alamo",
        market: market.slug,
        marketName: market.name,
        name: cinema.name,
        address: [cinema.street1, cinema.street2].filter(Boolean).join(", "),
        city: cinema.city,
        state: cinema.state,
        postalCode: cinema.postalCode,
      }));
    }),
  );
  const theatres = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!theatres.length) throw new Error("Alamo cinema indexes contained no cinemas");
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) process.stderr.write(`Warning: ${failures.length} Alamo market index(es) could not be fetched.\n`);
  return theatres;
}

function loadTheatreCache() {
  try {
    const cache = JSON.parse(readFileSync(THEATRES_CACHE_FILE, "utf8"));
    if (Date.now() - new Date(cache.fetchedAt).getTime() < THEATRES_CACHE_TTL && cache.amc?.length && cache.alamo?.length) {
      return cache;
    }
  } catch {}
  return null;
}

async function theatreIndex() {
  const cached = loadTheatreCache();
  if (cached) return cached;
  const [amcResult, alamoResult] = await Promise.allSettled([fetchAmcTheatres(), fetchAlamoTheatres()]);
  let amc;
  if (amcResult.status === "fulfilled") amc = amcResult.value;
  else {
    process.stderr.write(`Warning: ${amcResult.reason.message}; using bundled AMC theatre index.\n`);
    amc = bundledAmcTheatres();
  }
  if (alamoResult.status === "rejected") throw new Error(alamoResult.reason.message);
  const cache = { fetchedAt: new Date().toISOString(), amc, alamo: alamoResult.value };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(THEATRES_CACHE_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

function theatreLocation(t) {
  return [t.address, [t.city, t.state].filter(Boolean).join(", ") + (t.postalCode ? ` ${t.postalCode}` : "")]
    .filter(Boolean)
    .join(", ");
}

async function cmdTheatres(query) {
  if (!query) throw new Error("theatre query required, e.g. theatres lincoln square");
  const index = await theatreIndex();
  const needle = query.toLowerCase();
  const matches = [...index.amc, ...index.alamo].filter((t) =>
    [t.name, t.city, t.state, t.marketName].filter(Boolean).join(" ").toLowerCase().includes(needle),
  );
  for (const t of matches) {
    console.log(`${t.chain}\t${t.slug || t.market}\t${t.name}\t${theatreLocation(t)}`);
  }
  if (!matches.length) process.stderr.write("No theatres matched; try a broader theatre, city, or state query.\n");
}

// ---------- commands ----------
async function cmdDiscover(slug, date, movieRe) {
  if (!slug) throw new Error("theatre slug required, e.g. new-york-city/amc-lincoln-square-13");
  let r = await amcDiscoverHttp(slug, date);
  if (r.blocked) {
    process.stderr.write(`HTTP blocked (${r.blocked}); falling back to Chrome CDP...\n`);
    const url = `https://www.amctheatres.com/movie-theatres/${slug}/showtimes${date ? `?date=${date}` : ""}`;
    const rows = await withPage(url, async ({ evaluate, waitFor }) => {
      await waitFor(`document.querySelector('a[href*="/showtimes/"]') !== null`);
      return await evaluate(`(() => {
        const out = [];
        for (const region of document.querySelectorAll('[aria-label^="Showtimes for"]')) {
          const movie = region.getAttribute('aria-label').replace(/^Showtimes for /, '');
          for (const a of region.querySelectorAll('a[href*="/showtimes/"]')) {
            const id = (a.getAttribute('href').match(/showtimes\\/(\\d+)/) || [])[1];
            if (id) out.push({ id, movie, time: a.textContent.trim() });
          }
        }
        return out;
      })()`);
    });
    r = { rows };
  }
  if (r.error) throw new Error(r.error);
  const re = movieRe ? new RegExp(movieRe, "i") : null;
  const seen = new Set();
  for (const row of r.rows) {
    if (re && !re.test(row.movie)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    console.log(`${row.id}\t${row.movie}\t${row.time}${row.status ? `\t${row.status}` : ""}`);
  }
  if (!seen.size) process.stderr.write("No showtimes matched; verify the theatre slug, date, and movie regex.\n");
}

function backoffMessage(status, retryAfterMs) {
  const mins = Math.max(1, Math.round((retryAfterMs ?? DEFAULT_COOLDOWN_MS) / 60000));
  return `rate limited (${status}) on both paths — back off ~${mins} min`;
}

async function cmdCheck(ids, want, together) {
  const state = loadState();
  const report = [];
  for (const id of ids) {
    let r = await amcFetchSeatsHttp(id);
    const retryAfterMs = r.retryAfterMs;
    if (r.blocked) {
      process.stderr.write(`HTTP blocked (${r.blocked}) for ${id}; trying Chrome CDP fallback...\n`);
      r = await amcFetchSeatsCdp(id).catch((e) => ({ error: e.message }));
    }
    if (r.blocked) { report.push({ id, error: backoffMessage(r.blocked, r.retryAfterMs ?? retryAfterMs) }); continue; }
    if (r.error) { report.push({ id, error: r.error }); continue; }
    const d = diffAndReport({ state, key: id, allSeats: r.seats, want, together });
    report.push({ id, total: d.total, openCount: d.open.length, open: d.open, bestOpen: d.bestOpen, ...(together && { bestTogether: d.bestTogether }), newlyOpen: d.newlyOpen });
    if (d.shouldNotify) {
      const body = together
        ? `${d.notifyTogether.seats.join(", ")} available together; newly opened: ${d.newlyOpen.join(", ")} (${d.open.length} open total)`
        : `${d.newlyOpen.join(", ")} now available (${d.open.length} open total)`;
      notify(`Seats opened: showtime ${id}`, body);
    }
  }
  saveState(state);
  console.log(JSON.stringify(report, null, 2));
}

async function cmdAlamoCheck(pairs, want, together) {
  const state = loadState();
  const report = [];
  for (const pair of pairs) {
    const r = await alamoFetchSeats(pair);
    if (r.blocked) { report.push({ id: pair, error: backoffMessage(r.blocked, r.retryAfterMs) }); continue; }
    if (r.error) { report.push({ id: pair, error: r.error }); continue; }
    const d = diffAndReport({ state, key: `alamo:${pair}`, allSeats: r.seats, want, together });
    report.push({ id: pair, total: d.total, openCount: d.open.length, open: d.open, bestOpen: d.bestOpen, ...(together && { bestTogether: d.bestTogether }), newlyOpen: d.newlyOpen });
    if (d.shouldNotify) {
      const body = together
        ? `${d.notifyTogether.seats.join(", ")} available together; newly opened: ${d.newlyOpen.join(", ")} (${d.open.length} open total)`
        : `${d.newlyOpen.join(", ")} now available (${d.open.length} open total)`;
      notify(`Alamo seats opened: ${pair}`, body);
    }
  }
  saveState(state);
  console.log(JSON.stringify(report, null, 2));
}

// ---------- monitor commands ----------
function cmdMonitorAdd(positionals, options) {
  const [chain, target] = positionals;
  if (!["amc", "alamo"].includes(chain)) throw new Error("monitor add chain must be amc or alamo");
  if (!target) throw new Error("monitor add target required");
  if (positionals.length > 2) throw new Error("monitor add accepts only a chain and target");
  if (chain === "amc" && !/^\d+$/.test(target)) throw new Error("AMC target must be a showtimeId");
  if (chain === "alamo" && !/^\d+\/\d+$/.test(target)) throw new Error("Alamo target must be cinemaId/sessionId");

  const { want = null, label = null, notify: notifyUrl = null, until: untilRaw, interval: intervalRaw = "10" } = options;
  compileWant(want);
  if (notifyUrl) {
    let parsed;
    try { parsed = new URL(notifyUrl); } catch {}
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) throw new Error("--notify must be an http(s) URL");
  }
  const intervalMinutes = Number(intervalRaw);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) throw new Error("--interval must be a positive whole number of minutes");
  let until = null;
  if (untilRaw) {
    const parsed = Date.parse(untilRaw);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(untilRaw) || !Number.isFinite(parsed)) throw new Error("--until must be an ISO datetime");
    until = new Date(parsed).toISOString();
  }

  const db = openMonitorDb();
  try {
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO watches (chain, target, label, want, notifyUrl, intervalMinutes, until, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chain, target, label, want, notifyUrl, intervalMinutes, until, createdAt);
    const watch = db.prepare("SELECT * FROM watches WHERE id = ?").get(result.lastInsertRowid);
    console.log(JSON.stringify(publicWatch(watch), null, 2));
  } finally {
    db.close();
  }
}

function cmdMonitorList() {
  const db = openMonitorDb();
  try {
    const now = Date.now();
    const watches = db.prepare("SELECT * FROM watches ORDER BY id").all().map((watch) => publicWatch(watch, now));
    console.log(JSON.stringify(watches, null, 2));
  } finally {
    db.close();
  }
}

function cmdMonitorRemove(watchId) {
  if (!/^\d+$/.test(watchId || "")) throw new Error("monitor remove requires a numeric watchId");
  const db = openMonitorDb();
  try {
    const result = db.prepare("DELETE FROM watches WHERE id = ?").run(Number(watchId));
    if (!result.changes) throw new Error(`watch ${watchId} not found`);
    console.log(JSON.stringify({ removed: Number(watchId) }));
  } finally {
    db.close();
  }
}

function cmdMonitorClear() {
  const db = openMonitorDb();
  try {
    const result = db.prepare("DELETE FROM watches").run();
    console.log(JSON.stringify({ cleared: Number(result.changes) }));
  } finally {
    db.close();
  }
}

function readCrontab() {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  if (/no crontab for/i.test(result.stderr)) return "";
  throw new Error(`could not read crontab: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function writeCrontab(table) {
  const result = spawnSync("crontab", ["-"], { input: table, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not write crontab: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function cmdMonitorInstallCron({ every: everyRaw = "2" }) {
  const every = Number(everyRaw);
  if (!Number.isInteger(every) || every < 1 || every > 59) {
    throw new Error("--every must be a whole number of minutes from 1 to 59");
  }
  const cliPath = fileURLToPath(import.meta.url);
  const entry = `*/${every} * * * * ${shellQuote(process.execPath)} ${shellQuote(cliPath)} monitor tick >> ~/.seatwatch/tick.log 2>&1 ${CRON_MARKER}`;
  mkdirSync(STATE_DIR, { recursive: true });
  writeCrontab(transformCrontab(readCrontab(), entry));
  console.log(entry);
  console.log(`Runs every ${every} minute${every === 1 ? "" : "s"}; tick cheaply decides which watches are due.`);
  if (cliPath.includes("/_npx/")) {
    console.warn("warning: cli.js is inside an npx cache; run `npm i -g seatwatch` and reinstall cron for a stable path.");
  }
}

function cmdMonitorUninstallCron() {
  const existing = readCrontab();
  const removed = existing.split("\n").filter((line) => line.trimEnd().endsWith(CRON_MARKER));
  if (!removed.length) {
    console.log("nothing installed");
    return;
  }
  writeCrontab(transformCrontab(existing));
  for (const line of removed) console.log(`removed: ${line}`);
}

async function fetchMonitorSeats(watch) {
  if (watch.chain === "alamo") {
    const result = await alamoFetchSeats(watch.target);
    if (result.blocked) return { error: backoffMessage(result.blocked, result.retryAfterMs), cooldownMs: result.retryAfterMs ?? DEFAULT_COOLDOWN_MS };
    return result;
  }
  let result = await amcFetchSeatsHttp(watch.target);
  const retryAfterMs = result.retryAfterMs;
  if (result.blocked) {
    process.stderr.write(`HTTP blocked (${result.blocked}) for ${watch.target}; trying Chrome CDP fallback...\n`);
    result = await amcFetchSeatsCdp(watch.target).catch((e) => ({ error: e.message }));
  }
  if (result.blocked) {
    const cooldownMs = result.retryAfterMs ?? retryAfterMs ?? DEFAULT_COOLDOWN_MS;
    return { error: backoffMessage(result.blocked, cooldownMs), cooldownMs };
  }
  return result;
}

async function cmdMonitorTick() {
  const db = openMonitorDb();
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const summary = { checkedAt, checked: 0, skipped: 0, expired: 0, alerts: 0, results: [] };
  try {
    const watches = db.prepare("SELECT * FROM watches WHERE active = 1 ORDER BY id").all();
    const updateSuccess = db.prepare(`
      UPDATE watches SET lastChecked = ?, lastOpenCount = ?, lastResult = ?, seatState = ?, initialized = 1, cooldownUntil = NULL WHERE id = ?
    `);
    const updateError = db.prepare("UPDATE watches SET lastChecked = ?, lastResult = ?, cooldownUntil = ? WHERE id = ?");
    const insertCheck = db.prepare("INSERT INTO checks (watchId, ts, openCount, newlyOpen, result) VALUES (?, ?, ?, ?, ?)");

    for (const watch of watches) {
      if (watch.until && Date.parse(watch.until) <= now) {
        db.prepare("UPDATE watches SET active = 0 WHERE id = ?").run(watch.id);
        summary.expired++;
        summary.results.push({ watchId: watch.id, chain: watch.chain, target: watch.target, status: "expired" });
        continue;
      }
      if (watch.cooldownUntil && Date.parse(watch.cooldownUntil) > now) {
        summary.skipped++;
        summary.results.push({ watchId: watch.id, chain: watch.chain, target: watch.target, status: "cooling-down", cooldownUntil: watch.cooldownUntil });
        continue;
      }
      const effectiveInterval = effectiveIntervalMinutes(watch, now);
      const elapsed = watch.lastChecked ? now - Date.parse(watch.lastChecked) : Infinity;
      if (elapsed < effectiveInterval * 60 * 1000) {
        summary.skipped++;
        summary.results.push({ watchId: watch.id, chain: watch.chain, target: watch.target, status: "not-due", effectiveInterval });
        continue;
      }

      summary.checked++;
      const fetched = await fetchMonitorSeats(watch);
      if (fetched.error) {
        const cooldownUntil = fetched.cooldownMs
          ? new Date(now + fetched.cooldownMs).toISOString()
          : watch.cooldownUntil ?? null;
        const result = { watchId: watch.id, chain: watch.chain, target: watch.target, status: "error", error: fetched.error, ...(cooldownUntil && { cooldownUntil }) };
        const resultJson = JSON.stringify(result);
        db.exec("BEGIN");
        try {
          updateError.run(checkedAt, resultJson, cooldownUntil, watch.id);
          insertCheck.run(watch.id, checkedAt, null, "[]", resultJson);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        summary.results.push(result);
        continue;
      }

      const { key, state } = monitorState(watch);
      const want = compileWant(watch.want);
      const diff = diffAndReport({ state, key, allSeats: fetched.seats, want });
      const newlyOpen = diff.newlyOpen;
      const alertSeats = diff.shouldNotify ? newlyOpen : [];
      const result = {
        watchId: watch.id,
        chain: watch.chain,
        target: watch.target,
        status: "checked",
        effectiveInterval,
        total: diff.total,
        openCount: diff.open.length,
        open: diff.open,
        bestOpen: diff.bestOpen,
        newlyOpen,
      };
      if (alertSeats.length) {
        summary.alerts++;
        const title = watch.chain === "alamo" ? `Alamo seats opened: ${watch.target}` : `Seats opened: showtime ${watch.target}`;
        notify(title, `${alertSeats.join(", ")} now available (${diff.open.length} open total)`);
        if (watch.notifyUrl) {
          const bookingUrl = watch.chain === "amc"
            ? `https://www.amctheatres.com/showtimes/${watch.target}/seats`
            : "https://drafthouse.com";
          const text = `${watch.label || `${watch.chain}/${watch.target}`}: ${alertSeats.join(", ")} now available (${diff.open.length} open total) — ${bookingUrl}`;
          try {
            await notifyWebhook(watch.notifyUrl, title, text);
            result.notifyStatus = "sent";
          } catch (error) {
            result.notifyStatus = "failed";
            process.stderr.write(`Webhook notification failed for watch ${watch.id}: ${error.message}\n`);
          }
        }
      }
      const resultJson = JSON.stringify(result);
      db.exec("BEGIN");
      try {
        updateSuccess.run(checkedAt, diff.open.length, resultJson, JSON.stringify(diff.open), watch.id);
        insertCheck.run(watch.id, checkedAt, diff.open.length, JSON.stringify(alertSeats), resultJson);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      summary.results.push(result);
    }
    console.log(JSON.stringify(summary, null, 2));
    return summary.alerts > 0;
  } finally {
    db.close();
  }
}

function parseResult(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function cmdMonitorStatus(watchId) {
  if (watchId != null && !/^\d+$/.test(watchId)) throw new Error("monitor status watchId must be numeric");
  const db = openMonitorDb();
  try {
    const now = Date.now();
    const watches = watchId == null
      ? db.prepare("SELECT * FROM watches ORDER BY id").all()
      : [db.prepare("SELECT * FROM watches WHERE id = ?").get(Number(watchId))].filter(Boolean);
    if (watchId != null && !watches.length) throw new Error(`watch ${watchId} not found`);
    const recent = db.prepare(`
      SELECT ts, openCount, newlyOpen FROM checks
      WHERE watchId = ? AND newlyOpen != '[]' ORDER BY ts DESC LIMIT 10
    `);
    const output = watches.map((watch) => ({
      ...publicWatch(watch, now),
      lastResult: parseResult(watch.lastResult),
      recentNewlyOpen: recent.all(watch.id).map((row) => ({
        ts: row.ts,
        openCount: row.openCount,
        seats: parseResult(row.newlyOpen) || [],
      })),
    }));
    console.log(JSON.stringify(watchId == null ? output : output[0], null, 2));
  } finally {
    db.close();
  }
}

// ---------- skill installer ----------
function cmdInstallSkill({ dev }) {
  const here = dirname(fileURLToPath(import.meta.url));
  let body = readFileSync(join(here, "skill", "SKILL.md"), "utf8");
  if (dev) body = body.replaceAll("npx -y seatwatch", `node ${join(here, "cli.js")}`);
  const targets = [join(homedir(), ".claude", "skills", "seatwatch"), join(homedir(), ".bb", "skills", "seatwatch")];
  for (const dir of targets) {
    if (existsSync(dir) && !existsSync(join(dir, "SKILL.md"))) continue; // don't clobber non-skill dirs
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
    console.log(`installed skill → ${join(dir, "SKILL.md")}`);
  }
  console.log("\nThe skill is picked up by newly started agent sessions/threads.");
}

// ---------- main ----------
async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "theatres") {
      const { positionals } = parseCommandArgs(rest);
      await cmdTheatres(positionals.join(" "));
    } else if (cmd === "discover") {
      const { positionals } = parseCommandArgs(rest);
      if (positionals.length > 3) throw new Error("discover accepts at most a theatre slug, date, and movie regex");
      await cmdDiscover(positionals[0], positionals[1], positionals[2]);
    } else if (cmd === "check") {
      const { targets, want, together } = parseCheckArgs(rest, "check requires at least one showtimeId from discover");
      await cmdCheck(targets, want, together);
    } else if (cmd === "alamo-discover") {
      const { positionals } = parseCommandArgs(rest);
      if (positionals.length > 3) throw new Error("alamo-discover accepts at most a market, movie regex, and date");
      const rows = await alamoDiscover(positionals[0] || "nyc", positionals[1], positionals[2]);
      for (const r of rows) console.log(`${r.id}\t${r.movie}\t${r.time}\t${r.cinema}\t${r.status}`);
      if (!rows.length) process.stderr.write("No sessions matched; verify the market, movie regex, and date.\n");
    } else if (cmd === "alamo-check") {
      const { targets, want, together } = parseCheckArgs(rest, "alamo-check requires at least one cinemaId/sessionId from alamo-discover");
      await cmdAlamoCheck(targets, want, together);
    } else if (cmd === "monitor") {
      const [subcommand, ...monitorArgs] = rest;
      let parsed;
      if (subcommand === "add") {
        parsed = parseCommandArgs(monitorArgs, { want: STRING_OPTION, label: STRING_OPTION, notify: STRING_OPTION, until: STRING_OPTION, interval: STRING_OPTION });
      } else if (subcommand === "install-cron") {
        parsed = parseCommandArgs(monitorArgs, { every: STRING_OPTION });
      } else if (["list", "remove", "clear", "tick", "status", "uninstall-cron"].includes(subcommand)) {
        parsed = parseCommandArgs(monitorArgs);
      } else {
        throw new Error("monitor command must be add, list, remove, clear, tick, status, install-cron, or uninstall-cron");
      }
      const maxPositionals = ["remove", "status"].includes(subcommand) ? 1 : subcommand === "add" ? 2 : 0;
      if (parsed.positionals.length > maxPositionals) throw new Error(`monitor ${subcommand} received too many arguments`);
      if (subcommand === "install-cron") cmdMonitorInstallCron(parsed.values);
      else if (subcommand === "uninstall-cron") cmdMonitorUninstallCron();
      else {
        ({ DatabaseSync } = await importSqlite());
        if (subcommand === "add") cmdMonitorAdd(parsed.positionals, parsed.values);
        else if (subcommand === "list") cmdMonitorList();
        else if (subcommand === "remove") cmdMonitorRemove(parsed.positionals[0]);
        else if (subcommand === "clear") cmdMonitorClear();
        else if (subcommand === "tick") return (await cmdMonitorTick()) ? 3 : 0;
        else cmdMonitorStatus(parsed.positionals[0]);
      }
    } else if (cmd === "install-skill") {
      const { values, positionals } = parseCommandArgs(rest, { dev: { type: "boolean" } });
      if (positionals.length) throw new Error("install-skill does not accept positional arguments");
      cmdInstallSkill({ dev: values.dev });
    } else {
      console.error(`usage:
  seatwatch theatres <query>                                  # resolve AMC slugs / Alamo markets
  seatwatch discover <theatre-slug> [date] [movie-regex]      # AMC showtimes
  seatwatch check <showtimeId...> [--want <seat-regex>] [--together N]
  seatwatch alamo-discover [market=nyc] [movie-regex] [date]  # Alamo sessions
  seatwatch alamo-check <cinemaId/sessionId...> [--want <seat-regex>] [--together N]
  seatwatch monitor add <amc|alamo> <id> [--want <seat-regex>] [--label <text>] [--notify <url>] [--until <ISO-datetime>] [--interval <minutes>]
  seatwatch monitor list                                      # list watches
  seatwatch monitor remove <watchId>                          # remove one watch
  seatwatch monitor clear                                     # remove all watches
  seatwatch monitor tick                                      # check active watches that are due
  seatwatch monitor status [watchId]                          # cached status; no network
  seatwatch monitor install-cron [--every <minutes>]          # install recurring ticks (default: 2)
  seatwatch monitor uninstall-cron                            # remove recurring ticks
  seatwatch install-skill [--dev]                             # install the agent skill`);
      return 2;
    }
    return 0;
  } catch (e) {
    console.error("seatwatch error:", e.message);
    return 1;
  }
}

export { extractSeatingLayout, effectiveIntervalMinutes, monitorStatusName, notifyWebhook, rankTogether, parseRetryAfter, conditionalHeaders, transformCrontab, main };

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  process.exitCode = await main();
}
