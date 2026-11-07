/**
 * iOS Bridge MCP tools — the native iPhone integrations of the Claude iOS app
 * (Calendar, Reminders, Location & Maps, Apple Health, message/email drafts),
 * rebuilt for any MCP client that talks to OmniRoute.
 *
 * Reads are served from the snapshots the iPhone pushes via Apple Shortcuts
 * (`POST /api/v1/ios-bridge/sync`). Writes are queued as actions that the same
 * shortcut pulls (`GET /api/v1/ios-bridge/actions`) and executes on the device.
 * Apple Health stays read-only, exactly like the iOS app. Setup:
 * docs/frameworks/IOS_BRIDGE.md.
 */
import { z } from "zod";

import {
  enqueueIosAction,
  getIosBridgeStatus,
  getIosCalendarSnapshot,
  getIosHealthSnapshot,
  getIosLocationSnapshot,
  getIosRemindersSnapshot,
  listIosActions,
  type IosSnapshot,
} from "../../../src/lib/db/iosBridge.ts";
import { isoDateSchema } from "../../../src/lib/iosBridge/schemas.ts";
import type { HealthSample } from "../../../src/lib/iosBridge/schemas.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETUP_HINT =
  "Run the 'OmniRoute Sync' shortcut on the iPhone (setup: docs/frameworks/IOS_BRIDGE.md).";
const QUEUED_NOTE =
  "Queued for the iPhone. It runs the next time the 'OmniRoute Sync' shortcut executes; check with ios_actions_list.";

function freshness(snapshot: IosSnapshot<unknown>, now = Date.now()) {
  return {
    syncedAt: snapshot.syncedAt,
    ageMinutes: Math.max(0, Math.round((now - Date.parse(snapshot.syncedAt)) / 60_000)),
    device: snapshot.device,
  };
}

function notSynced(kind: string) {
  return { available: false, message: `No ${kind} data synced yet. ${SETUP_HINT}` };
}

const includesCI = (haystack: string | undefined, needle: string) =>
  typeof haystack === "string" && haystack.toLowerCase().includes(needle.toLowerCase());

const equalsCI = (a: string | undefined, b: string) =>
  typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

function localDay(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function stats(values: number[]) {
  const sum = values.reduce((acc, v) => acc + v, 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    count: values.length,
    sum: round(sum),
    avg: values.length ? round(sum / values.length) : 0,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  };
}

/** Exported for tests. */
export function summarizeHealth(
  samples: HealthSample[],
  opts: { metrics?: string[]; from?: string; to?: string; daily?: boolean; timeZone?: string }
) {
  const wanted = opts.metrics?.map((m) => m.toLowerCase().replace(/[\s-]+/g, "_"));
  const fromMs = opts.from ? Date.parse(opts.from) : -Infinity;
  const toMs = opts.to ? Date.parse(opts.to) : Infinity;
  const timeZone = opts.timeZone || "UTC";
  const byMetric = new Map<string, HealthSample[]>();
  for (const s of samples) {
    if (wanted && !wanted.includes(s.metric)) continue;
    const t = Date.parse(s.start);
    if (t < fromMs || t > toMs) continue;
    const list = byMetric.get(s.metric) ?? [];
    list.push(s);
    byMetric.set(s.metric, list);
  }
  const metrics = [...byMetric.entries()].map(([metric, list]) => {
    const latest = list[list.length - 1];
    const summary: Record<string, unknown> = {
      metric,
      unit: latest.unit ?? null,
      ...stats(list.map((s) => s.value)),
      latest: { value: latest.value, at: latest.start },
    };
    if (opts.daily) {
      const days = new Map<string, number[]>();
      for (const s of list) {
        const day = localDay(s.start, timeZone);
        days.set(day, [...(days.get(day) ?? []), s.value]);
      }
      summary.daily = [...days.entries()].map(([date, values]) => ({ date, ...stats(values) }));
    }
    return summary;
  });
  return { metrics, availableMetrics: [...new Set(samples.map((s) => s.metric))].sort() };
}

/** Exported for tests. */
export function buildAppleMapsUrl(args: {
  query?: string;
  latitude?: number;
  longitude?: number;
  destination?: string;
  origin?: string;
  mode?: "driving" | "walking" | "transit";
}): string {
  const params = new URLSearchParams();
  if (args.destination) {
    params.set("daddr", args.destination);
    if (args.origin) params.set("saddr", args.origin);
    params.set("dirflg", { driving: "d", walking: "w", transit: "r" }[args.mode ?? "driving"]);
  } else if (args.query) {
    params.set("q", args.query);
  }
  if (args.latitude !== undefined && args.longitude !== undefined) {
    params.set(args.query || args.destination ? "sll" : "ll", `${args.latitude},${args.longitude}`);
    if (!args.query && !args.destination) params.set("q", "Pin");
  }
  return `https://maps.apple.com/?${params.toString()}`;
}

/** Exported for tests. */
export function buildComposeUrl(args: {
  channel: "email" | "sms";
  to?: string[];
  subject?: string;
  body: string;
}): string {
  const enc = encodeURIComponent;
  const to = (args.to ?? []).map((t) => t.trim()).filter(Boolean);
  if (args.channel === "sms") {
    // Phone numbers / iMessage addresses: keep only characters iOS accepts unencoded.
    const recipients = to.map((t) => t.replace(/[^\w+*#@.-]/g, "")).filter(Boolean);
    return `sms:${recipients.join(",")}&body=${enc(args.body)}`;
  }
  const query = [
    args.subject ? `subject=${enc(args.subject)}` : null,
    `body=${enc(args.body)}`,
  ].filter(Boolean);
  const recipients = to.map((t) => enc(t).replace(/%40/g, "@"));
  return `mailto:${recipients.join(",")}?${query.join("&")}`;
}

const reminderMatch = {
  id: z.string().trim().max(512).optional().describe("Reminder id from ios_reminders_list"),
  title: z.string().trim().min(1).max(1000).describe("Current title of the reminder"),
  list: z.string().trim().max(200).optional().describe("Reminders list the item lives in"),
};

export const iosBridgeTools = [
  {
    name: "ios_bridge_status",
    description:
      "Check the iPhone connection: when calendar, reminders, location and health were last synced and how many queued actions are pending.",
    scopes: ["read:ios"],
    inputSchema: z.object({}),
    handler: async () => ({ ...getIosBridgeStatus(), setup: SETUP_HINT }),
  },
  {
    name: "ios_calendar_list_events",
    description:
      "List events from the iPhone's Apple Calendar (all calendars synced from the device). Defaults to the next 7 days.",
    scopes: ["read:ios"],
    inputSchema: z.object({
      from: isoDateSchema.optional().describe("Range start (ISO 8601). Default: now"),
      to: isoDateSchema.optional().describe("Range end (ISO 8601). Default: from + 7 days"),
      query: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Text to match in title/location/notes"),
      calendar: z.string().trim().max(200).optional().describe("Only events of this calendar"),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    handler: async (args: {
      from?: string;
      to?: string;
      query?: string;
      calendar?: string;
      limit?: number;
    }) => {
      const snapshot = getIosCalendarSnapshot();
      if (!snapshot) return notSynced("calendar");
      const fromMs = args.from ? Date.parse(args.from) : Date.now();
      const toMs = args.to ? Date.parse(args.to) : fromMs + 7 * DAY_MS;
      const events = snapshot.data.filter((e) => {
        const start = Date.parse(e.start);
        const end = e.end ? Date.parse(e.end) : start;
        if (end < fromMs || start > toMs) return false;
        if (args.calendar && !equalsCI(e.calendar, args.calendar)) return false;
        if (args.query) {
          return [e.title, e.location, e.notes].some((f) => includesCI(f, args.query as string));
        }
        return true;
      });
      return {
        available: true,
        ...freshness(snapshot),
        range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        total: events.length,
        events: events.slice(0, args.limit ?? 50),
        calendars: [...new Set(snapshot.data.map((e) => e.calendar).filter(Boolean))].sort(),
      };
    },
  },
  {
    name: "ios_calendar_create_event",
    description:
      "Create an event in the iPhone's Apple Calendar. The event is queued and created on the device by the OmniRoute shortcut.",
    scopes: ["write:ios"],
    inputSchema: z.object({
      title: z.string().trim().min(1).max(1000),
      start: isoDateSchema.describe("Start (ISO 8601 with offset, e.g. 2026-11-08T14:00:00+01:00)"),
      end: isoDateSchema.optional().describe("End (ISO 8601). Default: start + 1 hour"),
      allDay: z.boolean().optional(),
      location: z.string().trim().max(500).optional(),
      notes: z.string().max(10_000).optional(),
      calendar: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Target calendar (default calendar if omitted)"),
      url: z.string().trim().max(2000).optional(),
    }),
    handler: async (args: Record<string, unknown> & { start: string; end?: string }) => {
      const end = args.end ?? new Date(Date.parse(args.start) + 60 * 60 * 1000).toISOString();
      if (Date.parse(end) < Date.parse(args.start)) {
        throw new Error("Event end must not be before its start");
      }
      const action = enqueueIosAction("calendar.create_event", { ...args, end });
      return { queued: true, action, note: QUEUED_NOTE };
    },
  },
  {
    name: "ios_reminders_list",
    description:
      "List items from the iPhone's Apple Reminders. Open items only unless includeCompleted is true.",
    scopes: ["read:ios"],
    inputSchema: z.object({
      list: z.string().trim().max(200).optional().describe("Only items of this Reminders list"),
      query: z.string().trim().max(200).optional().describe("Text to match in title/notes"),
      includeCompleted: z.boolean().default(false),
      dueBefore: isoDateSchema.optional().describe("Only items due before this date"),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: async (args: {
      list?: string;
      query?: string;
      includeCompleted?: boolean;
      dueBefore?: string;
      limit?: number;
    }) => {
      const snapshot = getIosRemindersSnapshot();
      if (!snapshot) return notSynced("reminders");
      const dueBeforeMs = args.dueBefore ? Date.parse(args.dueBefore) : null;
      const items = snapshot.data
        .filter((r) => {
          if (!args.includeCompleted && r.completed) return false;
          if (args.list && !equalsCI(r.list, args.list)) return false;
          if (dueBeforeMs !== null && (!r.due || Date.parse(r.due) > dueBeforeMs)) return false;
          if (args.query) return includesCI(r.title, args.query) || includesCI(r.notes, args.query);
          return true;
        })
        .sort((a, b) => (a.due ?? "￿").localeCompare(b.due ?? "￿"));
      return {
        available: true,
        ...freshness(snapshot),
        total: items.length,
        items: items.slice(0, args.limit ?? 100),
        lists: [...new Set(snapshot.data.map((r) => r.list).filter(Boolean))].sort(),
      };
    },
  },
  {
    name: "ios_reminders_create",
    description:
      "Create a reminder in the iPhone's Apple Reminders (queued, executed on the device).",
    scopes: ["write:ios"],
    inputSchema: z.object({
      title: z.string().trim().min(1).max(1000),
      list: z.string().trim().max(200).optional().describe("Target list (default list if omitted)"),
      due: isoDateSchema.optional().describe("Due date/time (ISO 8601)"),
      notes: z.string().max(10_000).optional(),
      priority: z.enum(["none", "low", "medium", "high"]).optional(),
      flagged: z.boolean().optional(),
    }),
    handler: async (args: Record<string, unknown>) => {
      const action = enqueueIosAction("reminders.create", args);
      return { queued: true, action, note: QUEUED_NOTE };
    },
  },
  {
    name: "ios_reminders_update",
    description:
      "Change an existing reminder (title, due date, notes, priority, list). Matched on the device by title (and list).",
    scopes: ["write:ios"],
    inputSchema: z.object({
      ...reminderMatch,
      newTitle: z.string().trim().min(1).max(1000).optional(),
      due: isoDateSchema.optional(),
      notes: z.string().max(10_000).optional(),
      priority: z.enum(["none", "low", "medium", "high"]).optional(),
      moveToList: z.string().trim().max(200).optional(),
    }),
    handler: async (
      args: Record<string, unknown> & { id?: string; title: string; list?: string }
    ) => {
      const { id, title, list, ...changes } = args;
      if (Object.values(changes).every((v) => v === undefined)) {
        throw new Error("Nothing to update — pass at least one change");
      }
      const action = enqueueIosAction("reminders.update", { match: { id, title, list }, changes });
      return { queued: true, action, note: QUEUED_NOTE };
    },
  },
  {
    name: "ios_reminders_complete",
    description: "Mark a reminder as completed on the iPhone (queued, matched by title and list).",
    scopes: ["write:ios"],
    inputSchema: z.object(reminderMatch),
    handler: async (args: { id?: string; title: string; list?: string }) => {
      const action = enqueueIosAction("reminders.complete", { match: args });
      return { queued: true, action, note: QUEUED_NOTE };
    },
  },
  {
    name: "ios_reminders_delete",
    description: "Delete a reminder on the iPhone (queued, matched by title and list).",
    scopes: ["write:ios"],
    inputSchema: z.object(reminderMatch),
    handler: async (args: { id?: string; title: string; list?: string }) => {
      const action = enqueueIosAction("reminders.delete", { match: args });
      return { queued: true, action, note: QUEUED_NOTE };
    },
  },
  {
    name: "ios_actions_list",
    description:
      "List actions queued for the iPhone and whether the device executed them (pending / done / failed).",
    scopes: ["read:ios"],
    inputSchema: z.object({
      status: z.enum(["pending", "done", "failed"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    handler: async (args: { status?: "pending" | "done" | "failed"; limit?: number }) => {
      const actions = listIosActions(args.status)
        .slice(-(args.limit ?? 50))
        .reverse();
      return { total: actions.length, actions };
    },
  },
  {
    name: "ios_location_get",
    description:
      "Get the iPhone's last known location (latitude, longitude, accuracy, address if provided by the shortcut).",
    scopes: ["read:ios_location"],
    inputSchema: z.object({}),
    handler: async () => {
      const snapshot = getIosLocationSnapshot();
      if (!snapshot) return notSynced("location");
      const location = snapshot.data;
      return {
        available: true,
        ...freshness(snapshot),
        location,
        mapsUrl: buildAppleMapsUrl({ latitude: location.latitude, longitude: location.longitude }),
      };
    },
  },
  {
    name: "ios_maps_link",
    description:
      "Build an Apple Maps link to show a place, search nearby, or start directions on the iPhone. Combine with ios_location_get for 'near me'.",
    scopes: ["read:ios"],
    inputSchema: z.object({
      query: z.string().trim().max(500).optional().describe("Place or search term, e.g. 'Cafe'"),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      destination: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Directions target (address or place)"),
      origin: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Directions start (default: current location)"),
      mode: z.enum(["driving", "walking", "transit"]).default("driving"),
    }),
    handler: async (args: Parameters<typeof buildAppleMapsUrl>[0]) => {
      const hasCoords = args.latitude !== undefined && args.longitude !== undefined;
      if (!args.query && !args.destination && !hasCoords) {
        throw new Error("Provide query, destination, or latitude+longitude");
      }
      return { url: buildAppleMapsUrl(args) };
    },
  },
  {
    name: "ios_health_summary",
    description:
      "Read Apple Health data synced from the iPhone (steps, heart rate, sleep, workouts, …): per-metric totals/averages, optionally per day. Read-only — nothing is written to Health.",
    scopes: ["read:ios_health"],
    inputSchema: z.object({
      metrics: z
        .array(z.string().trim().min(1).max(100))
        .max(50)
        .optional()
        .describe("e.g. ['steps','heart_rate']. Default: all"),
      from: isoDateSchema.optional().describe("Default: 7 days ago"),
      to: isoDateSchema.optional(),
      daily: z.boolean().default(true).describe("Include per-day breakdown"),
      timeZone: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe("IANA zone for daily buckets, e.g. Europe/Berlin"),
    }),
    handler: async (args: {
      metrics?: string[];
      from?: string;
      to?: string;
      daily?: boolean;
      timeZone?: string;
    }) => {
      const snapshot = getIosHealthSnapshot();
      if (!snapshot) return notSynced("health");
      const from = args.from ?? new Date(Date.now() - 7 * DAY_MS).toISOString();
      return {
        available: true,
        ...freshness(snapshot),
        range: { from, to: args.to ?? null },
        ...summarizeHealth(snapshot.data, {
          ...args,
          from,
          timeZone: args.timeZone || process.env.TZ,
        }),
      };
    },
  },
  {
    name: "ios_compose_draft",
    description:
      "Draft an email or text message for the iPhone: returns a mailto:/sms: link that opens Mail or Messages with everything pre-filled (the user sends it).",
    scopes: ["read:ios"],
    inputSchema: z.object({
      channel: z.enum(["email", "sms"]),
      to: z
        .array(z.string().trim().min(1).max(320))
        .max(20)
        .optional()
        .describe("Email addresses or phone numbers"),
      subject: z.string().max(500).optional().describe("Email only"),
      body: z.string().min(1).max(10_000),
    }),
    handler: async (args: Parameters<typeof buildComposeUrl>[0]) => ({
      url: buildComposeUrl(args),
      note: "Open the link on the iPhone to review and send.",
    }),
  },
];
