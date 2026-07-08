/**
 * JobStore — durable-ish records for kerf jobs, queryable over HTTP.
 *
 * The store is the seam between "a job ran" and "a client can ask what
 * happened": POST /api/quote creates a record, drives it through the
 * @kerf/core state machine, and GET /api/jobs/:id reads it back. Every
 * state change goes through `assertTransition` — an illegal move is a bug
 * and throws; callers do not get to improvise.
 */

import type { EvidenceBundle, JobKind, JobState, VendorQuote } from "@kerf/core";
import { assertTransition } from "@kerf/core";

/** One job's queryable record. Mirrors the state machine in @kerf/core;
 *  `quote`/`evidence` are attached as the run produces them. */
export interface JobRecord {
  job_id: string;
  kind: JobKind;
  /** Registry vendor id, e.g. `"sendcutsend"`. */
  vendor: string;
  state: JobState;
  /** The ACP-CM binding hash of the intent this job executes. */
  intent_hash: string;
  /** ISO-8601 timestamps, maintained by the store. */
  created_at: string;
  updated_at: string;
  /** The extracted quote, or null until (unless) the run delivers one. */
  quote: VendorQuote | null;
  /** Shareable watch URL for the browser session, when the host has one. */
  live_url: string | null;
  /** Human-readable failure reason, set when the job FAILED. */
  error?: string;
  /** Hash-manifested evidence bundle; served by its own route. */
  evidence: EvidenceBundle | null;
}

/** Fields a caller may patch after creation. `job_id`/`kind`/`vendor`/
 *  timestamps are immutable; `updated_at` is the store's job. */
export type JobRecordPatch = Partial<
  Pick<JobRecord, "state" | "quote" | "live_url" | "error" | "evidence" | "intent_hash">
>;

/**
 * The store contract. Implementations must:
 *   - reject `create` for an id that already exists (ids are never reused);
 *   - reject `update` for an unknown id;
 *   - guard every state change with `assertTransition` (same-state patches
 *     that only attach data are allowed and do not consult the table).
 */
export interface JobStore {
  create(rec: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  update(id: string, patch: JobRecordPatch): Promise<void>;
}

/** Module-global backing map — every MemoryJobStore constructed without an
 *  explicit map shares it, so route handlers instantiated per-request still
 *  see one job table within a warm runtime. */
const SHARED_RECORDS = new Map<string, JobRecord>();

/**
 * MemoryJobStore — the Wave-0 store: a module-global Map.
 *
 * SERVERLESS CAVEAT: memory is per-instance. A GET routed to a different
 * (or cold-started) instance than the POST that created the job returns
 * 404. That is acceptable for Wave 0 because quote jobs are deterministic
 * and re-runnable — re-POST the same intent and the intent_hash (the value
 * anything downstream binds to) is identical. It is NOT acceptable for
 * order jobs, whose one-shot PLACING invariant needs durable storage.
 *
 * The seam for that upgrade is the `JobStore` interface: a KV/Postgres
 * implementation (Vercel KV, Supabase, the eve run store) drops in behind
 * `create`/`get`/`update` without touching the API layer. Keep the
 * `assertTransition` guard in any durable implementation — ideally as a
 * compare-and-swap on `state` so concurrent writers cannot race past it.
 */
export class MemoryJobStore implements JobStore {
  private readonly records: Map<string, JobRecord>;

  constructor(records: Map<string, JobRecord> = SHARED_RECORDS) {
    this.records = records;
  }

  async create(rec: JobRecord): Promise<void> {
    if (this.records.has(rec.job_id)) {
      throw new Error(`kerf: job "${rec.job_id}" already exists — job ids are never reused`);
    }
    this.records.set(rec.job_id, structuredClone(rec));
  }

  async get(id: string): Promise<JobRecord | null> {
    const rec = this.records.get(id);
    return rec ? structuredClone(rec) : null;
  }

  async update(id: string, patch: JobRecordPatch): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error(`kerf: cannot update unknown job "${id}"`);
    }
    if (patch.state !== undefined && patch.state !== rec.state) {
      assertTransition(rec.state, patch.state);
    }
    const next: JobRecord = {
      ...rec,
      ...clean(patch),
      updated_at: new Date().toISOString(),
    };
    this.records.set(id, structuredClone(next));
  }
}

/** Drop `undefined` entries so a sparse patch never blanks a field. */
function clean(patch: JobRecordPatch): JobRecordPatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out as JobRecordPatch;
}
