/**
 * @kerf/engine — the deterministic playbook runner (Tier 1).
 *
 * The core exported here depends only on @kerf/core (types) — it never
 * imports a vendor SDK. The one concrete cloud adapter (BrowserUseHost)
 * lives in `./browser-use-host.ts` and is deliberately NOT re-exported:
 * the runtime layer deep-imports it, so consumers of the engine's
 * deterministic core never pull in `browser-use-sdk`.
 */

export type { BrowserHost, BrowserSession } from "./browser-host.ts";
export type { EvidenceCapture, EvidenceSink } from "./evidence-sink.ts";
export { MemoryEvidenceSink } from "./evidence-sink.ts";
export { parseMoney, parseInt10 } from "./money.ts";
export { pointer, resolveValueRef, resolveString } from "./value.ts";
export { compare } from "./assert.ts";
export type { AssertOp, CompareResult } from "./assert.ts";
export { runPlaybook } from "./runner.ts";
export type {
  RunOptions,
  RunOutcome,
  RunResult,
  StepTrace,
} from "./runner.ts";
export { quoteFromRun } from "./quote-from-run.ts";
export type { QuoteFromRunArgs } from "./quote-from-run.ts";
export { canonicalJson, sha256Hex, sha256HexBytes, intentHash } from "./hash.ts";
export { runQuoteJob } from "./quote-job.ts";
export type { RunQuoteJobArgs, QuoteJobResult } from "./quote-job.ts";
export { ScriptedHost, ScriptedSession } from "./scripted-session.ts";
export { MemoryJobStore } from "./job-store.ts";
export type { JobRecord, JobRecordPatch, JobStore } from "./job-store.ts";
export { handleQuoteRequest, HostUnavailableError } from "./quote-api.ts";
export type {
  QuoteApiDeps,
  QuoteApiResult,
  QuoteApiVendor,
  QuoteResponseBody,
} from "./quote-api.ts";
