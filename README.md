# 🎬 seatwatch

[![npm](https://img.shields.io/npm/v/seatwatch)](https://www.npmjs.com/package/seatwatch)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

**Sold-out movie? Someone's going to cancel. Be there when they do.**

## The story

The movie you actually want to see — the 70mm IMAX event, opening night, the good screen — sold out eleven minutes after tickets dropped. Everyone tells you to "just keep checking." Nobody does that. It's miserable.

Here's the thing the box office doesn't advertise: **sold out is rarely final**. Plans change, and refunds flow right up until showtime. Community tracking data says about *half* of all seat openings land in the final 12 hours, and roughly *1 in 9* happen in the last hour before the lights go down. Those seats reappear on the public seat map for a few minutes and then they're gone again — snapped up by whoever happened to be looking.

`seatwatch` is the thing that happens to be looking. It reads the same seat map you'd see in your browser, remembers who was sitting where, and the moment a seat frees up it buzzes your phone (or your desktop, or your Discord) with the seat number and the booking link. You tap, you buy, you're in row F center on opening night.

```bash
npm i -g seatwatch

# which theatre? (never guess — look it up)
seatwatch theatres 'lincoln square'

# what showtimes? (movie regex + date)
seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey

# watch the sold-out 7pm, ping my phone when anything opens
seatwatch monitor add amc 134717192 \
  --label 'Odyssey 70mm — Fri 7pm' \
  --notify 'https://ntfy.sh/my-secret-topic' \
  --until 2026-07-17T19:00:00-04:00

# install the (one) cron entry that does the checking. that's it.
seatwatch monitor install-cron
```

From then on it checks politely in the background — every 10 minutes normally, tightening to every 2 minutes in the final two hours (where the cancellations actually live) — and stops by itself after showtime. It **never buys tickets for you**; it just makes sure you're the first to know.

Works with **AMC** and **Alamo Drafthouse**. Knows which seats are good (center, ~60% back), can hunt for *N seats together* for group outings, and runs on a Mac, a Raspberry Pi, or a server.

## 🤖 Built for agents

seatwatch is designed to be *driven by an AI agent*, not just a human. Every command is single-shot, prints JSON (or clean TSV), and uses meaningful exit codes — no daemon, no interactive prompts, nothing to babysit. If you use Claude Code or a compatible agent harness:

```bash
npx -y seatwatch install-skill
```

That installs a **skill** (`~/.claude/skills/seatwatch`) containing a six-play playbook mapped to the questions people actually ask — *"are there seats for X Friday?"*, *"can I get 3 together?"*, *"it's sold out, watch it"*, *"best seat left?"*, *"where's it playing near me?"*, *"which showtime has the best availability?"* — each with the exact command sequence and how to interpret the output. Your agent picks it up in its next session and can answer all of the above, set up monitors, and read cached results (`monitor status`) without burning a network request.

The contract an agent can rely on:

- `check` / `alamo-check` → JSON array: `total`, `openCount`, `open`, `bestOpen` (ranked), `bestTogether` (with `--together N`), `newlyOpen` (the alert diff)
- `monitor tick` → exit `0` quiet, exit `3` when seats opened (cheap cron/wrapper branching)
- `monitor status` → answers "anything open yet?" from SQLite, zero network
- errors are structured (`error` field with a plain-language reason, including rate-limit backoff timing)

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
seatwatch monitor install-cron [--every <minutes>]
seatwatch monitor uninstall-cron
seatwatch install-skill [--dev]
```

Requires Node 22 or newer for built-in `fetch`, `WebSocket`, and `node:sqlite`.

## Quick start

Always resolve a theatre name or location before discovery. Do not guess AMC slugs or Alamo markets.

```bash
# Resolve a name, neighborhood, or city.
npx -y seatwatch theatres 'lincoln square'
npx -y seatwatch theatres brooklyn

# AMC: discover, then check all relevant showtimes together.
npx -y seatwatch discover new-york-city/amc-lincoln-square-13 2026-07-17 odyssey
npx -y seatwatch check 134717192 145066519

# Ask for the best contiguous pair.
npx -y seatwatch check 134717192 145066519 --together 2

# Alamo: discover, then check all relevant sessions together.
npx -y seatwatch alamo-discover nyc odyssey 2026-07-17
npx -y seatwatch alamo-check 2103/93423 2103/93424 --together 2
```

`theatres <query>` searches theatre names, cities, states, and Alamo market names case-insensitively. Its tab-separated output is `chain`, `slug-or-market`, `display name`, `location`. AMC data comes from its theatre sitemap, with a bundled snapshot as a rate-limit fallback; Alamo markets and cinemas come from its open `s/mother` API. Fetched indexes are cached at `~/.seatwatch/theatres-cache.json` for 30 days.

AMC `discover` output is `showtimeId`, `movie`, `time`, optional `status`. Alamo discovery output is `cinemaId/sessionId`, `movie-slug`, `showtime`, `cinema`, `status`. Discovery status is not a substitute for checking the seat map.

## Availability output

`check` and `alamo-check` print a JSON array with one object per showtime:

```json
{
  "id": "134717192",
  "total": 480,
  "openCount": 2,
  "open": ["D6", "D7"],
  "bestOpen": [{"id": "D6", "score": 0.59}],
  "bestTogether": [{"seats": ["D6", "D7"], "score": 0.59}],
  "newlyOpen": ["D6"]
}
```

`bestOpen` contains the top 10 currently open seats, ranked by geometry: about 60% back and centered. Pass `--together N` to add `bestTogether`, the top five contiguous open runs of N ranked by their centroid. Consecutive column values in the same row are adjacent; a gap is treated as an aisle. An empty `bestTogether` means no qualifying group is open, even if `openCount` is nonzero.

`newlyOpen` is the diff from the previous plain check, persisted in `~/.seatwatch/state.json`. The first check seeds state and does not notify. On macOS, later openings fire a native notification with sound. With `--together`, notification fires only if a qualifying run includes at least one newly-open seat and names that run.

`--want <seat-regex>` filters only `newlyOpen` and alerts; it does not filter `open`, `bestOpen`, or `bestTogether`. An `error` field usually identifies an expired showtime, page change, or rate limit.

To compare a weekend or several showtimes, put all same-chain IDs in one check and compare `openCount` plus the first `bestOpen` score. For a group, add `--together N` and compare the first `bestTogether` score.

## Recurring monitors

Use monitors for cancellation alerts. Their independent state and history live in `~/.seatwatch/seatwatch.db`.

```bash
seatwatch monitor add <amc|alamo> <id> \
  [--want <seat-regex>] [--label <text>] [--notify <url>] \
  [--until <ISO-datetime>] [--interval <minutes>]
seatwatch monitor list
seatwatch monitor remove <watchId>
seatwatch monitor clear
seatwatch monitor tick
seatwatch monitor status [watchId]
seatwatch monitor install-cron [--every <minutes>]
seatwatch monitor uninstall-cron
```

AMC targets are showtime IDs; Alamo targets are `cinemaId/sessionId`. Include `--until` when the showtime is known so the watch expires after it. The default check interval is 10 minutes. During the final two hours before `--until`, the effective interval becomes the smaller of the configured interval and 2 minutes. Each cron tick skips expired, cooling-down, and not-yet-due watches cheaply.

The first successful tick seeds monitor state without alerting. Monitors support `--want` with the same alert-filter semantics as plain checks, but not `--together`; use `check` or `alamo-check` for current adjacent-group ranking.

Run `monitor install-cron` once per machine, not once per watch. It installs or replaces one seatwatch cron entry, every 2 minutes by default; `--every <minutes>` accepts 1–59. The entry records absolute Node and CLI paths, logs to `~/.seatwatch/tick.log`, and calls `monitor tick`, which decides which watches are due. `monitor uninstall-cron` removes the marked entry.

`monitor tick` prints one JSON summary and exits 0 normally or 3 when alerts fire. `monitor status [watchId]` never accesses the network: it returns cached watch metadata, `lastResult`, and recent newly-open events from SQLite. Use status—not another check—to answer later “anything open yet?” questions.

On macOS, alerts use `osascript`. `--notify <url>` additionally posts alerts: Discord webhooks receive `{"content": text}`, Slack webhooks receive `{"text": text}`, and other URLs receive plain text with an ntfy-compatible `Title` header. Booking links are included in webhook messages. seatwatch never reserves or buys seats.

## Deploying headless (VPS / server)

Use a global install for a stable cron path:

```bash
npm i -g seatwatch

seatwatch monitor add alamo 2103/93423 \
  --label 'Odyssey — Downtown Brooklyn — Jul 17 7pm' \
  --notify 'https://ntfy.sh/choose-a-private-topic' \
  --until 2026-07-17T19:00:00-04:00 --interval 10

# Install one shared cron entry after adding watches.
seatwatch monitor install-cron
seatwatch monitor status
```

`npx -y seatwatch` is fine for interactive checks, but its executable can live in an ephemeral npx cache. If `install-cron` detects that path, it warns you to install globally and reinstall cron. The installed cron captures the current absolute Node and `cli.js` paths, preserves unrelated crontab lines, and replaces any previous line ending in `# seatwatch-monitor`.

Headless machines do not have macOS `osascript` desktop notifications. Pass `--notify` for an external alert. For phone push, choose a hard-to-guess ntfy topic, subscribe to it in the ntfy app, and use its URL as shown above. Discord, Slack, and generic HTTP(S) webhooks are also supported.

Alamo’s open API works from residential and datacenter hosts. AMC sits behind Cloudflare and often challenges datacenter/VPS IPs; its plain-HTTP path is validated from residential connections, and its fallback requires a locally reachable Chrome on `--remote-debugging-port=9222`. Run important AMC watches from a residential connection, or test your target server IP and treat it as best-effort.

## Agent skill

```bash
npx -y seatwatch install-skill

# From a checkout, rewrite installed commands to invoke this cli.js directly.
npx -y seatwatch install-skill --dev
```

This installs `skill/SKILL.md` into `~/.claude/skills/seatwatch` and `~/.bb/skills/seatwatch`. New agent sessions pick it up automatically. The skill gives agents exact workflows for theatre resolution, discovery, checking, together-seat ranking, monitoring, and cached follow-up answers.

## How it works

- **AMC:** seat-map JSON ships inside the server-rendered seats page. seatwatch fetches it over plain HTTP, then falls back on HTTP 403/429 to a local Chrome with remote debugging enabled and reads the live DOM.
- **Alamo:** seatwatch calls the open `s/mother` JSON endpoints for market schedules and session seat maps.

## Be polite (and avoid getting blocked)

Throttling is per IP, so an aggressive poller blocks its own machine. seatwatch automatically adds a random 0–1.5-second pre-request delay, honors `Retry-After` on HTTP 429/403 (or defaults to 30 minutes), skips cooling-down monitors, and uses `ETag`/`Last-Modified` conditional requests when the origin offers them. `SEATWATCH_JITTER_MS=0` disables jitter, primarily for tests.

Keep baseline monitor intervals at least 5–10 minutes; the final-two-hour ramp already caps at 2 minutes. Batch many showtime IDs into one check instead of launching separate processes. If a plain check reports `rate limited (...) — back off ~N min`, stop and wait.

## Provenance

This tool was researched, built, reviewed, and documented almost entirely by AI agents orchestrating each other (Claude + Codex working in parallel git clones, with adversarial review passes) — which is also why it's so deliberately agent-friendly: it was its own first user.

## License

MIT
