import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ios-bridge-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "ios-bridge-test-key-0123456789abcdef";

const coreDb = await import("../../src/lib/db/core.ts");
const iosDb = await import("../../src/lib/db/iosBridge.ts");
const { iosBridgeSyncSchema, iosActionResultSchema } =
  await import("../../src/lib/iosBridge/schemas.ts");

function resetStorage() {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => resetStorage());

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const samplePayload = () =>
  iosBridgeSyncSchema.parse({
    device: "iPhone",
    calendar: {
      events: [
        { title: "Later", start: "2026-11-09T10:00:00+01:00" },
        { title: "Zahnarzt", start: "2026-11-08T09:00:00+01:00", calendar: "Privat" },
      ],
    },
    reminders: { items: [{ title: "Milch kaufen", list: "Einkauf" }] },
    location: { latitude: 52.52, longitude: 13.405, accuracy: 15 },
    health: {
      samples: [{ metric: "Heart Rate", value: 64, unit: "bpm", start: 1_762_500_000 }],
    },
  });

test("schema: normalizes dates (ISO offset + epoch seconds) and health metric names", () => {
  const parsed = samplePayload();
  assert.equal(parsed.calendar?.events[1].start, "2026-11-08T08:00:00.000Z");
  assert.equal(parsed.health?.samples[0].metric, "heart_rate");
  assert.equal(parsed.health?.samples[0].start, new Date(1_762_500_000_000).toISOString());
  assert.equal(parsed.reminders?.items[0].completed, false);
});

test("schema: rejects empty payloads, bad dates and out-of-range coordinates", () => {
  assert.equal(iosBridgeSyncSchema.safeParse({ device: "x" }).success, false);
  assert.equal(
    iosBridgeSyncSchema.safeParse({ calendar: { events: [{ title: "a", start: "nope" }] } })
      .success,
    false
  );
  assert.equal(
    iosBridgeSyncSchema.safeParse({ location: { latitude: 91, longitude: 0 } }).success,
    false
  );
  assert.equal(iosActionResultSchema.safeParse({ results: [] }).success, false);
});

test("snapshots: saved per category, sorted, and read back", () => {
  const summary = iosDb.saveIosSnapshot(samplePayload(), new Date("2026-11-07T12:00:00Z"));
  assert.deepEqual(summary.updated, ["calendar", "reminders", "location", "health"]);
  assert.equal(summary.counts.calendar, 2);

  const calendar = iosDb.getIosCalendarSnapshot();
  assert.equal(calendar?.device, "iPhone");
  assert.deepEqual(
    calendar?.data.map((e) => e.title),
    ["Zahnarzt", "Later"]
  );
  assert.equal(iosDb.getIosLocationSnapshot()?.data.timestamp, "2026-11-07T12:00:00.000Z");

  // A later sync with only reminders leaves the other categories untouched.
  iosDb.saveIosSnapshot(iosBridgeSyncSchema.parse({ reminders: { items: [] } }));
  assert.equal(iosDb.getIosRemindersSnapshot()?.data.length, 0);
  assert.equal(iosDb.getIosCalendarSnapshot()?.data.length, 2);

  const status = iosDb.getIosBridgeStatus();
  assert.equal(status.connected, true);
  assert.equal(status.snapshots.health?.count, 1);
});

test("snapshots: encrypted at rest — raw DB value contains no plaintext", () => {
  iosDb.saveIosSnapshot(samplePayload());
  const row = coreDb
    .getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'ios_bridge' AND key = 'location'")
    .get() as { value: string };
  assert.ok(!row.value.includes("52.52"), "latitude must not be stored in plaintext");
  assert.ok(!row.value.includes("heart"), "no plaintext leakage");
});

test("status: empty bridge reports disconnected", () => {
  const status = iosDb.getIosBridgeStatus();
  assert.equal(status.connected, false);
  assert.equal(status.lastSyncAt, null);
  assert.deepEqual(status.actions, { pending: 0, done: 0, failed: 0 });
});

test("actions: enqueue → list pending → apply results (unknown ids reported)", () => {
  const a = iosDb.enqueueIosAction("reminders.create", { title: "Test" });
  const b = iosDb.enqueueIosAction("calendar.create_event", { title: "Call" });
  assert.equal(iosDb.listIosActions("pending").length, 2);

  const res = iosDb.applyIosActionResults({
    results: [
      { id: a.id, status: "done", result: "created" },
      { id: b.id, status: "failed", error: "No calendar" },
      { id: "does-not-exist", status: "done" },
    ],
  });
  assert.deepEqual(res.updated, [a.id, b.id]);
  assert.deepEqual(res.unknown, ["does-not-exist"]);
  assert.equal(iosDb.listIosActions("pending").length, 0);
  assert.equal(iosDb.getIosAction(b.id)?.error, "No calendar");
});

test("actions: finished actions older than 7 days are pruned, pending ones kept", () => {
  const old = new Date("2026-10-01T00:00:00Z");
  const done = iosDb.enqueueIosAction("reminders.delete", { title: "old" }, old);
  const pending = iosDb.enqueueIosAction("reminders.create", { title: "keep" }, old);
  iosDb.applyIosActionResults({ results: [{ id: done.id, status: "done" }] }, old);
  iosDb.enqueueIosAction("reminders.create", { title: "new" }, new Date("2026-11-07T00:00:00Z"));
  const ids = iosDb.listIosActions().map((x) => x.id);
  assert.ok(!ids.includes(done.id));
  assert.ok(ids.includes(pending.id));
});

test("actions: queue full of pending actions throws a clear error", () => {
  for (let i = 0; i < iosDb.IOS_ACTION_QUEUE_MAX; i++) {
    iosDb.enqueueIosAction("reminders.create", { title: `r${i}` });
  }
  assert.throws(
    () => iosDb.enqueueIosAction("reminders.create", { title: "overflow" }),
    iosDb.IosActionQueueFullError
  );
});

test("clearIosBridgeData removes everything", () => {
  iosDb.saveIosSnapshot(samplePayload());
  iosDb.enqueueIosAction("reminders.create", { title: "x" });
  iosDb.clearIosBridgeData();
  assert.equal(iosDb.getIosBridgeStatus().connected, false);
  assert.equal(iosDb.listIosActions().length, 0);
});

test("schema: accepts Apple Shortcuts quirks (bare arrays, blanks, comma decimals, Ja/Nein)", () => {
  const parsed = iosBridgeSyncSchema.parse({
    calendar: [{ title: "Termin", start: "2026-11-08T09:00:00+01:00", end: "", allDay: "Nein" }],
    reminders: [{ title: "Ohne Datum", due: "", list: "", priority: "" }],
    location: { latitude: "52,52", longitude: "13,405", accuracy: "" },
    health: [{ metric: "steps", value: "1234", start: "2026-11-07T00:00:00+01:00", end: "" }],
  });
  assert.equal(parsed.calendar?.events.length, 1);
  assert.equal(parsed.calendar?.events[0].end, undefined);
  assert.equal(parsed.calendar?.events[0].allDay, false);
  assert.equal(parsed.reminders?.items[0].due, undefined);
  assert.equal(parsed.reminders?.items[0].completed, false);
  assert.equal(parsed.location?.latitude, 52.52);
  assert.equal(parsed.location?.accuracy, undefined);
  assert.equal(parsed.health?.samples[0].value, 1234);
  // Still strict where it matters.
  assert.equal(
    iosBridgeSyncSchema.safeParse({ location: { latitude: "", longitude: 1 } }).success,
    false
  );
  assert.equal(
    iosBridgeSyncSchema.safeParse({ calendar: [{ title: "x", start: "" }] }).success,
    false
  );
});

test("claimIosActions: returns + marks only the requested types as done", () => {
  const rem = iosDb.enqueueIosAction("reminders.create", { title: "A" });
  const del = iosDb.enqueueIosAction("reminders.delete", { match: { title: "B" } });
  const claimed = iosDb.claimIosActions(["reminders.create", "calendar.create_event"]);
  assert.deepEqual(
    claimed.map((a) => a.id),
    [rem.id]
  );
  assert.equal(iosDb.getIosAction(rem.id)?.status, "done");
  assert.equal(iosDb.getIosAction(del.id)?.status, "pending");
  assert.equal(iosDb.claimIosActions(["reminders.create"]).length, 0, "claimed only once");
});
