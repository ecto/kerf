/**
 * The quote API core — everything POST /api/quote does, minus HTTP.
 *
 * Pure with respect to the runtime: the registry, the browser host, and
 * the job store are INJECTED, so the whole request path is testable with
 * the scripted host and no Next.js. The route file is a thin adapter:
 * auth + JSON parsing + `Response.json(result.body, { status })`.
 *
 * Contract (as served by app/api/quote/route.ts):
 *
 *   POST { vendor, intent? | intentKey?, mode?: "scripted" | "live" }
 *     → 200 { job_id, state, quote, intent_hash, live_url,
 *             evidence: { items: <count>, claims: OracleClaim[] } }
 *     → 400 validation (including upload-hash mismatch at the API door)
 *     → 404 unknown vendor
 *     → 503 live mode unavailable (no Browser Use API key)
 *     → 500 the run threw (job recorded FAILED; body carries job_id)
 *
 * Posted intents may inline file bytes as `bytes_base64` per file — a
 * WIRE-ONLY extension of FileRef (the core type is untouched). Bytes are
 * stripped before the intent is hashed, stored, or logged, and their
 * sha256 must match the FileRef's declared hash or the request is
 * rejected: that is the upload-hash discipline enforced at the door.
 */

import type {
  ConfiguratorIntent,
  EvidenceBundle,
  EvidenceItem,
  FileRef,
  JobState,
  Money,
  OracleClaim,
  Playbook,
  ShipTo,
  VendorQuote,
} from "@kerf/core";
import type { BrowserHost } from "./browser-host.ts";
import type { JobRecord, JobStore } from "./job-store.ts";
import { MemoryEvidenceSink } from "./evidence-sink.ts";
import { intentHash, sha256HexBytes } from "./hash.ts";
import { runQuoteJob } from "./quote-job.ts";

/** What the API needs from a vendor registry entry (structural — the
 *  @kerf/registry VendorEntry satisfies it; the engine stays registry-free). */
export interface QuoteApiVendor {
  playbooks: Record<string, Playbook>;
  intents: Record<string, ConfiguratorIntent>;
}

/** Thrown by `hostFor("live")` when no live browser can be provisioned
 *  (no Browser Use API key). Mapped to 503. */
export class HostUnavailableError extends Error {}

export interface QuoteApiDeps {
  /** Resolve a vendor id; throw on unknown (mapped to 404). */
  getVendor(id: string): QuoteApiVendor;
  /** Resolve embedded fixture bytes for registry intents; throws on unknown. */
  getFixtureBytes(vendor: string, name: string): Uint8Array;
  /** Bind a mode to a concrete host. Throw HostUnavailableError → 503. */
  hostFor(mode: "scripted" | "live"): BrowserHost;
  store: JobStore;
  /** Injectable for tests; defaults to crypto.randomUUID / Date. */
  newJobId?: () => string;
  now?: () => string;
}

export interface QuoteResponseBody {
  job_id: string;
  state: JobState;
  quote: VendorQuote | null;
  intent_hash: string;
  live_url: string | null;
  evidence: { items: number; claims: OracleClaim[] };
}

export type QuoteApiResult =
  | { status: 200; body: QuoteResponseBody }
  | { status: 400 | 404 | 503; body: { error: string } }
  | { status: 500; body: { error: string; job_id?: string } };

/** Handle a parsed POST /api/quote body end to end: validate, run the
 *  quote job, persist the JobRecord + EvidenceBundle, shape the response. */
export async function handleQuoteRequest(
  body: unknown,
  deps: QuoteApiDeps,
): Promise<QuoteApiResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newJobId = deps.newJobId ?? (() => crypto.randomUUID());

  if (!isRecord(body)) return bad("request body must be a JSON object");
  if (typeof body.vendor !== "string" || body.vendor.length === 0) {
    return bad('"vendor" is required');
  }
  const vendorId = body.vendor;
  const mode = body.mode ?? "scripted";
  if (mode !== "scripted" && mode !== "live") {
    return bad('"mode" must be "scripted" or "live"');
  }

  let vendor: QuoteApiVendor;
  try {
    vendor = deps.getVendor(vendorId);
  } catch (err) {
    return { status: 404, body: { error: message(err) } };
  }
  const playbook = vendor.playbooks["quote"];
  if (!playbook) return bad(`vendor "${vendorId}" has no quote playbook`);

  // ---- intent + file-byte resolution -------------------------------
  const job_id = newJobId();
  let intent: ConfiguratorIntent;
  let bytesFor: (index: number, file: FileRef) => Uint8Array;

  if (body.intent !== undefined) {
    const validated = await validatePostedIntent(body.intent, vendorId, job_id);
    if ("error" in validated) return bad(validated.error);
    intent = validated.intent;
    const posted = validated.bytesByIndex;
    bytesFor = (index) => {
      const bytes = posted.get(index);
      if (!bytes) throw new Error(`kerf: no bytes for /files/${index}`);
      return bytes;
    };
  } else {
    const key = typeof body.intentKey === "string" ? body.intentKey : "canary";
    const registryIntent = vendor.intents[key];
    if (!registryIntent) {
      return bad(`vendor "${vendorId}" has no intent "${key}"`);
    }
    intent = registryIntent;
    bytesFor = (_index, file) => deps.getFixtureBytes(vendorId, file.name);
  }

  let host: BrowserHost;
  try {
    host = deps.hostFor(mode);
  } catch (err) {
    if (err instanceof HostUnavailableError) {
      return { status: 503, body: { error: message(err) } };
    }
    throw err;
  }

  // ---- job record ---------------------------------------------------
  const hash = await intentHash(intent);
  const created = now();
  const record: JobRecord = {
    job_id,
    kind: "quote",
    vendor: intent.vendor,
    state: "QUEUED",
    intent_hash: hash,
    created_at: created,
    updated_at: created,
    quote: null,
    live_url: null,
    evidence: null,
  };
  await deps.store.create(record);

  // Bookkeeping milestones around the (synchronous, from our vantage) run;
  // runQuoteJob owns the session lifecycle in between.
  await deps.store.update(job_id, { state: "SESSION_OPEN" });
  await deps.store.update(job_id, { state: "STAGING" });

  const sink = new MemoryEvidenceSink();
  const resolvedBytes = new Map<number, Uint8Array>();
  const resolveFile = (pointer: string) => {
    const idx = Number.parseInt(pointer.replace(/^\/files\//, ""), 10);
    const file = intent.files[idx];
    if (!file) throw new Error(`kerf: no file at "${pointer}"`);
    const bytes = bytesFor(idx, file);
    resolvedBytes.set(idx, bytes);
    return {
      fileName: file.name,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      ...(file.media_type ? { mediaType: file.media_type } : {}),
    };
  };

  try {
    const result = await runQuoteJob({
      host,
      intent,
      playbook,
      quoteId: job_id,
      resolveFile,
      evidence: sink,
    });

    // Hash every file the playbook actually fed the vendor (plus any it
    // never reached, from the same resolver) for the upload-hash oracle.
    for (const [idx, file] of intent.files.entries()) {
      if (!resolvedBytes.has(idx)) resolvedBytes.set(idx, bytesFor(idx, file));
    }
    const bundle = await buildEvidenceBundle({
      jobId: job_id,
      createdAt: now(),
      intent,
      resolvedBytes,
      sink,
      run: result.run,
      quote: result.quote,
    });
    const quote = result.quote
      ? { ...result.quote, evidence: bundle.items.map((i) => i.id) }
      : null;

    const succeeded = result.run.outcome === "completed" && quote !== null;
    if (succeeded) {
      await deps.store.update(job_id, { state: "STAGED" });
      await deps.store.update(job_id, {
        state: "DELIVERED",
        quote,
        live_url: result.live_url,
        evidence: bundle,
      });
    } else {
      const reason =
        `run ${result.run.outcome}` +
        (result.run.stoppedAt ? ` at ${result.run.stoppedAt}` : "") +
        (result.run.reason ? `: ${result.run.reason}` : "");
      await deps.store.update(job_id, {
        state: "FAILED",
        error: reason,
        live_url: result.live_url,
        evidence: bundle,
      });
    }

    return {
      status: 200,
      body: {
        job_id,
        state: succeeded ? "DELIVERED" : "FAILED",
        quote,
        intent_hash: result.intent_hash,
        live_url: result.live_url,
        evidence: { items: bundle.items.length, claims: bundle.claims },
      },
    };
  } catch (err) {
    // Infra failure (host/SDK/network) or a completed run with no price —
    // record it, then answer 500 with a safe message. Our own error strings
    // carry no secrets; stacks stay server-side.
    await deps.store.update(job_id, { state: "FAILED", error: message(err) });
    return {
      status: 500,
      body: { error: `quote job failed: ${message(err)}`, job_id },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Posted-intent validation                                            */
/* ------------------------------------------------------------------ */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Placeholder for quote-only intents that omit ship_to — a quote job
 *  never ships anything, and the field is excluded from intent_hash. */
const QUOTE_ONLY_SHIP_TO: ShipTo = {
  name: "quote only — not used",
  line1: "n/a",
  city: "n/a",
  region: "n/a",
  postal_code: "n/a",
  country: "US",
};

/**
 * Structurally validate a POSTed configurator intent and split it into a
 * CLEAN ConfiguratorIntent (bytes stripped, fields whitelisted) plus the
 * decoded per-file bytes. Enforces the upload-hash discipline at the API
 * door: sha256(bytes_base64) must equal the FileRef's declared sha256.
 */
async function validatePostedIntent(
  raw: unknown,
  vendor: string,
  jobId: string,
): Promise<
  | { intent: ConfiguratorIntent; bytesByIndex: Map<number, Uint8Array> }
  | { error: string }
> {
  if (!isRecord(raw)) return { error: '"intent" must be an object' };
  if (raw.kind !== "configurator") {
    return { error: 'intent.kind must be "configurator" (catalog/rfq land in later waves)' };
  }
  if (raw.vendor !== undefined && raw.vendor !== vendor) {
    return { error: `intent.vendor "${String(raw.vendor)}" does not match request vendor "${vendor}"` };
  }
  if (typeof raw.process !== "string" || raw.process.length === 0) {
    return { error: "intent.process is required (it participates in intent_hash)" };
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    return { error: "intent.files must be a non-empty array" };
  }
  if (!isRecord(raw.config)) return { error: "intent.config must be an object" };
  for (const [k, v] of Object.entries(raw.config)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return { error: `intent.config["${k}"] must be a string, number, or boolean` };
    }
  }
  if (
    typeof raw.quantity !== "number" ||
    !Number.isInteger(raw.quantity) ||
    raw.quantity < 1
  ) {
    return { error: "intent.quantity must be an integer >= 1" };
  }
  const budget = raw.budget_cap;
  if (
    !isRecord(budget) ||
    typeof budget.currency !== "string" ||
    typeof budget.amount_minor !== "number" ||
    !Number.isInteger(budget.amount_minor)
  ) {
    return { error: "intent.budget_cap must be Money ({ currency, amount_minor })" };
  }
  if (raw.idempotency_key !== undefined && typeof raw.idempotency_key !== "string") {
    return { error: "intent.idempotency_key must be a string when present" };
  }

  const files: FileRef[] = [];
  const bytesByIndex = new Map<number, Uint8Array>();
  for (const [i, f] of raw.files.entries()) {
    if (!isRecord(f)) return { error: `intent.files[${i}] must be an object` };
    if (typeof f.name !== "string" || f.name.length === 0) {
      return { error: `intent.files[${i}].name is required` };
    }
    if (typeof f.bytes !== "number" || !Number.isInteger(f.bytes) || f.bytes < 1) {
      return { error: `intent.files[${i}].bytes must be a positive integer` };
    }
    if (typeof f.sha256 !== "string" || !SHA256_HEX.test(f.sha256)) {
      return { error: `intent.files[${i}].sha256 must be 64 lowercase hex chars` };
    }
    if (typeof f.bytes_base64 !== "string" || f.bytes_base64.length === 0) {
      return {
        error:
          `intent.files[${i}].bytes_base64 is required for posted intents — ` +
          "the API uploads exactly the bytes you send, hash-checked",
      };
    }
    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(Buffer.from(f.bytes_base64, "base64"));
    } catch {
      return { error: `intent.files[${i}].bytes_base64 is not valid base64` };
    }
    if (decoded.length !== f.bytes) {
      return {
        error: `intent.files[${i}]: decoded ${decoded.length} bytes but FileRef declares ${f.bytes}`,
      };
    }
    const actual = await sha256HexBytes(decoded);
    if (actual !== f.sha256) {
      return {
        error:
          `intent.files[${i}] sha256 mismatch: declared ${f.sha256} but bytes hash to ${actual} — ` +
          "refusing to quote bytes that do not match their FileRef",
      };
    }
    bytesByIndex.set(i, decoded);
    // The clean FileRef: bytes_base64 stripped, fields whitelisted.
    files.push({
      name: f.name,
      bytes: f.bytes,
      sha256: f.sha256,
      ...(typeof f.media_type === "string" ? { media_type: f.media_type } : {}),
    });
  }

  const intent: ConfiguratorIntent = {
    kind: "configurator",
    idempotency_key:
      typeof raw.idempotency_key === "string" ? raw.idempotency_key : `quote-${jobId}`,
    vendor,
    process: raw.process,
    files,
    config: raw.config as Record<string, string | number | boolean>,
    quantity: raw.quantity,
    ship_to: isShipTo(raw.ship_to) ? raw.ship_to : QUOTE_ONLY_SHIP_TO,
    budget_cap: { currency: budget.currency, amount_minor: budget.amount_minor } as Money,
    ...(typeof raw.deadline === "string" ? { deadline: raw.deadline } : {}),
  };
  return { intent, bytesByIndex };
}

/* ------------------------------------------------------------------ */
/* Evidence bundle                                                     */
/* ------------------------------------------------------------------ */

interface BundleArgs {
  jobId: string;
  createdAt: string;
  intent: ConfiguratorIntent;
  resolvedBytes: Map<number, Uint8Array>;
  sink: MemoryEvidenceSink;
  run: { outcome: string; stoppedAt?: string; reason?: string };
  quote: VendorQuote | null;
}

/**
 * Fold run captures + file hashes into a hash-manifested EvidenceBundle.
 *
 * Wave-0 scope: items are MANIFEST-ONLY (id, sha256, size) — the artifact
 * store that would persist the screenshot payloads does not exist yet, so
 * the bytes are hashed and dropped. Claims:
 *   - kerf/upload-hash: the exact bytes fed to the vendor's file input
 *     hash to each FileRef.sha256 (posted intents were already checked at
 *     the door; registry fixtures are re-verified here — fail-closed).
 *   - kerf/quote-extraction: a priced quote was extracted and snapshotted.
 */
async function buildEvidenceBundle(args: BundleArgs): Promise<EvidenceBundle> {
  const items: EvidenceItem[] = [];
  const uploadIds: string[] = [];
  let uploadsOk = true;
  const observedHashes: string[] = [];

  for (const [idx, file] of args.intent.files.entries()) {
    const bytes = args.resolvedBytes.get(idx);
    if (!bytes) {
      uploadsOk = false;
      continue;
    }
    const actual = await sha256HexBytes(bytes);
    if (actual !== file.sha256) uploadsOk = false;
    const id = `upload:/files/${idx}`;
    uploadIds.push(id);
    observedHashes.push(`${file.name}=${actual}`);
    items.push({
      id,
      kind: "upload_hash",
      sha256: actual,
      bytes: bytes.length,
      captured_at: args.createdAt,
      step_ref: `/files/${idx}`,
    });
  }

  const shotIds: string[] = [];
  for (const [i, capture] of args.sink.items.entries()) {
    const bytes = Uint8Array.from(Buffer.from(capture.bytesBase64, "base64"));
    const id = `${capture.kind}:${capture.name}#${i}`;
    shotIds.push(id);
    items.push({
      id,
      kind: capture.kind,
      sha256: await sha256HexBytes(bytes),
      bytes: bytes.length,
      captured_at: args.createdAt,
      ...(capture.stepRef ? { step_ref: capture.stepRef } : {}),
    });
  }

  const claims: OracleClaim[] = [
    {
      oracle: "kerf/upload-hash",
      verdict: uploadsOk ? "pass" : "fail",
      observed: observedHashes.join(", "),
      ...(uploadsOk ? {} : { reason: "resolved bytes do not hash to the intent's FileRef sha256" }),
      evidence: uploadIds,
    },
    args.quote
      ? {
          oracle: "kerf/quote-extraction",
          verdict: "pass",
          observed:
            `unit ${formatMoney(args.quote.unit_price)} / total ${formatMoney(args.quote.total)}`,
          evidence: shotIds,
        }
      : {
          oracle: "kerf/quote-extraction",
          verdict: "fail",
          reason:
            `run ${args.run.outcome}` +
            (args.run.stoppedAt ? ` at ${args.run.stoppedAt}` : "") +
            (args.run.reason ? `: ${args.run.reason}` : ""),
          evidence: shotIds,
        },
  ];

  return { job_id: args.jobId, created_at: args.createdAt, items, claims };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isShipTo(v: unknown): v is ShipTo {
  return (
    isRecord(v) &&
    typeof v.name === "string" &&
    typeof v.line1 === "string" &&
    typeof v.city === "string" &&
    typeof v.region === "string" &&
    typeof v.postal_code === "string" &&
    typeof v.country === "string"
  );
}

function formatMoney(m: Money): string {
  return `${m.currency} ${(m.amount_minor / 100).toFixed(2)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bad(error: string): { status: 400; body: { error: string } } {
  return { status: 400, body: { error } };
}
