#!/usr/bin/env bun
// seatwatch — AMC seat-opening watcher via Chrome DevTools Protocol.
//
// Requires a Chrome running with --remote-debugging-port=9222 (any profile;
// pages are opened in an isolated incognito-like context and closed after).
//
// Usage:
//   bun seatwatch.js discover <theatre-slug> [date YYYY-MM-DD] [movie-regex]
//       e.g. bun seatwatch.js discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
//   bun seatwatch.js check <showtimeId> [showtimeId...] [--want <seatRegex>]
//       e.g. bun seatwatch.js check 145066519 --want '^(C|D|E)\d+'
//
// `check` diffs against ~/.seatwatch/state.json and fires a macOS notification
// when seats matching --want (default: any) newly open up.

const CDP_HTTP = process.env.SEATWATCH_CDP || "http://127.0.0.1:9222";
const STATE_DIR = `${process.env.HOME}/.seatwatch`;
const STATE_FILE = `${STATE_DIR}/state.json`;

// ---------- CDP plumbing ----------
let ws, msgId = 0;
const pending = new Map();

async function connectBrowser() {
  const res = await fetch(`${CDP_HTTP}/json/version`);
  if (!res.ok) throw new Error(`Chrome CDP not reachable at ${CDP_HTTP} (${res.status})`);
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

// One browser context per process run (a fresh context per page mints a new
// Cloudflare cookie every time, which reads as bot traffic and earns a 1015 ban).
let sharedContextId = null;
async function withPage(url, fn, { timeoutMs = 25000 } = {}) {
  if (!sharedContextId) {
    ({ browserContextId: sharedContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true }));
  }
  const browserContextId = sharedContextId;
  const { targetId } = await send("Target.createTarget", { url, browserContextId, background: true });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await send("Runtime.enable", {}, sessionId);
    const evaluate = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
      return r.result.value;
    };
    // wait for a condition helper
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
    // Context is disposed automatically when the WS detaches (disposeOnDetach).
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---------- extraction ----------
const SEATS_EXPR = `(() => {
  const boxes = [...document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')];
  const seats = boxes.map(b => b.getAttribute('aria-label') || '').filter(Boolean);
  if (!seats.length) return null;
  const parse = (l) => {
    const occupied = /occupied/i.test(l);
    const id = (l.match(/([A-Z]{1,2}\\d{1,3})\\s*$/) || [])[1] || l;
    return { id, label: l, occupied };
  };
  return seats.map(parse);
})()`;

const SHOWTIMES_EXPR = `(() => {
  const out = [];
  for (const region of document.querySelectorAll('[aria-label^="Showtimes for"], section')) {
    const movie = (region.getAttribute('aria-label') || '').replace(/^Showtimes for /, '') ||
                  region.querySelector('a[href*="/movies/"]')?.textContent?.trim() || '';
    if (!movie) continue;
    for (const a of region.querySelectorAll('a[href*="/showtimes/"]')) {
      const id = (a.getAttribute('href').match(/showtimes\\/(\\d+)/) || [])[1];
      if (!id) continue;
      out.push({ movie, id, time: a.textContent.trim(), desc: a.getAttribute('aria-description') || a.getAttribute('description') || '' });
    }
  }
  return out;
})()`;

// ---------- seat ranking ----------
// Score 0..1: prefer rows ~60% back from the screen, seats centered in the row.
// Works from whatever geometry we have: AMC gives "F12"-style ids; Alamo gives indices.
function rankSeats(seats /* [{id, row, col}] with row/col as sortable values */) {
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

function parseAmcSeatId(id) {
  const m = id.match(/^([A-Z]{1,2})(\d{1,3})$/);
  return m ? { row: m[1], col: Number(m[2]) } : null;
}

// ---------- state & notify ----------
import { mkdirSync, readFileSync, writeFileSync } from "fs";
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function notify(title, body) {
  Bun.spawnSync(["osascript", "-e",
    `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`]);
}

// ---------- commands ----------
async function cmdDiscover(slug, date, movieRe) {
  const url = `https://www.amctheatres.com/movie-theatres/${slug}/showtimes${date ? `?date=${date}` : ""}`;
  await connectBrowser();
  const rows = await withPage(url, async ({ evaluate, waitFor }) => {
    await waitFor(`document.querySelector('a[href*="/showtimes/"]') !== null || /no showtimes/i.test(document.body.innerText)`);
    return (await evaluate(SHOWTIMES_EXPR)) || [];
  });
  const re = movieRe ? new RegExp(movieRe, "i") : null;
  const filtered = rows.filter((r) => !re || re.test(r.movie));
  const seen = new Set();
  for (const r of filtered) {
    const key = r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${r.id}\t${r.movie}\t${r.time}`);
  }
  if (!filtered.length) console.error("No showtimes matched.");
}

async function cmdCheck(ids, wantRe) {
  await connectBrowser();
  const state = loadState();
  const want = wantRe ? new RegExp(wantRe, "i") : null;
  const report = [];
  for (const id of ids) {
    const url = `https://www.amctheatres.com/showtimes/${id}/seats`;
    const seats = await withPage(url, async ({ evaluate, waitFor }) => {
      const ok = await waitFor(`document.querySelectorAll('[role="checkbox"], input[type="checkbox"]').length > 0`);
      if (ok) return await evaluate(SEATS_EXPR);
      const text = await evaluate(`document.body.innerText.slice(0, 200)`);
      if (/rate limited|error 1015|access denied/i.test(text || "")) return { rateLimited: true };
      return null;
    });
    if (seats?.rateLimited) { report.push({ id, error: "Cloudflare rate limit (error 1015) — temporarily banned; back off 30+ minutes and slow the polling cadence" }); continue; }
    if (!seats) { report.push({ id, error: "seat map did not load (sold-out page variant or expired showtime)" }); continue; }
    const open = seats.filter((s) => !s.occupied).map((s) => s.id);
    const prev = new Set(state[id]?.open || []);
    const newlyOpen = open.filter((s) => !prev.has(s) && (!want || want.test(s)));
    const geo = seats.map((s) => ({ ...parseAmcSeatId(s.id), id: s.id, occupied: s.occupied })).filter((s) => s.row);
    const bestOpen = rankSeats(geo).filter((s) => !s.occupied).slice(0, 10).map(({ id, score }) => ({ id, score }));
    state[id] = { open, total: seats.length, checkedAt: new Date().toISOString() };
    report.push({ id, total: seats.length, openCount: open.length, open, bestOpen, newlyOpen });
    if (newlyOpen.length && state[id + ":initialized"]) {
      notify(`Seats opened: showtime ${id}`, `${newlyOpen.join(", ")} now available (${open.length} open total)`);
    }
    state[id + ":initialized"] = true;
  }
  saveState(state);
  console.log(JSON.stringify(report, null, 2));
}

// ---------- Alamo Drafthouse (open JSON API, no browser needed) ----------
async function cmdAlamoDiscover(market, movieRe, date) {
  const res = await fetch(`https://drafthouse.com/s/mother/v2/schedule/market/${market}`);
  if (!res.ok) throw new Error(`alamo schedule fetch failed (${res.status})`);
  const { data } = await res.json();
  const cinemas = Object.fromEntries((data.market?.[0]?.cinemas || []).map((c) => [c.id, c.name]));
  const re = movieRe ? new RegExp(movieRe, "i") : null;
  for (const s of data.sessions || []) {
    if (re && !re.test(s.presentationSlug || "")) continue;
    if (date && !(s.showTimeClt || "").startsWith(date)) continue;
    console.log(`${s.cinemaId}/${s.sessionId}\t${s.presentationSlug}\t${s.showTimeClt}\t${cinemas[s.cinemaId] || s.cinemaId}\t${s.status}`);
  }
}

async function cmdAlamoCheck(pairs, wantRe) {
  const state = loadState();
  const want = wantRe ? new RegExp(wantRe, "i") : null;
  const report = [];
  for (const pair of pairs) {
    const [cinemaId, sessionId] = pair.split("/");
    const key = `alamo:${pair}`;
    const res = await fetch(`https://drafthouse.com/s/mother/v1/app/seats/${cinemaId}/${sessionId}`);
    if (!res.ok) { report.push({ id: pair, error: `seat fetch failed (${res.status})` }); continue; }
    const { data } = await res.json();
    const open = [], all = [];
    for (const area of data.seatingData?.areas || [])
      for (const row of area.rows || [])
        for (const seat of row.seats || []) {
          if (seat.seatStatus === "NONE") continue;
          const id = `${row.name || row.rowNumber || ""}${seat.seatNumber}`;
          all.push({ id, row: seat.rowIndex, col: seat.columnIndex, open: seat.seatStatus === "EMPTY" });
          if (seat.seatStatus === "EMPTY") open.push(id);
        }
    const prev = new Set(state[key]?.open || []);
    const newlyOpen = open.filter((s) => !prev.has(s) && (!want || want.test(s)));
    const bestOpen = rankSeats(all).filter((s) => s.open).slice(0, 10).map(({ id, score }) => ({ id, score }));
    state[key] = { open, total: all.length, checkedAt: new Date().toISOString() };
    report.push({ id: pair, total: all.length, openCount: open.length, open, bestOpen, newlyOpen });
    if (newlyOpen.length && state[key + ":initialized"]) {
      notify(`Alamo seats opened: ${pair}`, `${newlyOpen.join(", ")} now available (${open.length} open total)`);
    }
    state[key + ":initialized"] = true;
  }
  saveState(state);
  console.log(JSON.stringify(report, null, 2));
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "discover") {
    await cmdDiscover(rest[0], rest[1], rest[2]);
  } else if (cmd === "check") {
    const wantIdx = rest.indexOf("--want");
    const wantRe = wantIdx >= 0 ? rest[wantIdx + 1] : null;
    const ids = rest.filter((a, i) => a !== "--want" && (wantIdx < 0 || i !== wantIdx + 1));
    if (!ids.length) throw new Error("no showtime ids given");
    await cmdCheck(ids, wantRe);
  } else if (cmd === "alamo-discover") {
    await cmdAlamoDiscover(rest[0] || "nyc", rest[1], rest[2]);
  } else if (cmd === "alamo-check") {
    const wantIdx = rest.indexOf("--want");
    const wantRe = wantIdx >= 0 ? rest[wantIdx + 1] : null;
    const pairs = rest.filter((a, i) => a !== "--want" && (wantIdx < 0 || i !== wantIdx + 1));
    if (!pairs.length) throw new Error("no cinemaId/sessionId pairs given");
    await cmdAlamoCheck(pairs, wantRe);
  } else {
    console.error(`usage:
  seatwatch.js discover <theatre-slug> [date] [movie-regex]        # AMC (needs Chrome :9222)
  seatwatch.js check <showtimeId...> [--want <seat-regex>]         # AMC
  seatwatch.js alamo-discover [market=nyc] [movie-regex] [date]    # Alamo (pure HTTP)
  seatwatch.js alamo-check <cinemaId/sessionId...> [--want <re>]   # Alamo`);
    process.exit(2);
  }
  process.exit(0);
} catch (e) {
  console.error("seatwatch error:", e.message);
  process.exit(1);
}
