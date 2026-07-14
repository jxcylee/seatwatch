# seatwatch

Watch movie seat availability and cancellation openings at **AMC** and **Alamo Drafthouse**. Per-seat open/taken status, center-weighted best-seat ranking, and diff-based alerts when seats newly open on sold-out showtimes.

JSON-out and exit-coded — built to be driven by agents and cron, without a daemon.

## Quick start

```bash
# any open seats for the 70mm Odyssey at Lincoln Square on opening day?
npx -y seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
npx -y seatwatch check 134717192

# Alamo (open JSON API)
npx -y seatwatch alamo-discover nyc odyssey 2026-07-17
npx -y seatwatch alamo-check 2103/93423

# Watch a showtime with one command. Run `monitor tick` from cron every 1–2 min;
# it only makes network requests for watches that are due.
npx -y seatwatch monitor add alamo 2103/93423 --label 'Odyssey 7pm' \
  --want '^(7|8)' --until 2026-07-17T19:00:00-04:00 --interval 10
npx -y seatwatch monitor tick
npx -y seatwatch monitor status
```

`check` output per showtime: `total`, `openCount`, `open` (all open seat ids), `bestOpen` (top 10 ranked by geometry — ~60% back, centered), and `newlyOpen` (diff vs the last run, persisted in `~/.seatwatch/state.json`). On macOS, newly opened seats fire a native notification.

## Recurring monitors

`monitor add` is the recommended way to watch for cancellations. Monitor state and check history live in `~/.seatwatch/seatwatch.db` using Node's built-in SQLite support; the legacy `state.json` behavior for plain `check` and `alamo-check` commands is unchanged.

```bash
seatwatch monitor add <amc|alamo> <id> \
  [--want <seat-regex>] [--label <text>] [--until <ISO-datetime>] [--interval <minutes>]
seatwatch monitor list
seatwatch monitor remove <watchId>
seatwatch monitor clear
seatwatch monitor tick
seatwatch monitor status [watchId]
```

AMC targets are showtime IDs; Alamo targets are `cinemaId/sessionId`. The default interval is 10 minutes. During the final two hours before `--until`, the effective interval automatically becomes the smaller of the configured interval and 2 minutes. A tick marks watches expired after `--until`, skips them, and cheaply skips every active watch that is not due.

Run `monitor tick` every 1–2 minutes from a single cron entry or agent automation. It prints one JSON summary and exits 0 normally or 3 when one or more newly opened seat matches trigger alerts. `monitor status` never accesses the network: it returns each watch's last result and recent newly-open events directly from SQLite, making it the right command for answering “anything open yet?”

Example cron entry:

```cron
*/2 * * * * /usr/local/bin/seatwatch monitor tick
```

## Claude skill

```bash
npx -y seatwatch install-skill
```

Installs a skill into `~/.claude/skills/seatwatch` (and `~/.bb/skills/seatwatch`) that teaches Claude Code / compatible agents to answer "are there seats for X?", "watch this showtime for cancellations", and "best seats left" by driving this CLI. New agent sessions pick it up automatically.

## How it works

- **AMC**: the seat map ships as JSON inside the server-rendered seats page; seatwatch fetches it over plain HTTP. If AMC rate-limits (HTTP 429), it falls back to a local Chrome running with `--remote-debugging-port=9222`, reading the same map from the live DOM.
- **Alamo**: their open `s/mother` JSON API (`schedule/market/<market>`, `app/seats/<cinemaId>/<sessionId>`).

## Be polite

This reads public seat maps at human-like rates. Keep cadences modest (≥ 5–10 min baseline; never faster than once a minute), check many showtimes in one invocation rather than many invocations, and back off 30+ minutes on 429/1015. seatwatch never reserves or buys seats.

Requires Node ≥ 22 (built-in `fetch`, `WebSocket`, and `node:sqlite`). macOS notifications use `osascript`; other platforms just get JSON.

## License

MIT
