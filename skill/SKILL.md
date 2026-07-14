---
name: seatwatch
description: Check movie seat availability and watch for cancellation openings at AMC and Alamo Drafthouse — per-seat open/taken status, best-available-seat ranking, and diff-based alerts when seats newly open on sold-out or almost-full showtimes. Use whenever the user asks about movie tickets or seats — "are there seats for X", "is the 7pm Odyssey sold out", "watch this showtime for cancellations", "best seats left", "seat alert", or anything SeatDrop-like. Also use for setting up recurring seat checks on a cron/automation.
---

# seatwatch — movie seat availability checker

The `seatwatch` CLI does all the real work. Never scrape ticketing sites by hand — run it and interpret its JSON. All checks are plain HTTP (AMC falls back to a local Chrome on `--remote-debugging-port=9222` only if HTTP gets rate-limited), so no browser setup is normally needed.

## Commands

```bash
# AMC: list showtimes for a theatre/date, optional movie regex.
# Theatre slug is the amctheatres.com URL path segment.
npx -y seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
# → tab-separated: showtimeId  movie  time  status (AlmostFull, Sellable, ...)

# AMC: per-seat availability for one or more showtime ids.
npx -y seatwatch check 134717192 145066519 --want '^(F|G|H)'

# Alamo: list sessions for a market (nyc, austin, ...), optional movie regex and YYYY-MM-DD.
npx -y seatwatch alamo-discover nyc odyssey 2026-07-17
# → cinemaId/sessionId  movie-slug  showtime  cinema  status

# Alamo: per-seat availability for cinemaId/sessionId pairs from discover.
npx -y seatwatch alamo-check 2103/93423 --want '^7'
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
  "newlyOpen": ["D6"]    // opened since the last check (respects --want filter)
}
```

- `bestOpen` scores 0–1: seats ~60% back from the screen and centered in their row score highest. Recommend seats in this order unless the user states a preference.
- `newlyOpen` is the alert signal. State persists in `~/.seatwatch/state.json`; the **first check of a showtime seeds state** (no notification fires). Real alerts start from the second check.
- On macOS a notification (with sound) fires automatically when seats newly open.
- `--want <regex>` limits alerts to matching seat ids (e.g. `'^(C|D|E)'`). It filters alerts only; `open`/`bestOpen` still show everything.
- An `error` field usually means the showtime expired or rate limiting hit — the message says which.

## Typical workflows

**"Any seats for X?"** — discover to find the showtime id, check it, report `openCount` and the top few `bestOpen` seats in plain language.

**"Watch this showtime for cancellations"** — run one check now to seed state, then set up a recurring run (cron or your agent platform's automation) of the same `check` command. Sensible cadence: every 10 minutes baseline, every 2 minutes in the final 2 hours before showtime — half of all cancellations land in the last 12 hours and ~1 in 9 in the final hour. Keep polling modest (never faster than once a minute): this reads a public seat map the same way a human would, and staying polite keeps it working.

**Buying**: seatwatch never buys tickets. When seats open, tell the user immediately with the direct link — AMC: `https://www.amctheatres.com/showtimes/<id>/seats`, Alamo: the drafthouse.com session page — so they can grab it themselves.

## Rate limiting

AMC rate-limits bursts: too many page loads in a short window earns a temporary ban (HTTP 429, or Cloudflare "error 1015" on the browser path). The CLI reports this distinctly and falls back to a local Chrome if one is running with the debug port. If both paths are blocked, stop checking AMC for at least 30 minutes and slow the cadence. One invocation checks all given ids over one connection — prefer one run with many ids over many runs.
