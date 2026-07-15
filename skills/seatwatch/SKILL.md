---
name: seatwatch
description: Check movie seat availability and watch for cancellation openings at AMC and Alamo Drafthouse — per-seat open/taken status, best-available-seat ranking, and diff-based alerts when seats newly open on sold-out or almost-full showtimes. Use whenever the user asks about movie tickets or seats — "are there seats for X", "is the 7pm Odyssey sold out", "watch this showtime for cancellations", "best seats left", "seat alert", or anything SeatDrop-like. Also use for setting up recurring seat checks on a cron/automation.
---

# seatwatch — movie seat availability checker

The `seatwatch` CLI does the real work. Never scrape ticketing sites by hand: run it and interpret its tab-separated showtime output or JSON check output. AMC uses plain HTTP and falls back to a local Chrome on `--remote-debugging-port=9222` if blocked; Alamo uses its open JSON API.

## Numbered playbook

Use the first matching workflow below. Replace example values with values returned by the preceding command; never invent a theatre slug, market, showtime ID, or session ID.

### 1. “Are there seats for this movie on this night?”

Resolve the theatre first unless the user supplied an exact AMC slug or exact Alamo market from seatwatch. A theatre name, neighborhood, city, or “near me” is **not** a slug/market. If location is missing, ask for it.

```bash
npx -y seatwatch theatres 'lincoln square'
```

The output is tab-separated: `chain`, `slug-or-market`, `display name`, `location`. Choose the intended result; if several are plausible, ask the user which theatre.

`showtimes` infers AMC when the theatre contains `/`; otherwise it treats the theatre as an Alamo market. `check` and `monitor add` infer all-digit IDs as AMC and `cinemaId/sessionId` pairs as Alamo. One `check` invocation may mix both ID shapes.

Shortcut: `showtimes` also accepts a plain theatre name (`showtimes 'lincoln square' --movie odyssey`). A name matching exactly one theatre resolves automatically (stderr notes what it resolved to); an ambiguous name errors with the candidate slugs/markets — pick the right one or ask the user. The explicit `theatres` lookup remains the deterministic path when you want the full candidate list up front.

For AMC, find showtimes and then check every relevant returned ID in one invocation:

```bash
npx -y seatwatch showtimes new-york-city/amc-lincoln-square-13 --movie 'odyssey' --date 2026-07-17
npx -y seatwatch check 134717192 145066519
```

For Alamo, find showtimes and then check every relevant returned `cinemaId/sessionId` in one invocation:

```bash
npx -y seatwatch showtimes nyc --movie 'odyssey' --date 2026-07-17
npx -y seatwatch check 2103/93423 2103/93424
```

Tell the user the movie, theatre, date/time, and `openCount` for each relevant showtime. If seats are open, name the first few `bestOpen` seat IDs, best first. If `openCount` is 0, say it is currently sold out and offer the watch workflow in play 3. Do not describe a showtime status such as `AlmostFull` as a seat count; the check result is authoritative.

### 2. “Can I get 2–3 seats together somewhere decent?”

Follow play 1 through showtime lookup, then add `--together N` to the single batched check:

```bash
# AMC
npx -y seatwatch check 134717192 145066519 --together 3

# Alamo
npx -y seatwatch check 2103/93423 2103/93424 --together 3
```

Read `bestTogether`, not merely `openCount`. Recommend the first run and give its seat IDs and showtime; mention up to a few alternatives. An empty `bestTogether` means no qualifying contiguous group is currently open, even if individual seats are available. Seats must have consecutive column values in the same row; a column gap is an aisle. Monitors do not support `--together`, so use a fresh `check` when the user later asks whether a group is available.

### 3. “It’s sold out — alert me the moment seats open”

First resolve and find showtimes as in play 1. Register each chosen showtime once, always including the known showtime datetime as `--until`. On a headless machine, also include `--notify`; a bare ntfy topic provides phone push after the user subscribes to that topic in the ntfy app.

```bash
# macOS: native notifications fire locally; --notify is optional
npx -y seatwatch monitor add 134717192 \
  --label 'Odyssey — Lincoln Square — Jul 17 7pm' \
  --until 2026-07-17T19:00:00-04:00 --interval 10

# VPS/server: --notify is required for an external alert
npx -y seatwatch monitor add 2103/93423 \
  --label 'Odyssey — Downtown Brooklyn — Jul 17 7pm' \
  --notify 'https://ntfy.sh/choose-a-private-topic' \
  --until 2026-07-17T19:00:00-04:00 --interval 10

# Run this ONCE per machine, after adding watches (not once per watch).
npx -y seatwatch monitor install-cron
```

`monitor install-cron` installs one shared 2-minute scheduler. `monitor tick` decides which watches are due: the configured interval defaults to 10 minutes and automatically becomes the smaller of that interval and 2 minutes during the final two hours. It expires a watch after `--until`. Do not create a separate cron entry or network check for each watch.

The first successful tick seeds independent SQLite state and never alerts. Later matching openings trigger macOS `osascript` notifications automatically; headless systems have no `osascript` notification, so use `--notify` for ntfy, Discord, Slack, or another webhook. `--want <seat-regex>` may be added to restrict openings and alerts to preferred seat IDs.

**Choosing the alert channel** — ask what the user already has rather than pushing ntfy:
- Discord or Slack webhook URL → `--notify <url>` directly.
- ntfy app (or willing to install it) → `--notify https://ntfy.sh/<hard-to-guess-topic>` for phone push.
- None of the above → use `--notify-exec '<command>'`, which runs on each alert with `$SEATWATCH_TITLE`, `$SEATWATCH_MESSAGE` (includes booking link), `$SEATWATCH_SEATS`, `$SEATWATCH_LINK` in the environment. Compose the command from whatever the machine has: on macOS, iMessage-to-self is excellent (`osascript -e "tell application \"Messages\" to send (system attribute \"SEATWATCH_MESSAGE\") to buddy \"+1XXXXXXXXXX\""` — ask the user for their number); a configured `mail`/`sendmail` gives email; `curl` reaches Telegram/Twilio/Home Assistant. Verify your command once by running it directly in the shell with the env vars set manually before registering it. A failing command is recorded as `notifyExecStatus: "failed"` in tick results — check there if alerts aren't arriving. There is no zero-credential email path (ntfy.sh blocks anonymous email), so email always requires an already-configured mailer or an API key.

For every later “anything open yet?” query, read cached monitor state—do **not** perform a new network check:

```bash
npx -y seatwatch monitor status
# or one watch:
npx -y seatwatch monitor status 1
```

Tell the user `status`, `lastChecked`, `lastOpenCount`, the best seats in `lastResult.bestOpen` when present, and any `recentNewlyOpen` events. If `lastResult` is null, say the watch is installed but has not completed its first check. If `cooldownUntil` is non-null, say polling is paused until then. When seats open, include the booking link: AMC `https://www.amctheatres.com/showtimes/<id>/seats`; for Alamo direct the user to drafthouse.com. seatwatch never buys or reserves tickets.

### 4. “What’s the best seat left?”

Resolve, find showtimes, and check as in play 1:

```bash
npx -y seatwatch check 134717192
# or
npx -y seatwatch check 2103/93423
```

Recommend `bestOpen[0]`, naming its seat ID and score. Offer the next few entries in order if useful. `bestOpen` scores 0–1 and favors seats about 60% back and centered in their row. If `bestOpen` is empty, say no seats are currently open.

### 5. “Where is this movie playing near me?”

If the user has not provided a city, neighborhood, or theatre, ask for one. Resolve theatres **before** showtime lookup:

```bash
npx -y seatwatch theatres 'brooklyn'
```

Run `showtimes` for each plausible returned AMC slug or Alamo market, using the requested movie/date:

```bash
npx -y seatwatch showtimes new-york-city/amc-empire-25 --movie 'odyssey' --date 2026-07-17
npx -y seatwatch showtimes nyc --movie 'odyssey' --date 2026-07-17
```

Tell the user which matching theatres have sessions and list their times. `theatres` matches theatre names, cities, states, and Alamo market names; it does not itself prove that a movie is playing. If the user also asks about seats, continue to play 1 and check the returned IDs.

### 6. “Which showtime this weekend has the most/best availability?”

Resolve theatres first, run `showtimes` for each requested date, collect the relevant IDs, then check them in one command:

```bash
npx -y seatwatch check 134717192 134717193 134717194 145066519
npx -y seatwatch check 2103/93423 2103/93424 2103/93425
```

Compare `openCount` across results. For quality, also compare the first `bestOpen` score; if the user needs a group, use `--together N` and compare the first `bestTogether` score instead. Tell the user the best showtime, its count and best seat/run, then summarize close alternatives. Keep IDs in one invocation rather than spawning one check per showtime.

## Command reference

```text
npx -y seatwatch theatres <query>
npx -y seatwatch showtimes <theatre> [--movie <regex>] [--date <YYYY-MM-DD>]
npx -y seatwatch check <id...> [--want <seat-regex>] [--together N]
npx -y seatwatch monitor add [chain] <id> [--want <seat-regex>] [--label <text>] [--notify <url>] [--notify-exec <command>] [--until <ISO-datetime>] [--interval <minutes>]
npx -y seatwatch monitor list
npx -y seatwatch monitor remove <watchId>
npx -y seatwatch monitor clear
npx -y seatwatch monitor tick
npx -y seatwatch monitor status [watchId]
npx -y seatwatch monitor install-cron [--every <minutes>]
npx -y seatwatch monitor uninstall-cron
npx -y seatwatch install-skill [--dev]
```

AMC `showtimes` output is tab-separated: `showtimeId`, `movie`, `time`, optional `status`. Alamo `showtimes` output is: `cinemaId/sessionId`, `movie-slug`, `showtime`, `cinema`, `status`.

## Check output and alert semantics

`check` prints a JSON array with one object per showtime:

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

- `total` is the number of seats in the auditorium; `openCount` and `open` describe current availability.
- `bestOpen` contains the top 10 currently open seats. `bestTogether` appears only with `--together N` and contains up to five groups.
- `newlyOpen` is the diff since the last plain check. Plain-check state persists in `~/.seatwatch/state.json`; the first check seeds state, so no notification fires.
- macOS automatically fires a native notification with sound for later newly-open seats. With `--together`, it fires only when a qualifying run includes at least one newly-open seat and names that run.
- `--want <seat-regex>` filters only `newlyOpen` and alerts. It never filters `open`, `bestOpen`, or `bestTogether`.
- An `error` field usually indicates an expired showtime, a page change, or rate limiting; follow its message.

Monitor state and check history live separately in `~/.seatwatch/seatwatch.db`. `monitor tick` prints one JSON summary and exits 0 normally or 3 when alerts fire. `monitor status` never accesses the network and includes `lastResult` plus up to 10 recent newly-open events. `monitor list`, `remove`, `clear`, and `uninstall-cron` manage watches and the shared cron entry.

Webhook alerts use `--notify <url>`. Discord webhook URLs receive `{"content": text}`, Slack webhook URLs receive `{"text": text}`, and other URLs receive plain text with an ntfy-compatible `Title` header.

Install this skill with `npx -y seatwatch install-skill`. During development, `npx -y seatwatch install-skill --dev` rewrites installed commands to invoke the checkout’s `cli.js` directly.

## Rate limiting and where to run

AMC rate-limits bursts per IP (HTTP 429/403 or Cloudflare error 1015). The CLI adds a random 0–1.5-second pre-request jitter, honors `Retry-After` (or uses a 30-minute default), places monitor watches in cooldown, and uses `ETag`/`Last-Modified` conditional requests when offered. If a plain check says to back off, stop and wait; do not retry repeatedly. Keep baseline monitor intervals at least 5–10 minutes—the final-two-hour ramp already caps at 2 minutes—and batch IDs in one invocation.

AMC often challenges datacenter/VPS IPs. Its plain-HTTP path is validated from residential connections, while the Chrome fallback requires a locally reachable Chrome. Prefer a home machine for AMC or treat a VPS check as best-effort. Alamo’s API works from residential and datacenter hosts. `SEATWATCH_JITTER_MS=0` disables jitter, mainly for tests. seatwatch never reserves or buys seats.
