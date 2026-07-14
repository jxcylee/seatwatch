import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { effectiveIntervalMinutes, extractSeatingLayout, monitorStatusName } from "../cli.js";

test("extracts the AMC seat layout from the offline fixture", () => {
  const html = readFileSync(new URL("../fixtures/amc-seats-page.html", import.meta.url), "utf8");
  const layout = extractSeatingLayout(html);

  assert.equal(layout.columns, 13);
  assert.equal(layout.rows, 13);
  assert.equal(layout.seats.length, 169);
  assert.equal(layout.seats.filter((seat) => seat.available).length, 16);
});

test("monitor interval ramps during the final two hours", () => {
  const now = Date.parse("2026-07-17T20:00:00Z");
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 10, until: "2026-07-17T23:00:01Z" }, now), 10);
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 10, until: "2026-07-17T22:00:00Z" }, now), 2);
  assert.equal(effectiveIntervalMinutes({ intervalMinutes: 1, until: "2026-07-17T22:00:00Z" }, now), 1);
});

test("monitor status derives active and expired state", () => {
  const now = Date.parse("2026-07-17T20:00:00Z");
  assert.equal(monitorStatusName({ active: 1, until: "2026-07-17T20:00:01Z" }, now), "active");
  assert.equal(monitorStatusName({ active: 1, until: "2026-07-17T20:00:00Z" }, now), "expired");
  assert.equal(monitorStatusName({ active: 0, until: null }, now), "expired");
});
