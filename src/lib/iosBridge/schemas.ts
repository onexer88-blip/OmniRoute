/**
 * iOS Bridge — Zod schemas for the data an iPhone pushes to OmniRoute and for the
 * actions Claude queues for the iPhone to execute.
 *
 * The bridge mirrors the native integrations of the Claude iOS app (Calendar,
 * Reminders, Location/Maps, Apple Health) for any MCP client routed through
 * OmniRoute. The iPhone side is an Apple Shortcuts automation: it pushes snapshots
 * to `POST /api/v1/ios-bridge/sync` and pulls queued actions from
 * `GET /api/v1/ios-bridge/actions`. See docs/frameworks/IOS_BRIDGE.md.
 */
import { z } from "zod";

/**
 * Accepts an ISO-8601 string, any string `Date.parse` understands, or an epoch
 * timestamp (seconds or milliseconds) and normalizes it to an ISO-8601 string.
 */
export const isoDateSchema = z
  .union([z.string().trim().min(1).max(64), z.number().finite()])
  .transform((value, ctx) => {
    const ms =
      typeof value === "number"
        ? Math.abs(value) < 1e12
          ? value * 1000
          : value
        : Date.parse(value);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: "custom", message: "Invalid date — use ISO 8601" });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

// ── Shortcut-friendly coercion ──────────────────────────────────────────────
// Apple Shortcuts sends empty strings for unset fields, may format numbers with a
// decimal comma ("52,52") and booleans as "Ja"/"Nein"/"1"/"0". Accept those instead of
// rejecting the whole sync.

const blankToUndefined = (v: unknown) =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : v;

/** Optional date: "" / null → undefined, otherwise {@link isoDateSchema}. */
export const optionalDateSchema = z.preprocess(blankToUndefined, isoDateSchema.optional());

/** Number that also accepts numeric strings, including a decimal comma. */
export function flexNumber<T extends z.ZodType>(inner: T) {
  return z.preprocess((v) => {
    const b = blankToUndefined(v);
    return typeof b === "string" ? Number(b.trim().replace(",", ".")) : b;
  }, inner);
}

const TRUE_WORDS = new Set(["true", "1", "ja", "yes", "wahr"]);
const FALSE_WORDS = new Set(["false", "0", "nein", "no", "falsch"]);

/** Optional boolean that also accepts "Ja"/"Nein"/"1"/"0"/"true"/"false". */
export const flexBoolean = z.preprocess((v) => {
  const b = blankToUndefined(v);
  if (typeof b === "number") return b !== 0;
  if (typeof b !== "string") return b;
  const w = b.trim().toLowerCase();
  if (TRUE_WORDS.has(w)) return true;
  if (FALSE_WORDS.has(w)) return false;
  return b;
}, z.boolean().optional());

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const shortText = z.string().trim().max(500);
const longText = z.string().max(10_000);

export const calendarEventSchema = z.object({
  id: optionalText(512),
  title: z.string().trim().min(1).max(1000),
  start: isoDateSchema,
  end: optionalDateSchema,
  allDay: flexBoolean,
  location: shortText.optional(),
  notes: longText.optional(),
  calendar: optionalText(200),
  url: optionalText(2000),
});

export const reminderSchema = z.object({
  id: optionalText(512),
  title: z.string().trim().min(1).max(1000),
  list: optionalText(200),
  due: optionalDateSchema,
  completed: flexBoolean.transform((v) => v ?? false),
  priority: flexNumber(z.number().int().min(0).max(9).optional()),
  notes: longText.optional(),
  flagged: flexBoolean,
});

export const locationSchema = z.object({
  latitude: flexNumber(z.number().min(-90).max(90)),
  longitude: flexNumber(z.number().min(-180).max(180)),
  accuracy: flexNumber(z.number().min(0).max(100_000).optional()),
  altitude: flexNumber(z.number().min(-1000).max(100_000).optional()),
  address: shortText.optional(),
  timestamp: optionalDateSchema,
});

export const healthSampleSchema = z.object({
  metric: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((m) => m.toLowerCase().replace(/[\s-]+/g, "_")),
  value: flexNumber(z.number().finite()),
  unit: optionalText(50),
  start: isoDateSchema,
  end: optionalDateSchema,
  source: optionalText(200),
});

export const IOS_BRIDGE_LIMITS = {
  calendarEvents: 2000,
  reminders: 2000,
  healthSamples: 5000,
} as const;

function listOrWrapped<T extends z.ZodType, K extends string>(item: T, key: K, max: number) {
  const list = z.array(item).max(max);
  // Wrap a bare array before validation so issue paths stay precise
  // ("calendar.events.0.start"), which a union would collapse to "calendar".
  return z.preprocess(
    (v) => (Array.isArray(v) ? { [key]: v } : v),
    z.object({ [key]: list } as Record<K, typeof list>).optional()
  );
}

export const iosBridgeSyncSchema = z
  .object({
    device: z.string().trim().max(100).optional(),
    // Each list accepts the wrapped form ({ events: [...] }) or a bare array, which is
    // what a Shortcuts "Set Dictionary Value" with Repeat Results produces.
    calendar: listOrWrapped(calendarEventSchema, "events", IOS_BRIDGE_LIMITS.calendarEvents),
    reminders: listOrWrapped(reminderSchema, "items", IOS_BRIDGE_LIMITS.reminders),
    location: locationSchema.optional(),
    health: listOrWrapped(healthSampleSchema, "samples", IOS_BRIDGE_LIMITS.healthSamples),
  })
  .refine((d) => Boolean(d.calendar || d.reminders || d.location || d.health), {
    message: "Provide at least one of: calendar, reminders, location, health",
  });

export const IOS_ACTION_TYPES = [
  "calendar.create_event",
  "reminders.create",
  "reminders.update",
  "reminders.complete",
  "reminders.delete",
] as const;

export type IosActionType = (typeof IOS_ACTION_TYPES)[number];

export const iosActionResultSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        status: z.enum(["done", "failed"]),
        result: z.string().max(2000).optional(),
        error: z.string().max(2000).optional(),
      })
    )
    .min(1)
    .max(200),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type Reminder = z.infer<typeof reminderSchema>;
export type IosLocation = z.infer<typeof locationSchema>;
export type HealthSample = z.infer<typeof healthSampleSchema>;
export type IosBridgeSyncPayload = z.infer<typeof iosBridgeSyncSchema>;
export type IosActionResults = z.infer<typeof iosActionResultSchema>;
