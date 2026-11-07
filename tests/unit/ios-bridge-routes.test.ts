import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ios-bridge-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ios-bridge-route-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const iosDb = await import("../../src/lib/db/iosBridge.ts");
const syncRoute = await import("../../src/app/api/v1/ios-bridge/sync/route.ts");
const actionsRoute = await import("../../src/app/api/v1/ios-bridge/actions/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const req = (url: string, init: { method?: string; key?: string; body?: unknown } = {}) =>
  new Request(`http://localhost/api/v1/ios-bridge/${url}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

let apiKey = "";
test.before(async () => {
  apiKey = (await apiKeysDb.createApiKey("iphone-shortcut", "machine-ios", [])).key;
});

test("all endpoints reject missing or invalid API keys", async () => {
  for (const res of [
    await syncRoute.POST(req("sync", { method: "POST", body: { location: {} } })),
    await syncRoute.GET(req("sync")),
    await actionsRoute.GET(req("actions", { key: "sk-wrong" })),
    await actionsRoute.POST(req("actions", { method: "POST", key: "sk-wrong", body: {} })),
  ]) {
    assert.equal(res.status, 401);
  }
});

test("POST /sync stores snapshots and reports pending actions", async () => {
  iosDb.enqueueIosAction("reminders.create", { title: "Queued before sync" });
  const res = await syncRoute.POST(
    req("sync", {
      method: "POST",
      key: apiKey,
      body: {
        device: "iPhone 17",
        calendar: { events: [{ title: "Termin", start: "2026-11-08T09:00:00+01:00" }] },
        location: { latitude: 50.11, longitude: 8.68 },
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.updated, ["calendar", "location"]);
  assert.equal(body.pendingActions, 1);

  const status = await (await syncRoute.GET(req("sync", { key: apiKey }))).json();
  assert.equal(status.connected, true);
  assert.equal(status.device, "iPhone 17");
});

test("POST /sync returns 400 with a field path and no stack trace on bad input", async () => {
  const res = await syncRoute.POST(
    req("sync", {
      method: "POST",
      key: apiKey,
      body: { calendar: { events: [{ title: "x", start: "kein Datum" }] } },
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "bad_request");
  assert.match(body.error.message, /calendar\.events\.0\.start/);
  assert.ok(!body.error.message.includes("at /"), "must not leak a stack trace");
});

test("GET /actions → POST results round trip", async () => {
  const pending = await (await actionsRoute.GET(req("actions", { key: apiKey }))).json();
  assert.ok(pending.count >= 1);
  const id = pending.actions[0].id;

  const res = await actionsRoute.POST(
    req("actions", {
      method: "POST",
      key: apiKey,
      body: {
        results: [
          { id, status: "done", result: "ok" },
          { id: "ghost", status: "failed" },
        ],
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.updated, [id]);
  assert.deepEqual(body.unknown, ["ghost"]);

  const after = await (await actionsRoute.GET(req("actions", { key: apiKey }))).json();
  assert.ok(!after.actions.some((a: { id: string }) => a.id === id));
});

test("POST /actions rejects malformed results", async () => {
  const res = await actionsRoute.POST(
    req("actions", { method: "POST", key: apiKey, body: { results: "nope" } })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /Invalid action results/);
});

test("DELETE /sync wipes snapshots and actions", async () => {
  iosDb.enqueueIosAction("reminders.create", { title: "to be wiped" });
  assert.equal((await syncRoute.DELETE(req("sync", { method: "DELETE" }))).status, 401);
  const res = await syncRoute.DELETE(req("sync", { method: "DELETE", key: apiKey }));
  assert.equal(res.status, 200);
  const status = await (await syncRoute.GET(req("sync", { key: apiKey }))).json();
  assert.equal(status.connected, false);
  assert.equal(status.actions.pending, 0);
});
