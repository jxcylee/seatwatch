# seatwatch

Watch movie seat availability and cancellation openings at **AMC** and **Alamo Drafthouse**. Per-seat open/taken status, center-weighted best-seat ranking, and diff-based alerts when seats newly open on sold-out showtimes.

Single-shot, JSON-out, exit-coded — built to be driven by agents and cron, not to daemonize.

## Quick start

```bash
# Find the AMC slug or Alamo market first
npx -y seatwatch theatres lincoln square
npx -y seatwatch theatres brooklyn

# any open seats for the 70mm Odyssey at Lincoln Square on opening day?
npx -y seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
npx -y seatwatch check 134717192

# Alamo (open JSON API)
npx -y seatwatch alamo-discover nyc odyssey 2026-07-17
npx -y seatwatch alamo-check 2103/93423
```

`theatres <query>` searches theatre names, cities, states, and Alamo market names case-insensitively. Output is tab-separated: `chain`, `slug-or-market`, `display name`, `location`. AMC data comes from its theatre sitemap (with a bundled snapshot as a rate-limit fallback); Alamo markets and cinemas come from its open `s/mother` API. Fetched indexes are cached at `~/.seatwatch/theatres-cache.json` for 30 days.

`check` output per showtime: `total`, `openCount`, `open` (all open seat ids), `bestOpen` (top 10 ranked by geometry — ~60% back, centered), and `newlyOpen` (diff vs the last run, persisted in `~/.seatwatch/state.json`). On macOS, newly opened seats fire a native notification.

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

Requires Node ≥ 22 (built-in `fetch` and `WebSocket`). macOS notifications use `osascript`; other platforms just get JSON.

## License

MIT
