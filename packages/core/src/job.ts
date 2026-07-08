/**
 * The kerf job state machine.
 *
 * One durable workflow run = one job = one pass through this machine. The
 * two invariants everything else exists to protect:
 *
 * 1. `PLACING` is entered AT MOST ONCE per job. The placing attempt is
 *    durably recorded BEFORE the click executes; any resume that finds an
 *    attempt on record goes to `RECONCILING`, never back to `PLACING`.
 *    The buy click is never blindly retried.
 * 2. `CONFIRMED` requires two independent oracles (see evidence.ts). One
 *    oracle is a hint; two is a fact; zero after timeout is `RECONCILING`.
 */

export type JobKind = "quote" | "order" | "track" | "canary" | "bringup";

export type JobState =
  | "QUEUED"
  | "SESSION_OPEN" // browser session attached (BrowserHost id recorded)
  | "STAGING" // uploads, configuration, cart assembly — assertion-gated
  | "TAKEOVER_WAIT" // suspended on a hook: human is in the live view
  | "STAGED" // cart complete, every assertion green. L1 jobs stop here
  | "AUDIT" // auditor compares review page against the intent
  | "AUDIT_FAILED" // mismatch → terminal; never proceeds to money
  | "PLACING" // the click step. Entered at most once, ever
  | "CONFIRMING" // awaiting two independent confirmation oracles
  | "CONFIRMED" // vendor order exists; ref + evidence recorded
  | "RECONCILING" // click outcome ambiguous: scan order history + inbox
  | "RECONCILED_PLACED" // order found by idempotency key → CONFIRMED path
  | "RECONCILED_ABSENT" // provably not placed; safe to re-attempt as a NEW job
  | "TRACKING" // sleeping through lead time, polling tracking
  | "DELIVERED"
  | "FAILED"
  | "CANCELED";

/** Legal transitions. Anything not listed is a bug, not a retry. */
export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  QUEUED: ["SESSION_OPEN", "CANCELED", "FAILED"],
  SESSION_OPEN: ["STAGING", "TAKEOVER_WAIT", "CANCELED", "FAILED"],
  STAGING: ["STAGED", "TAKEOVER_WAIT", "CANCELED", "FAILED"],
  TAKEOVER_WAIT: ["SESSION_OPEN", "STAGING", "STAGED", "CONFIRMING", "CANCELED", "FAILED"],
  // L1: human clicked buy in the live view → straight to CONFIRMING.
  // L2: the auditor gate sits between the cart and the click.
  // Quote-kind jobs terminate STAGED → DELIVERED: the priced,
  // evidence-backed quote IS the deliverable — there is no money path, so
  // none of the money invariants (one-shot PLACING, two-oracle CONFIRMED)
  // are in play. Orders continue via AUDIT.
  STAGED: ["AUDIT", "TAKEOVER_WAIT", "CONFIRMING", "DELIVERED", "CANCELED", "FAILED"],
  AUDIT: ["PLACING", "AUDIT_FAILED"],
  AUDIT_FAILED: [],
  PLACING: ["CONFIRMING", "RECONCILING"],
  CONFIRMING: ["CONFIRMED", "RECONCILING"],
  CONFIRMED: ["TRACKING"],
  RECONCILING: ["RECONCILED_PLACED", "RECONCILED_ABSENT"],
  RECONCILED_PLACED: ["TRACKING"],
  RECONCILED_ABSENT: ["FAILED"],
  TRACKING: ["DELIVERED", "FAILED"],
  DELIVERED: [],
  FAILED: [],
  CANCELED: [],
};

/** States from which a job can never move again. */
export function isTerminal(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Throw on an illegal transition. Callers do not get to improvise. */
export function assertTransition(from: JobState, to: JobState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`kerf: illegal job transition ${from} -> ${to}`);
  }
}

/**
 * Kind-aware transition guard — what stores must call. The shared table
 * lists STAGED → DELIVERED, but that edge exists ONLY for quote-kind jobs
 * (the priced, evidence-backed quote is the deliverable). For every other
 * kind — orders above all — DELIVERED stays reachable only via TRACKING,
 * preserving "DELIVERED implies the order was confirmed by two oracles".
 */
export function assertTransitionForKind(
  kind: JobKind,
  from: JobState,
  to: JobState,
): void {
  assertTransition(from, to);
  if (from === "STAGED" && to === "DELIVERED" && kind !== "quote") {
    throw new Error(
      `kerf: illegal job transition STAGED -> DELIVERED for kind "${kind}" — ` +
        "only quote jobs terminate at STAGED; orders require the two-oracle CONFIRMED path",
    );
  }
}

/** The durable record written BEFORE the buy click executes. Its presence
 *  on any resumed run forbids re-entering PLACING. */
export interface PlacingAttempt {
  job_id: string;
  idempotency_key: string;
  /** Evidence item id of the full review-page snapshot taken pre-click. */
  review_evidence: string;
  attempted_at: string;
}

/** Guard for the one-shot click invariant. */
export function mayEnterPlacing(prior: PlacingAttempt | null): boolean {
  return prior === null;
}
