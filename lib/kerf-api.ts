/**
 * Server-side bindings for the kerf HTTP API routes.
 *
 * The route files under app/api/ stay thin adapters; everything they
 * share — the job store singleton, bearer-token auth, and the mode →
 * BrowserHost binding — lives here. The request logic itself is
 * `handleQuoteRequest` in @kerf/engine, fully tested against the
 * scripted host.
 */

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
 * set the API is open (dev mode) and we say so once in the logs rather
 * than failing silently open.
 */
export function checkAuth(req: Request): Response | null {
  const token = process.env.KERF_API_TOKEN;
  if (!token) {
    if (!warnedOpenApi) {
      warnedOpenApi = true;
      console.warn(
        "kerf: KERF_API_TOKEN is not set — the HTTP API is OPEN (dev mode). Set it in production.",
      );
    }
    return null;
  }
  if (req.headers.get("authorization") === `Bearer ${token}`) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
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
