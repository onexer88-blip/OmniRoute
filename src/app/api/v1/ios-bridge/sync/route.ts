import { handleCorsOptions } from "@/shared/utils/cors";
import { clearIosBridgeData, getIosBridgeStatus, saveIosSnapshot } from "@/lib/db/iosBridge";
import { iosBridgeSyncSchema } from "@/lib/iosBridge/schemas";

import { iosBridgeError, jsonResponse, requireIosBridgeApiKey } from "../_lib";

export const OPTIONS = async (): Promise<Response> => handleCorsOptions();

/** iPhone (Apple Shortcuts) pushes calendar / reminders / location / health snapshots. */
export async function POST(request: Request): Promise<Response> {
  const authError = await requireIosBridgeApiKey(request);
  if (authError) return authError;

  const parsed = iosBridgeSyncSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    return iosBridgeError(
      400,
      `Invalid sync payload${where}: ${issue?.message ?? "validation failed"}`
    );
  }

  try {
    const summary = saveIosSnapshot(parsed.data);
    const { actions } = getIosBridgeStatus();
    return jsonResponse(200, { ok: true, ...summary, pendingActions: actions.pending });
  } catch {
    return iosBridgeError(500, "Failed to store iOS snapshot");
  }
}

/** Connection status (what was synced when, how many actions are waiting). */
export async function GET(request: Request): Promise<Response> {
  const authError = await requireIosBridgeApiKey(request);
  if (authError) return authError;
  try {
    return jsonResponse(200, getIosBridgeStatus());
  } catch {
    return iosBridgeError(500, "Failed to read iOS bridge status");
  }
}

/** Wipe every synced snapshot and queued action (e.g. before handing over the phone). */
export async function DELETE(request: Request): Promise<Response> {
  const authError = await requireIosBridgeApiKey(request);
  if (authError) return authError;
  try {
    clearIosBridgeData();
    return jsonResponse(200, { ok: true, cleared: true });
  } catch {
    return iosBridgeError(500, "Failed to clear iOS bridge data");
  }
}
