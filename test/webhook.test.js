import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("monitor tick posts webhook alerts and records delivery failures", async () => {
  const home = mkdtempSync(join(tmpdir(), "seatwatch-webhook-"));
  const previousHome = process.env.HOME;
  const previousJitter = process.env.SEATWATCH_JITTER_MS;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = process.stderr.write;
  const requests = [];
  const logs = [];
  let stderr = "";
  let server;

  try {
    process.env.HOME = home;
    process.env.SEATWATCH_JITTER_MS = "0";
    const stateDir = join(home, ".seatwatch");
    const dbPath = join(stateDir, "seatwatch.db");
    mkdirSync(stateDir, { recursive: true });
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE watches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL CHECK (chain IN ('amc', 'alamo')),
        target TEXT NOT NULL,
        label TEXT,
        want TEXT,
        intervalMinutes INTEGER NOT NULL DEFAULT 10 CHECK (intervalMinutes >= 1),
        until TEXT,
        createdAt TEXT NOT NULL,
        lastChecked TEXT,
        lastOpenCount INTEGER,
        lastResult TEXT,
        seatState TEXT,
        initialized INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      )
    `);
    legacyDb.close();
    server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push({ url: req.url, method: req.method, headers: req.headers, body });
        res.writeHead(req.url === "/fail" ? 500 : 204).end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith("https://drafthouse.com/s/mother/v1/app/seats/")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            seatingData: {
              areas: [{ rows: [{
                name: "A",
                seats: [
                  { seatStatus: "EMPTY", seatNumber: "1", rowIndex: 0, columnIndex: 1 },
                  { seatStatus: "EMPTY", seatNumber: "2", rowIndex: 0, columnIndex: 2 },
                ],
              }] }],
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return originalFetch(input, init);
    };
    console.log = (value) => { logs.push(String(value)); };
    process.stderr.write = (value) => { stderr += String(value); return true; };

    const { main } = await import(`../cli.js?webhook-test=${Date.now()}`);
    assert.equal(await main([
      "monitor", "add", "alamo", "2103/93423", "--label", "Odyssey 7pm",
      "--notify", `http://127.0.0.1:${port}/hook`,
    ]), 0);
    const added = JSON.parse(logs.pop());
    assert.equal(added.notifyUrl, `http://127.0.0.1:${port}/hook`);

    assert.equal(await main(["monitor", "list"]), 0);
    assert.equal(JSON.parse(logs.pop())[0].notifyUrl, added.notifyUrl);
    assert.equal(await main(["monitor", "status", String(added.id)]), 0);
    assert.equal(JSON.parse(logs.pop()).notifyUrl, added.notifyUrl);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE watches SET seatState = ?, initialized = 1, lastChecked = NULL WHERE id = ?")
      .run(JSON.stringify(["A1"]), added.id);
    db.close();

    assert.equal(await main(["monitor", "tick"]), 3);
    const sent = JSON.parse(logs.pop());
    assert.equal(sent.results[0].notifyStatus, "sent");
    assert.deepEqual(requests[0], {
      url: "/hook",
      method: "POST",
      headers: requests[0].headers,
      body: "Odyssey 7pm: A2 now available (2 open total) — https://drafthouse.com",
    });
    assert.equal(requests[0].headers.title, "Alamo seats opened: 2103/93423");
    assert.match(requests[0].headers["content-type"], /^text\/plain/);

    const failDb = new DatabaseSync(dbPath);
    failDb.prepare("UPDATE watches SET notifyUrl = ?, seatState = ?, initialized = 1, lastChecked = NULL WHERE id = ?")
      .run(`http://127.0.0.1:${port}/fail`, JSON.stringify(["A1"]), added.id);
    failDb.close();

    assert.equal(await main(["monitor", "tick"]), 3);
    const failed = JSON.parse(logs.pop());
    assert.equal(failed.results[0].notifyStatus, "failed");
    assert.match(stderr, new RegExp(`Webhook notification failed for watch ${added.id}: HTTP 500`));

    assert.equal(await main(["monitor", "remove", String(added.id)]), 0);
    assert.deepEqual(JSON.parse(logs.pop()), { removed: added.id });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.stderr.write = originalError;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousJitter == null) delete process.env.SEATWATCH_JITTER_MS;
    else process.env.SEATWATCH_JITTER_MS = previousJitter;
    rmSync(home, { recursive: true, force: true });
  }
});
