import { handleCorsOptions } from "@/shared/utils/cors";
import { applyIosActionResults, listIosActions } from "@/lib/db/iosBridge";
import { iosActionResultSchema } from "@/lib/iosBridge/schemas";

import { iosBridgeError, jsonResponse, requireIosBridgeApiKey } from "../_lib";

export const OPTIONS = async (): Promise<Response> => handleCorsOptions();

/** iPhone pulls the actions Claude queued (create event, create/update reminder, …). */
export async function GET(request: Request): Promise<Response> {
  const authError = await requireIosBridgeApiKey(request);
  if (authError) return authError;
  try {
    const actions = listIosActions("pending");
    return jsonResponse(200, { count: actions.length, actions });
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
