import { z } from "zod";

import { handleCorsOptions } from "@/shared/utils/cors";
import { applyIosActionResults, claimIosActions, listIosActions } from "@/lib/db/iosBridge";
import { toIosActionView } from "@/lib/iosBridge/actionView";
import { IOS_ACTION_TYPES, iosActionResultSchema } from "@/lib/iosBridge/schemas";

import { iosBridgeError, jsonResponse, requireIosBridgeApiKey } from "../_lib";

export const OPTIONS = async (): Promise<Response> => handleCorsOptions();

const actionsQuerySchema = z.object({
  /** Comma-separated action types, e.g. `reminders.create,calendar.create_event`. */
  type: z
    .string()
    .max(500)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : []
    )
    .pipe(z.array(z.enum(IOS_ACTION_TYPES)).max(IOS_ACTION_TYPES.length)),
  /** `ack=true`: mark the returned actions as done right away (no results POST needed). */
  ack: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

/**
 * iPhone pulls the actions Claude queued (create event, create/update reminder, …).
 * Each action carries flat fields (title, list, start, end, due, …) for Shortcuts.
 */
export async function GET(request: Request): Promise<Response> {
  const authError = await requireIosBridgeApiKey(request);
  if (authError) return authError;

  const params = new URL(request.url).searchParams;
  const query = actionsQuerySchema.safeParse({
    type: params.get("type") ?? undefined,
    ack: params.get("ack") ?? undefined,
  });
  if (!query.success) return iosBridgeError(400, "Invalid type or ack query parameter");

  try {
    const { type, ack } = query.data;
    const actions = ack
      ? claimIosActions(type)
      : listIosActions("pending").filter((a) => type.length === 0 || type.includes(a.type));
    return jsonResponse(200, { count: actions.length, actions: actions.map(toIosActionView) });
  } catch {
    return iosBridgeError(500, "Failed to read iOS actions");
  }
}

/** iPhone reports which actions it executed. */
export async function POST(request: Request): Promise<Response> {
  const authError = await requireIosBridgeApiKey(request);
  if (authError) return authError;

  const parsed = iosActionResultSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return iosBridgeError(400, "Invalid action results payload");
  }

  try {
    return jsonResponse(200, { ok: true, ...applyIosActionResults(parsed.data) });
  } catch {
    return iosBridgeError(500, "Failed to store iOS action results");
  }
}
