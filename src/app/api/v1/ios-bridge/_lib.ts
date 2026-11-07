import { CORS_HEADERS } from "@/shared/utils/cors";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Error bodies go through buildErrorBody() (sanitized, bounded public codes). */
export function iosBridgeError(status: number, message: string): Response {
  return jsonResponse(status, buildErrorBody(status, message));
}

/** Every iOS Bridge endpoint requires a valid OmniRoute API key (Bearer header). */
export async function requireIosBridgeApiKey(request: Request): Promise<Response | null> {
  const apiKey = extractApiKey(request);
  if (!apiKey) return iosBridgeError(401, "Authentication required");
  if (!(await isValidApiKey(apiKey))) {
    return iosBridgeError(401, "Invalid API key");
  }
  return null;
}
