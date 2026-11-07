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

const shortText = z.string().trim().max(500);
const longText = z.string().max(10_000);

export const calendarEventSchema = z.object({
  id: z.string().trim().max(512).optional(),
  title: z.string().trim().min(1).max(1000),
  start: isoDateSchema,
  end: isoDateSchema.optional(),
  allDay: z.boolean().optional(),
  location: shortText.optional(),
  notes: longText.optional(),
  calendar: z.string().trim().max(200).optional(),
  url: z.string().trim().max(2000).optional(),
});

export const reminderSchema = z.object({
  id: z.string().trim().max(512).optional(),
  title: z.string().trim().min(1).max(1000),
  list: z.string().trim().max(200).optional(),
  due: isoDateSchema.optional(),
  completed: z.boolean().optional().default(false),
  priority: z.number().int().min(0).max(9).optional(),
  notes: longText.optional(),
  flagged: z.boolean().optional(),
});

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).optional(),
  altitude: z.number().min(-1000).max(100_000).optional(),
  address: shortText.optional(),
  timestamp: isoDateSchema.optional(),
});

export const healthSampleSchema = z.object({
  metric: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((m) => m.toLowerCase().replace(/[\s-]+/g, "_")),
  value: z.number().finite(),
  unit: z.string().trim().max(50).optional(),
  start: isoDateSchema,
  end: isoDateSchema.optional(),
  source: z.string().trim().max(200).optional(),
});

export const IOS_BRIDGE_LIMITS = {
  calendarEvents: 2000,
  reminders: 2000,
  healthSamples: 5000,
} as const;

export const iosBridgeSyncSchema = z
  .object({
    device: z.string().trim().max(100).optional(),
    calendar: z
      .object({ events: z.array(calendarEventSchema).max(IOS_BRIDGE_LIMITS.calendarEvents) })
      .optional(),
    reminders: z
      .object({ items: z.array(reminderSchema).max(IOS_BRIDGE_LIMITS.reminders) })
      .optional(),
    location: locationSchema.optional(),
    health: z
      .object({ samples: z.array(healthSampleSchema).max(IOS_BRIDGE_LIMITS.healthSamples) })
      .optional(),
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
