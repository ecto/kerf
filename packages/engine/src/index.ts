/**
 * @kerf/engine — the deterministic playbook runner (Tier 1).
 *
 * Depends only on @kerf/core (types). The concrete BrowserHost adapters
 * (Browser Use cloud, etc.) live in the runtime layer and implement the
 * interface here; the engine never imports a vendor SDK.
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
export { canonicalJson, sha256Hex, intentHash } from "./hash.ts";
export { runQuoteJob } from "./quote-job.ts";
export type { RunQuoteJobArgs, QuoteJobResult } from "./quote-job.ts";
