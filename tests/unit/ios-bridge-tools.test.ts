import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ios-bridge-tools-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const iosDb = await import("../../src/lib/db/iosBridge.ts");
const { iosBridgeSyncSchema } = await import("../../src/lib/iosBridge/schemas.ts");
const { iosBridgeTools, summarizeHealth, buildAppleMapsUrl, buildComposeUrl } =
  await import("../../open-sse/mcp-server/tools/iosBridgeTools.ts");
const { evaluateToolScopes } = await import("../../open-sse/mcp-server/scopeEnforcement.ts");

type Tool = (typeof iosBridgeTools)[number];
const tool = (name: string): Tool => {
  const found = iosBridgeTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} must exist`);
  return found;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool handlers take per-tool arg shapes
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const t = tool(name);
  // @ts-ignore — per-tool handler arg types
  return t.handler(t.inputSchema.parse(args));
};

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("every iOS tool has a scope; health and location use dedicated scopes", () => {
  for (const t of iosBridgeTools) assert.ok(t.scopes.length > 0, `${t.name} needs a scope`);
  assert.deepEqual(tool("ios_health_summary").scopes, ["read:ios_health"]);
  assert.deepEqual(tool("ios_location_get").scopes, ["read:ios_location"]);
  const denied = evaluateToolScopes("ios_health_summary", ["read:ios"], true, ["read:ios_health"]);
  assert.equal(denied.allowed, false);
  const writeDenied = evaluateToolScopes("ios_reminders_create", ["read:ios"], true, ["write:ios"]);
  assert.equal(writeDenied.allowed, false);
});

test("read tools report 'not synced' with a setup hint before the first sync", async () => {
  for (const name of [
    "ios_calendar_list_events",
    "ios_reminders_list",
    "ios_location_get",
    "ios_health_summary",
  ]) {
    const res = await call(name);
    assert.equal(res.available, false, name);
    assert.match(res.message, /IOS_BRIDGE\.md/);
  }
});

test("ios_calendar_list_events filters by range, calendar and query", async () => {
  iosDb.saveIosSnapshot(
    iosBridgeSyncSchema.parse({
      calendar: {
        events: [
          { title: "Zahnarzt", start: "2026-11-08T09:00:00Z", calendar: "Privat" },
          { title: "Standup", start: "2026-11-08T10:00:00Z", calendar: "Arbeit" },
          { title: "Urlaub", start: "2026-12-20T00:00:00Z", calendar: "Privat" },
        ],
      },
    })
  );
  const range = { from: "2026-11-08T00:00:00Z", to: "2026-11-09T00:00:00Z" };
  const all = await call("ios_calendar_list_events", range);
  assert.equal(all.total, 2);
  assert.deepEqual(all.calendars, ["Arbeit", "Privat"]);
  const privat = await call("ios_calendar_list_events", { ...range, calendar: "privat" });
  assert.deepEqual(
    privat.events.map((e: { title: string }) => e.title),
    ["Zahnarzt"]
  );
  const q = await call("ios_calendar_list_events", { ...range, query: "stand" });
  assert.equal(q.total, 1);
});

test("ios_reminders_list hides completed items and sorts by due date", async () => {
  iosDb.saveIosSnapshot(
    iosBridgeSyncSchema.parse({
      reminders: {
        items: [
          { title: "Ohne Datum", list: "Privat" },
          { title: "Später", list: "Privat", due: "2026-11-20T10:00:00Z" },
          { title: "Bald", list: "Privat", due: "2026-11-08T10:00:00Z" },
          { title: "Erledigt", list: "Privat", completed: true },
        ],
      },
    })
  );
  const res = await call("ios_reminders_list");
  assert.deepEqual(
    res.items.map((r: { title: string }) => r.title),
    ["Bald", "Später", "Ohne Datum"]
  );
  const withDone = await call("ios_reminders_list", { includeCompleted: true });
  assert.equal(withDone.total, 4);
  const dueSoon = await call("ios_reminders_list", { dueBefore: "2026-11-10T00:00:00Z" });
  assert.equal(dueSoon.total, 1);
});

test("write tools queue actions for the iPhone", async () => {
  const ev = await call("ios_calendar_create_event", {
    title: "Meeting",
    start: "2026-11-08T14:00:00+01:00",
  });
  assert.equal(ev.queued, true);
  assert.equal(ev.action.type, "calendar.create_event");
  assert.equal(ev.action.payload.end, "2026-11-08T14:00:00.000Z", "default end = start + 1h");

  await call("ios_reminders_create", { title: "Milch", list: "Einkauf", priority: "high" });
  await call("ios_reminders_complete", { title: "Milch", list: "Einkauf" });
  const upd = await call("ios_reminders_update", { title: "Milch", newTitle: "Hafermilch" });
  assert.deepEqual(upd.action.payload.match, { id: undefined, title: "Milch", list: undefined });
  assert.equal(upd.action.payload.changes.newTitle, "Hafermilch");
  await call("ios_reminders_delete", { title: "Hafermilch" });

  const pending = await call("ios_actions_list", { status: "pending" });
  assert.equal(pending.total, 5);
  assert.equal(iosDb.getIosBridgeStatus().actions.pending, 5);
});

test("write tools reject invalid input", async () => {
  await assert.rejects(() =>
    call("ios_calendar_create_event", {
      title: "x",
      start: "2026-11-08T14:00:00Z",
      end: "2026-11-08T13:00:00Z",
    })
  );
  await assert.rejects(() => call("ios_reminders_update", { title: "x" }), /Nothing to update/);
  await assert.rejects(() => call("ios_maps_link", {}), /Provide query/);
});

test("ios_location_get returns the last location with an Apple Maps link", async () => {
  iosDb.saveIosSnapshot(
    iosBridgeSyncSchema.parse({ location: { latitude: 48.137, longitude: 11.575 } })
  );
  const res = await call("ios_location_get");
  assert.equal(res.available, true);
  assert.equal(res.location.latitude, 48.137);
  assert.match(res.mapsUrl, /^https:\/\/maps\.apple\.com\/\?ll=48\.137%2C11\.575/);
});

test("ios_health_summary aggregates per metric and per local day", async () => {
  iosDb.saveIosSnapshot(
    iosBridgeSyncSchema.parse({
      health: {
        samples: [
          { metric: "steps", value: 4000, unit: "count", start: "2026-11-06T22:30:00Z" },
          { metric: "steps", value: 6000, unit: "count", start: "2026-11-07T08:00:00Z" },
          { metric: "heart_rate", value: 60, unit: "bpm", start: "2026-11-07T08:00:00Z" },
        ],
      },
    })
  );
  const res = await call("ios_health_summary", {
    metrics: ["steps"],
    from: "2026-11-01T00:00:00Z",
    timeZone: "Europe/Berlin",
  });
  assert.equal(res.metrics.length, 1);
  assert.equal(res.metrics[0].sum, 10000);
  // 22:30Z on Nov 6 is 23:30 in Berlin → still Nov 6; both samples on separate days
  assert.deepEqual(
    res.metrics[0].daily.map((d: { date: string }) => d.date),
    ["2026-11-06", "2026-11-07"]
  );
  assert.deepEqual(res.availableMetrics, ["heart_rate", "steps"]);
});

test("summarizeHealth respects the time window", () => {
  const out = summarizeHealth(
    [
      { metric: "steps", value: 1, start: "2026-01-01T00:00:00Z" },
      { metric: "steps", value: 2, start: "2026-02-01T00:00:00Z" },
    ],
    { from: "2026-01-15T00:00:00Z" }
  );
  assert.equal(out.metrics[0].sum, 2);
});

test("link builders produce Apple Maps directions and mailto/sms drafts", () => {
  const dir = buildAppleMapsUrl({ destination: "Marienplatz München", mode: "walking" });
  assert.equal(dir, "https://maps.apple.com/?daddr=Marienplatz+M%C3%BCnchen&dirflg=w");
  assert.equal(
    buildComposeUrl({ channel: "email", to: ["a@b.de"], subject: "Hallo", body: "Wie geht's?" }),
    "mailto:a@b.de?subject=Hallo&body=Wie%20geht's%3F"
  );
  assert.equal(
    buildComposeUrl({ channel: "sms", to: ["+49 123"], body: "Bin gleich da" }),
    "sms:+49123&body=Bin%20gleich%20da"
  );
});

test("toIosActionView lifts nested fields and trims date milliseconds", async () => {
  const { toIosActionView } = await import("../../src/lib/iosBridge/actionView.ts");
  const ev = await call("ios_calendar_create_event", {
    title: "Arzt",
    start: "2026-11-08T14:00:00+01:00",
    calendar: "Privat",
  });
  const view = toIosActionView(ev.action);
  assert.equal(view.title, "Arzt");
  assert.equal(view.start, "2026-11-08T13:00:00Z");
  assert.equal(view.end, "2026-11-08T14:00:00Z");
  assert.equal(view.calendar, "Privat");
  assert.equal(view.due, "");

  const upd = await call("ios_reminders_update", {
    title: "Milch",
    list: "Einkauf",
    newTitle: "Hafermilch",
  });
  const uview = toIosActionView(upd.action);
  assert.equal(uview.title, "Milch");
  assert.equal(uview.list, "Einkauf");
  assert.equal(uview.newTitle, "Hafermilch");
});
