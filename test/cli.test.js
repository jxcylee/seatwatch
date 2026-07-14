import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conditionalHeaders, effectiveIntervalMinutes, extractSeatingLayout, main, monitorStatusName, parseRetryAfter, rankTogether, transformCrontab } from "../cli.js";

const headersFrom = (obj) => ({ headers: { get: (name) => obj[name.toLowerCase()] ?? null } });

test("extracts the AMC seat layout from the offline fixture", () => {
  const html = readFileSync(new URL("../fixtures/amc-seats-page.html", import.meta.url), "utf8");
  const layout = extractSeatingLayout(html);

  assert.equal(layout.columns, 13);
  assert.equal(layout.rows, 13);
  assert.equal(layout.seats.length, 169);
  assert.equal(layout.seats.filter((seat) => seat.available).length, 16);
});

test("does not mistake the AMC showtimes fixture for a seat layout", () => {
  const html = readFileSync(new URL("../fixtures/amc-showtimes-page.html", import.meta.url), "utf8");
  assert.equal(extractSeatingLayout(html), null);
});

test("returns null for an incomplete AMC seat layout", () => {
  assert.equal(extractSeatingLayout('<script>\\"seatingLayout\\":{\\"columns\\":13'), null);
});

test("ignores braces inside strings while extracting an AMC seat layout", () => {
  const html = '<script>\\"seatingLayout\\":{\\"label\\":\\"Balcony } {\\",\\"seats\\":[]} trailing';
  assert.deepEqual(extractSeatingLayout(html), { label: "Balcony } {", seats: [] });
});

test("ranks adjacent groups without crossing aisle gaps", () => {
  const seats = [
    { id: "F1", row: "F", col: 1, open: true },
    { id: "F2", row: "F", col: 2, open: true },
    { id: "F4", row: "F", col: 4, open: true },
    { id: "F5", row: "F", col: 5, open: true },
  ];

  assert.deepEqual(rankTogether(seats, 2).map((run) => run.seats), [["F1", "F2"], ["F4", "F5"]]);
  assert.deepEqual(rankTogether(seats, 3), []);
});

test("rankTogether handles one seat and requests larger than a row", () => {
  const seats = [
    { id: "A1", row: "A", col: 1, open: false },
    { id: "A2", row: "A", col: 2, open: true },
  ];

  assert.deepEqual(rankTogether(seats, 1).map((run) => run.seats), [["A2"]]);
  assert.deepEqual(rankTogether(seats, 3), []);
});

test("monitor interval ramps during the final two hours", () => {
  const now = Date.parse("2026-07-17T20:00:00Z");
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 10, until: "2026-07-17T23:00:01Z" }, now), 10);
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 10, until: "2026-07-17T22:00:00Z" }, now), 2);
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 1, until: "2026-07-17T22:00:00Z" }, now), 1);
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 10, until: "2026-07-17T19:59:59Z" }, now), 10);
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 10, until: null }, now), 10);
});

test("monitor status derives active and expired state", () => {
  const now = Date.parse("2026-07-17T20:00:00Z");
  assert.equal(monitorStatusName({ active: 1, until: "2026-07-17T20:00:01Z" }, now), "active");
  assert.equal(monitorStatusName({ active: 1, until: "2026-07-17T20:00:00Z" }, now), "expired");
  assert.equal(monitorStatusName({ active: 0, until: null }, now), "expired");
});

test("parseRetryAfter reads delta-seconds, HTTP-dates, and falls back", () => {
  assert.equal(parseRetryAfter(headersFrom({ "retry-after": "120" })), 120000);
  const soon = new Date(Date.now() + 90000).toUTCString();
  const ms = parseRetryAfter(headersFrom({ "retry-after": soon }));
  assert.ok(ms > 80000 && ms <= 90000, `expected ~90s, got ${ms}`);
  assert.equal(parseRetryAfter(headersFrom({}), 5000), 5000);
  assert.equal(parseRetryAfter(headersFrom({ "retry-after": "garbage" }), 7000), 7000);
});

test("conditionalHeaders only sets validators it actually has", () => {
  assert.deepEqual(conditionalHeaders(null), {});
  assert.deepEqual(conditionalHeaders({ etag: '"abc"' }), { "If-None-Match": '"abc"' });
  assert.deepEqual(
    conditionalHeaders({ etag: '"abc"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT" }),
    { "If-None-Match": '"abc"', "If-Modified-Since": "Wed, 21 Oct 2026 07:28:00 GMT" },
  );
});

test("installs a cron entry into an empty crontab", () => {
  const entry = "*/2 * * * * /node /cli monitor tick # seatwatch-monitor";
  assert.equal(transformCrontab("", entry), `${entry}\n`);
});

test("installing cron preserves unrelated lines", () => {
  const entry = "*/2 * * * * /node /cli monitor tick # seatwatch-monitor";
  assert.equal(transformCrontab("MAILTO=user@example.com\n0 4 * * * backup\n", entry), `MAILTO=user@example.com\n0 4 * * * backup\n${entry}\n`);
});

test("installing cron replaces the tagged entry without duplicating it", () => {
  const oldEntry = "*/5 * * * * old monitor tick # seatwatch-monitor";
  const newEntry = "*/2 * * * * new monitor tick # seatwatch-monitor";
  const result = transformCrontab(`${oldEntry}\n15 3 * * * cleanup\n`, newEntry);
  assert.equal(result, `15 3 * * * cleanup\n${newEntry}\n`);
  assert.equal(result.match(/# seatwatch-monitor/g).length, 1);
});

test("uninstalling cron removes only the tagged line", () => {
  const existing = "# seatwatch-monitor is documentation\n*/2 * * * * tick # seatwatch-monitor\n0 0 * * * keep # another-marker\n";
  assert.equal(transformCrontab(existing), "# seatwatch-monitor is documentation\n0 0 * * * keep # another-marker\n");
});

test("rejects together ranking for monitors instead of silently ignoring it", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(["monitor", "add", "amc", "123", "--together", "2"]), 1);
  } finally {
    console.error = originalError;
  }
});
