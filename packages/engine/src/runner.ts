/**
 * The deterministic playbook runner — kerf's Tier 1.
 *
 * Walks a Playbook's steps against a BrowserSession with NO model in the
 * loop: resolve ValueRefs from the intent, execute the action, evaluate
 * assertions fail-closed. A money-adjacent step whose assertions fail
 * ABORTS the run (never a guess). A step marked `agent_repair`/`takeover`
 * that fails ends the deterministic run with an escalation outcome — the
 * workflow layer decides whether to summon the Tier-2 agent or a human;
 * the runner itself never improvises.
 */

import type {
  Assertion,
  OrderIntent,
  Playbook,
  PlaybookStep,
  StepAction,
} from "@kerf/core";
import type { BrowserSession } from "./browser-host.ts";
import type { EvidenceSink } from "./evidence-sink.ts";
import { compare } from "./assert.ts";
import { parseInt10, parseMoney } from "./money.ts";
import { resolveString, resolveValueRef } from "./value.ts";

export type RunOutcome =
  | "completed"
  | "aborted" // a hard assertion/action failure on an `abort` step
  | "needs_repair" // an `agent_repair` step failed — escalate to Tier 2
  | "needs_takeover" // an `await_hook`/`takeover` step — escalate to a human
  | "needs_hook"; // an `await_hook` reached in the deterministic runner

export interface RunResult {
  outcome: RunOutcome;
  /** Extraction bag: `into` key → parsed value. */
  bag: Record<string, unknown>;
  /** Step id where the run stopped (present unless `completed`). */
  stoppedAt?: string;
  /** Human-readable reason for a non-completed outcome. */
  reason?: string;
  /** Ordered log of every step attempted and its result. */
  trace: StepTrace[];
}

export interface StepTrace {
  stepId: string;
  action: StepAction["action"];
  ok: boolean;
  detail?: string;
}

export interface RunOptions {
  session: BrowserSession;
  intent: OrderIntent;
  /** Resolve a FileRef pointer (e.g. "/files/0") to uploadable bytes. */
  resolveFile: (pointer: string) => {
    fileName: string;
    bytesBase64: string;
    mediaType?: string;
  };
  evidence?: EvidenceSink;
}

class StepError extends Error {
  readonly kind: "action" | "assertion";
  constructor(message: string, kind: "action" | "assertion") {
    super(message);
    this.kind = kind;
  }
}

export async function runPlaybook(
  playbook: Playbook,
  opts: RunOptions,
): Promise<RunResult> {
  const bag: Record<string, unknown> = {};
  const trace: StepTrace[] = [];

  for (const step of playbook.steps) {
    const onFail = step.do.action === "await_hook"
      ? "takeover"
      : (step.on_fail ?? "abort");
    try {
      await executeAction(step, opts, bag);
      const assertDetail = await runAssertions(step, opts, bag);
      trace.push({
        stepId: step.id,
        action: step.do.action,
        ok: true,
        ...(assertDetail ? { detail: assertDetail } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace.push({ stepId: step.id, action: step.do.action, ok: false, detail: reason });
      return {
        outcome: outcomeFor(onFail),
        bag,
        stoppedAt: step.id,
        reason,
        trace,
      };
    }
  }

  return { outcome: "completed", bag, trace };
}

function outcomeFor(onFail: "abort" | "agent_repair" | "takeover"): RunOutcome {
  switch (onFail) {
    case "abort":
      return "aborted";
    case "agent_repair":
      return "needs_repair";
    case "takeover":
      return "needs_takeover";
  }
}

async function executeAction(
  step: PlaybookStep,
  opts: RunOptions,
  bag: Record<string, unknown>,
): Promise<void> {
  const { session, intent } = opts;
  const a = step.do;
  switch (a.action) {
    case "navigate":
      return session.navigate(a.url);
    case "click":
      return session.click(a.selector);
    case "fill":
      return session.fill(a.selector, resolveString(a.value, intent));
    case "select":
      return session.selectByLabel(a.selector, resolveString(a.option_label, intent));
    case "upload": {
      if (!("from_intent" in a.file)) {
        throw new StepError("upload requires a from_intent file ref", "action");
      }
      const file = opts.resolveFile(a.file.from_intent);
      return session.uploadFile({
        selector: a.selector,
        fileName: file.fileName,
        bytesBase64: file.bytesBase64,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      });
    }
    case "extract": {
      const raw = await session.readText(a.selector);
      bag[a.into] = parseByHint(raw, a.parse);
      return;
    }
    case "screenshot": {
      const b64 = await session.screenshot();
      opts.evidence?.capture({
        kind: "screenshot",
        name: a.into,
        bytesBase64: b64,
        stepRef: step.id,
      });
      return;
    }
    case "await_hook":
      throw new StepError(`await_hook "${a.hook}" needs the workflow layer`, "action");
    default: {
      const _exhaustive: never = a;
      throw new StepError(`unknown action ${String(_exhaustive)}`, "action");
    }
  }
}

async function runAssertions(
  step: PlaybookStep,
  opts: RunOptions,
  bag: Record<string, unknown>,
): Promise<string | undefined> {
  if (!step.assert?.length) return undefined;
  const details: string[] = [];
  for (const assertion of step.assert) {
    const actual = await resolveActual(assertion, opts, bag);
    const expected = assertion.value !== undefined
      ? resolveValueRef(assertion.value, opts.intent)
      : undefined;
    const res = compare(assertion.op, actual, expected, assertion.tolerance_minor);
    details.push(`${assertion.subject}: ${res.detail}`);
    if (!res.ok) {
      throw new StepError(
        `assertion failed on "${assertion.subject}" — ${res.detail}`,
        "assertion",
      );
    }
  }
  return details.join("; ");
}

async function resolveActual(
  assertion: Assertion,
  opts: RunOptions,
  bag: Record<string, unknown>,
): Promise<unknown> {
  if (!assertion.read) return bag[assertion.subject];
  const { selector, source, parse } = assertion.read;
  const raw = source === "value"
    ? await opts.session.readValue(selector)
    : await opts.session.readText(selector);
  return parseByHint(raw, parse);
}

function parseByHint(
  raw: string | null,
  hint: "money" | "int" | "text" | "date" | undefined,
): unknown {
  if (raw === null) return null;
  switch (hint) {
    case "money":
      return parseMoney(raw);
    case "int":
      return parseInt10(raw);
    default:
      return raw.trim();
  }
}
