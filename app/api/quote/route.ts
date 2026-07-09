/**
 * POST /api/quote — run a quote job and answer with the priced result.
 *
 * Body: {
 *   vendor: string;                       // registry id, e.g. "sendcutsend"
 *   mode?: "scripted" | "live";           // default "scripted"
 *   intentKey?: string;                   // registry fixture intent (default "canary")
 *   intent?: ConfiguratorIntent & {       // OR a full posted intent, where each
 *     files: (FileRef & { bytes_base64: string })[];  // file carries its bytes inline
 *   };
 * }
 *
 * 200 → { job_id, state: "DELIVERED" | "FAILED", quote, intent_hash,
 *         live_url, evidence: { items: number, claims: OracleClaim[] } }
 * 400 validation (incl. sha256-vs-bytes mismatch) · 401 bad token ·
 * 404 unknown vendor · 503 live mode without a key · 500 run threw.
 *
 * The logic lives in @kerf/engine (`handleQuoteRequest`), tested against
 * the scripted host; this file is transport only.
 */

import { handleQuoteRequest } from "@kerf/engine";
import { checkAuth, quoteApiDeps } from "@/lib/kerf-api";

// Live jobs drive a real browser through a vendor configurator — minutes,
// not milliseconds. (Plan limits may clamp this lower at deploy time.)
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const result = await handleQuoteRequest(body, quoteApiDeps());
  return Response.json(result.body, { status: result.status });
}
