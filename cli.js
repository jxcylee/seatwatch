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
//   seatwatch discover <theatre-slug> [date YYYY-MM-DD] [movie-regex]
//   seatwatch check <showtimeId...> [--want <seat-regex>]
//   seatwatch alamo-discover [market=nyc] [movie-regex] [date]
//   seatwatch alamo-check <cinemaId/sessionId...> [--want <seat-regex>]
//   seatwatch install-skill [--dev]

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CDP_HTTP = process.env.SEATWATCH_CDP || "http://127.0.0.1:9222";
const STATE_DIR = join(homedir(), ".seatwatch");
const STATE_FILE = join(STATE_DIR, "state.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HTML_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

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

// Score 0..1: prefer rows ~60% back from the screen, seats centered in the row.
function rankSeats(seats /* [{id, row, col, ...}] */) {
  const rows = [...new Set(seats.map((s) => s.row))].sort((a, b) => (a < b ? -1 : 1));
  const byRow = {};
  for (const s of seats) (byRow[s.row] ||= []).push(s.col);
  return seats
    .map((s) => {
      const rowPos = rows.length > 1 ? rows.indexOf(s.row) / (rows.length - 1) : 0.6;
      const cols = byRow[s.row].sort((a, b) => a - b);
      const colPos = cols.length > 1 ? (s.col - cols[0]) / (cols[cols.length - 1] - cols[0]) : 0.5;
      const score = 1 - (Math.abs(rowPos - 0.6) * 0.9 + Math.abs(colPos - 0.5) * 1.1);
      return { ...s, score: Math.round(score * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score);
}

function diffAndReport({ state, key, allSeats, want }) {
  // allSeats: [{id, row, col, open}]
  const open = allSeats.filter((s) => s.open).map((s) => s.id);
  const prev = new Set(state[key]?.open || []);
  const newlyOpen = open.filter((s) => !prev.has(s) && (!want || want.test(s)));
  const bestOpen = rankSeats(allSeats)
    .filter((s) => s.open)
    .slice(0, 10)
    .map(({ id, score }) => ({ id, score }));
  const initialized = state[key + ":initialized"];
  state[key] = { open, total: allSeats.length, checkedAt: new Date().toISOString() };
  state[key + ":initialized"] = true;
  return { open, newlyOpen, bestOpen, total: allSeats.length, shouldNotify: newlyOpen.length > 0 && initialized };
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
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
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
  const res = await fetch(`https://www.amctheatres.com/showtimes/${showtimeId}/seats`, { headers: HTML_HEADERS });
  if (res.status === 429 || res.status === 403) return { blocked: res.status };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const layout = extractSeatingLayout(await res.text());
  if (!layout?.seats?.length) return { error: "no seatingLayout in page (expired showtime or page change)" };
  const seats = layout.seats
    .filter((s) => s.type !== "NotASeat")
    .map((s) => ({ id: s.name || `r${s.row}c${s.column}`, row: s.row, col: s.column, open: !!s.available, tier: s.seatTier }));
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
  const res = await fetch(`https://drafthouse.com/s/mother/v1/app/seats/${cinemaId}/${sessionId}`);
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
  return { seats };
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
  if (!seen.size) process.stderr.write("No showtimes matched.\n");
}

async function cmdCheck(ids, wantRe) {
  const state = loadState();
  const want = wantRe ? new RegExp(wantRe, "i") : null;
  const report = [];
  for (const id of ids) {
    let r = await amcFetchSeatsHttp(id);
    if (r.blocked) {
      process.stderr.write(`HTTP blocked (${r.blocked}) for ${id}; trying Chrome CDP fallback...\n`);
      r = await amcFetchSeatsCdp(id).catch((e) => ({ error: e.message }));
    }
    if (r.blocked) { report.push({ id, error: `rate limited (${r.blocked}) on both paths — back off 30+ minutes` }); continue; }
    if (r.error) { report.push({ id, error: r.error }); continue; }
    const d = diffAndReport({ state, key: id, allSeats: r.seats, want });
    report.push({ id, total: d.total, openCount: d.open.length, open: d.open, bestOpen: d.bestOpen, newlyOpen: d.newlyOpen });
    if (d.shouldNotify) notify(`Seats opened: showtime ${id}`, `${d.newlyOpen.join(", ")} now available (${d.open.length} open total)`);
  }
  saveState(state);
  console.log(JSON.stringify(report, null, 2));
}

async function cmdAlamoCheck(pairs, wantRe) {
  const state = loadState();
  const want = wantRe ? new RegExp(wantRe, "i") : null;
  const report = [];
  for (const pair of pairs) {
    const r = await alamoFetchSeats(pair);
    if (r.error) { report.push({ id: pair, error: r.error }); continue; }
    const d = diffAndReport({ state, key: `alamo:${pair}`, allSeats: r.seats, want });
    report.push({ id: pair, total: d.total, openCount: d.open.length, open: d.open, bestOpen: d.bestOpen, newlyOpen: d.newlyOpen });
    if (d.shouldNotify) notify(`Alamo seats opened: ${pair}`, `${d.newlyOpen.join(", ")} now available (${d.open.length} open total)`);
  }
  saveState(state);
  console.log(JSON.stringify(report, null, 2));
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
const [cmd, ...rest] = process.argv.slice(2);
const wantIdx = rest.indexOf("--want");
const wantRe = wantIdx >= 0 ? rest[wantIdx + 1] : null;
const args = rest.filter((a, i) => a !== "--want" && (wantIdx < 0 || i !== wantIdx + 1) && !a.startsWith("--"));

try {
  if (cmd === "discover") await cmdDiscover(args[0], args[1], args[2]);
  else if (cmd === "check") {
    if (!args.length) throw new Error("no showtime ids given");
    await cmdCheck(args, wantRe);
  } else if (cmd === "alamo-discover") {
    const rows = await alamoDiscover(args[0] || "nyc", args[1], args[2]);
    for (const r of rows) console.log(`${r.id}\t${r.movie}\t${r.time}\t${r.cinema}\t${r.status}`);
    if (!rows.length) process.stderr.write("No sessions matched.\n");
  } else if (cmd === "alamo-check") {
    if (!args.length) throw new Error("no cinemaId/sessionId pairs given");
    await cmdAlamoCheck(args, wantRe);
  } else if (cmd === "install-skill") {
    cmdInstallSkill({ dev: rest.includes("--dev") });
  } else {
    console.error(`usage:
  seatwatch discover <theatre-slug> [date] [movie-regex]      # AMC showtimes
  seatwatch check <showtimeId...> [--want <seat-regex>]       # AMC per-seat check
  seatwatch alamo-discover [market=nyc] [movie-regex] [date]  # Alamo sessions
  seatwatch alamo-check <cinemaId/sessionId...> [--want <re>] # Alamo per-seat check
  seatwatch install-skill [--dev]                             # install the Claude skill`);
    process.exit(2);
  }
  process.exit(0);
} catch (e) {
  console.error("seatwatch error:", e.message);
  process.exit(1);
}
