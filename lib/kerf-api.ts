/**
 * Server-side bindings for the kerf HTTP API routes.
 *
 * The route files under app/api/ stay thin adapters; everything they
 * share — the job store singleton, bearer-token auth, and the mode →
 * BrowserHost binding — lives here. The request logic itself is
 * `handleQuoteRequest` in @kerf/engine, fully tested against the
 * scripted host.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { BrowserHost, QuoteApiDeps } from "@kerf/engine";
import { HostUnavailableError, MemoryJobStore, ScriptedHost } from "@kerf/engine";
import { BrowserUseHost } from "@kerf/engine/src/browser-use-host.ts";
import { getFixtureBytes, getVendor } from "@kerf/registry";

/** One job table per warm runtime (module-global inside MemoryJobStore).
 *  See the serverless caveat on MemoryJobStore — Wave 0 accepts it because
 *  quote jobs are deterministic and re-runnable. */
export const jobStore = new MemoryJobStore();

let warnedOpenApi = false;

/**
 * Bearer-token gate. When KERF_API_TOKEN is set, every request must carry
 * `Authorization: Bearer <token>` — anything else is 401. When it is NOT
 * set, the posture depends on where we are running:
 *
 *  - Deployed (`VERCEL` set, or NODE_ENV === "production"): FAIL CLOSED
 *    with 503. A production deploy that forgot the token must not expose
 *    an API that can spend Browser Use money.
 *  - Local dev: open, announced once in the logs rather than failing
 *    silently open.
 */
export function checkAuth(req: Request): Response | null {
  const token = process.env.KERF_API_TOKEN;
  if (!token) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      return Response.json(
        { error: "KERF_API_TOKEN not configured" },
        { status: 503 },
      );
    }
    if (!warnedOpenApi) {
      warnedOpenApi = true;
      console.warn(
        "kerf: KERF_API_TOKEN is not set — the HTTP API is OPEN (local dev only; deployed environments fail closed).",
      );
    }
    return null;
  }
  const header = req.headers.get("authorization") ?? "";
  if (bearerMatches(header, token)) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** Constant-time bearer comparison. Both sides are hashed first so the
 *  comparison runs over equal-length buffers — neither the token's content
 *  nor its length leaks through timing. */
function bearerMatches(header: string, token: string): boolean {
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(a, b);
}

/** Bind a requested mode to a concrete BrowserHost. Live mode needs the
 *  Browser Use API key; without it the caller gets an honest 503, not a
 *  silently-scripted run. */
export function hostFor(mode: "scripted" | "live"): BrowserHost {
  if (mode === "scripted") return new ScriptedHost();
  if (!BrowserUseHost.available()) {
    throw new HostUnavailableError(
      "live mode unavailable: BROWSER_USE_API_KEY is not set on this deployment. " +
        'Use mode "scripted" for the deterministic fixture flow.',
    );
  }
  return new BrowserUseHost();
}

/** The dependency bundle handleQuoteRequest runs against in production. */
export function quoteApiDeps(): QuoteApiDeps {
  return { getVendor, getFixtureBytes, hostFor, store: jobStore };
}
