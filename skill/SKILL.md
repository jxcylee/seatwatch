---
name: seatwatch
description: Check movie seat availability and watch for cancellation openings at AMC and Alamo Drafthouse — per-seat open/taken status, best-available-seat ranking, and diff-based alerts when seats newly open on sold-out or almost-full showtimes. Use whenever the user asks about movie tickets or seats — "are there seats for X", "is the 7pm Odyssey sold out", "watch this showtime for cancellations", "best seats left", "seat alert", or anything SeatDrop-like. Also use for setting up recurring seat checks on a cron/automation.
---

# seatwatch — movie seat availability checker

The `seatwatch` CLI does all the real work. Never scrape ticketing sites by hand — run it and interpret its JSON. All checks are plain HTTP (AMC falls back to a local Chrome on `--remote-debugging-port=9222` if HTTP is blocked or rate-limited), so no browser setup is normally needed.

## Commands

```bash
# Resolve theatre names/cities to an AMC URL slug or Alamo market.
npx -y seatwatch theatres brooklyn
# → tab-separated: chain  slug-or-market  display name  location

# AMC: list showtimes for a theatre/date, optional movie regex.
# Theatre slug is the amctheatres.com URL path segment.
npx -y seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
# → tab-separated: showtimeId  movie  time  status (AlmostFull, Sellable, ...)

# AMC: per-seat availability; optionally rank adjacent groups.
npx -y seatwatch check 134717192 145066519 --want '^(F|G|H)' --together 2

# Alamo: list sessions for a market (nyc, austin, ...), optional movie regex and YYYY-MM-DD.
npx -y seatwatch alamo-discover nyc odyssey 2026-07-17
# → cinemaId/sessionId  movie-slug  showtime  cinema  status

# Alamo: per-seat availability for cinemaId/sessionId pairs from discover.
npx -y seatwatch alamo-check 2103/93423 --want '^7' --together 2

# Register a recurring watch in SQLite with one command.
npx -y seatwatch monitor add alamo 2103/93423 --want '^7' \
  --label 'Odyssey 7pm' --notify 'https://ntfy.sh/my-seat-alerts' \
  --until 2026-07-17T19:00:00-04:00 --interval 10

# Cron/automation calls this every 1–2 minutes; it only checks watches that are due.
npx -y seatwatch monitor tick

# Cached answer with last results and recent openings; never makes a network request.
npx -y seatwatch monitor status

# Install this agent skill; --dev rewrites commands to use the current checkout.
npx -y seatwatch install-skill [--dev]
```

## Output format (both `check` commands)

JSON array, one object per showtime:

```json
{
  "id": "134717192",
  "total": 480,          // seats in the auditorium
  "openCount": 0,        // currently available
  "open": ["A4", "..."], // all open seat ids
  "bestOpen": [{"id": "D6", "score": 0.59}, ...],  // top 10 open seats, best first
  "bestTogether": [{"seats": ["C5", "C6"], "score": 0.81}, ...],
  "newlyOpen": ["D6"]    // opened since the last check (respects --want filter)
}
```

- `bestOpen` scores 0–1: seats ~60% back from the screen and centered in their row score highest. Recommend seats in this order unless the user states a preference.
- `--together N` adds `bestTogether`, the top five open runs of N physically adjacent seats, scored at each run's centroid with the same geometry. Adjacent seats have consecutive column values in one row; column gaps are aisles and break a run.
- `newlyOpen` is the alert signal. State persists in `~/.seatwatch/state.json`; the **first check of a showtime seeds state** (no notification fires). Real alerts start from the second check.
- On macOS a notification (with sound) fires automatically when seats newly open.
- With `--together`, an alert fires only if an open run of N includes at least one `newlyOpen` seat, and the notification names the run.
- `--want <regex>` limits `newlyOpen` and alerts to matching seat ids (e.g. `'^(C|D|E)'`). It does not filter `open`, `bestOpen`, or `bestTogether`.
- An `error` field usually means the showtime expired or rate limiting hit — the message says which.

## Typical workflows

**"Any seats for X?"** — if the AMC slug or Alamo market is unknown, run `theatres <name-or-city>` first. Then discover to find the showtime id, check it, and report `openCount` and the top few `bestOpen` seats in plain language.

**"Watch this showtime for cancellations"** — use `monitor add <amc|alamo> <id>` once, including `--until` whenever the showtime is known. Then arrange one shared cron/automation to run `monitor tick` every 1–2 minutes. Tick decides which watches are due: 10 minutes by default, automatically ramping to 2 minutes in the final 2 hours before `--until`, and expiring after it. Do not schedule a separate network check per watch.

Monitor commands:

```bash
npx -y seatwatch monitor add <amc|alamo> <id> [--want <re>] [--label <text>] [--notify <url>] [--until <ISO-datetime>] [--interval <minutes>]
npx -y seatwatch monitor list
npx -y seatwatch monitor remove <watchId>
npx -y seatwatch monitor clear
npx -y seatwatch monitor tick
npx -y seatwatch monitor status [watchId]
```

`monitor tick` prints JSON and exits 0 normally or 3 when alerts fire, which makes cron branching cheap. `monitor status` reads only `~/.seatwatch/seatwatch.db`—use it to answer “anything open yet?” without causing a network request. It includes the last result and recent newly-open events. Plain `check` commands continue using the legacy `~/.seatwatch/state.json` state.

For headless/VPS alerts, pass `--notify` a Discord, Slack, or generic webhook URL. A bare `https://ntfy.sh/<topic>` URL sends free phone push through ntfy.

Monitor `--want` has the same alert-filter semantics as plain checks. Monitors do not support `--together`; run `check` or `alamo-check` for adjacent-group ranking. The first successful tick seeds the monitor's SQLite seat state without alerting, independently of the plain-check history in `state.json`.

Install this skill with `npx -y seatwatch install-skill`. When developing from a checkout, `npx -y seatwatch install-skill --dev` rewrites installed commands to invoke that checkout's `cli.js` directly.

**Buying**: seatwatch never buys tickets. When seats open, tell the user immediately with the direct link — AMC: `https://www.amctheatres.com/showtimes/<id>/seats`, Alamo: the drafthouse.com session page — so they can grab it themselves.

## Rate limiting & staying unblocked

AMC rate-limits bursts: too many page loads in a short window earns a temporary ban (HTTP 429, or Cloudflare "error 1015" on the browser path). Throttling is per-IP and self-contained — it only affects the machine doing the polling. The CLI already softens this automatically: it jitters each request by 0–1.5s, honors the origin's `Retry-After` on a block (a monitor watch reports `cooling-down` and is skipped until the cooldown passes, then resumes), and revalidates with `ETag`/`Last-Modified` when offered. A `check` result with an `error` like `rate limited (429) … back off ~N min` means you should stop and wait — do not keep retrying.

Guidance: prefer one invocation with many ids over many separate runs; keep monitor intervals ≥ 5–10 min (the final-2-hour ramp already caps at 2 min); and note that AMC from a datacenter/VPS IP is often challenged, so AMC watches are most reliable from a residential connection. Alamo's API has no such limits and is safe to run anywhere.
