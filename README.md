# seatwatch

Watch movie seat availability and cancellation openings at **AMC** and **Alamo Drafthouse**. Per-seat open/taken status, center-weighted best-seat ranking, and diff-based alerts when seats newly open on sold-out showtimes.

JSON-out and exit-coded — built to be driven by agents and cron, without a daemon.

## Command reference

```text
seatwatch theatres <query>
seatwatch discover <theatre-slug> [date] [movie-regex]
seatwatch check <showtimeId...> [--want <seat-regex>] [--together N]
seatwatch alamo-discover [market=nyc] [movie-regex] [date]
seatwatch alamo-check <cinemaId/sessionId...> [--want <seat-regex>] [--together N]
seatwatch monitor add <amc|alamo> <id> [--want <seat-regex>] [--label <text>] [--notify <url>] [--until <ISO-datetime>] [--interval <minutes>]
seatwatch monitor list
seatwatch monitor remove <watchId>
seatwatch monitor clear
seatwatch monitor tick
seatwatch monitor status [watchId]
seatwatch install-skill [--dev]
```

## Quick start

```bash
# Find the AMC slug or Alamo market first
npx -y seatwatch theatres lincoln square
npx -y seatwatch theatres brooklyn

# any open seats for the 70mm Odyssey at Lincoln Square on opening day?
npx -y seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
npx -y seatwatch check 134717192 --together 2

# Alamo (open JSON API)
npx -y seatwatch alamo-discover nyc odyssey 2026-07-17
npx -y seatwatch alamo-check 2103/93423 --together 2

# Watch a showtime with one command. Run `monitor tick` from cron every 1–2 min;
# it only makes network requests for watches that are due.
npx -y seatwatch monitor add alamo 2103/93423 --label 'Odyssey 7pm' \
  --want '^(7|8)' --until 2026-07-17T19:00:00-04:00 --interval 10
npx -y seatwatch monitor tick
npx -y seatwatch monitor status
```

`theatres <query>` searches theatre names, cities, states, and Alamo market names case-insensitively. Output is tab-separated: `chain`, `slug-or-market`, `display name`, `location`. AMC data comes from its theatre sitemap (with a bundled snapshot as a rate-limit fallback); Alamo markets and cinemas come from its open `s/mother` API. Fetched indexes are cached at `~/.seatwatch/theatres-cache.json` for 30 days.

`check` output per showtime: `total`, `openCount`, `open` (all open seat ids), `bestOpen` (top 10 ranked by geometry — ~60% back, centered), and `newlyOpen` (diff vs the last run, persisted in `~/.seatwatch/state.json`). On macOS, newly opened seats fire a native notification.

Pass `--together N` to either `check` command to add `bestTogether`, the top five contiguous open runs of N seats ranked by the centroid of each run. Seats must have consecutive column values in the same row; a column gap is treated as an aisle. With this flag, notifications fire only when a qualifying run includes at least one newly opened seat, and the notification names that run.

`--want <seat-regex>` filters `newlyOpen` and alerts only; it does not filter `open`, `bestOpen`, or `bestTogether`.

```json
{"bestTogether": [{"seats": ["C5", "C6"], "score": 0.81}]}
```

## Recurring monitors

`monitor add` is the recommended way to watch for cancellations. Monitor state and check history live in `~/.seatwatch/seatwatch.db` using Node's built-in SQLite support; the legacy `state.json` behavior for plain `check` and `alamo-check` commands is unchanged.

```bash
seatwatch monitor add <amc|alamo> <id> \
  [--want <seat-regex>] [--label <text>] [--notify <url>] [--until <ISO-datetime>] [--interval <minutes>]
seatwatch monitor list
seatwatch monitor remove <watchId>
seatwatch monitor clear
seatwatch monitor tick
seatwatch monitor status [watchId]
```

AMC targets are showtime IDs; Alamo targets are `cinemaId/sessionId`. The default interval is 10 minutes. During the final two hours before `--until`, the effective interval automatically becomes the smaller of the configured interval and 2 minutes. A tick marks watches expired after `--until`, skips them, and cheaply skips every active watch that is not due.

Monitors support `--want` with the same alert-filter semantics as the two plain check commands. They do not support `--together`; use `check` or `alamo-check` when adjacent-group ranking is needed. The first successful monitor tick seeds its independent SQLite seat state and does not alert. Plain checks keep their independent history in `~/.seatwatch/state.json`, so the two subsystems never overwrite each other's state.

Run `monitor tick` every 1–2 minutes from a single cron entry or agent automation. It prints one JSON summary and exits 0 normally or 3 when one or more newly opened seat matches trigger alerts. `monitor status` never accesses the network: it returns each watch's last result and recent newly-open events directly from SQLite, making it the right command for answering “anything open yet?”

Use `--notify <url>` to POST alerts from headless/VPS monitors. Discord webhook URLs receive `{"content": text}`, Slack webhook URLs receive `{"text": text}`, and other URLs receive a plain-text body with an ntfy-compatible `Title` header. A bare `https://ntfy.sh/<topic>` URL provides free phone push through ntfy.

Example cron entry:

```cron
*/2 * * * * /usr/local/bin/seatwatch monitor tick
```

## Claude skill

```bash
npx -y seatwatch install-skill
# For a checkout, rewrite the installed skill to invoke this checkout's cli.js:
npx -y seatwatch install-skill --dev
```

Installs a skill into `~/.claude/skills/seatwatch` (and `~/.bb/skills/seatwatch`) that teaches Claude Code / compatible agents to answer "are there seats for X?", "watch this showtime for cancellations", and "best seats left" by driving this CLI. New agent sessions pick it up automatically.

## How it works

- **AMC**: the seat map ships as JSON inside the server-rendered seats page; seatwatch fetches it over plain HTTP. If AMC blocks or rate-limits that request (HTTP 403/429), it falls back to a local Chrome running with `--remote-debugging-port=9222`, reading the same map from the live DOM.
- **Alamo**: their open `s/mother` JSON API (`schedule/market/<market>`, `app/seats/<cinemaId>/<sessionId>`).

## Be polite (and avoid getting yourself blocked)

Every user runs seatwatch from their own machine, so throttling is self-inflicted and self-contained — one aggressive poller only gets its *own* IP cooled off, never anyone else's. The tool leans into that with three built-in courtesies so a normal cadence stays under the radar:

- **Request jitter** — each seat fetch waits a random 0–1.5s so cron-driven polls don't hammer the origin on exact clock boundaries. Tune with `SEATWATCH_JITTER_MS` (`0` disables).
- **Honored backoff** — on an HTTP 429/403 the tool reads the origin's `Retry-After` header and, for monitors, actually sits out that long (a `cooling-down` watch is skipped until the cooldown passes, then auto-clears on the next success). No header → a 30-minute default.
- **Conditional requests** — if the origin sends an `ETag`/`Last-Modified`, seatwatch revalidates with it so an unchanged seat map returns a cheap `304` instead of a full re-download. Purely a no-op if the origin ignores it.

Beyond that: keep cadences modest (≥ 5–10 min baseline; the final-2-hour ramp already caps at 2 min), check many showtimes in one invocation rather than spawning many, and prefer Alamo when running headless. seatwatch never reserves or buys seats.

### Where to run it

- **Alamo** uses an open JSON API with no bot fingerprinting — it runs fine from anywhere, including a VPS or cloud function.
- **AMC** sits behind Cloudflare, which treats datacenter IPs far more harshly than residential ones. The plain-HTTP path is validated from residential IPs; from a VPS it may be challenged, and the Chrome-CDP fallback needs a local Chrome that a headless box won't have. **Run AMC watches from a residential connection** (a home machine, Mac mini, or Raspberry Pi), or treat AMC as best-effort and test from your target IP before relying on it.

Requires Node ≥ 22 (built-in `fetch`, `WebSocket`, and `node:sqlite`). macOS notifications use `osascript`; other platforms just get JSON.

## License

MIT
