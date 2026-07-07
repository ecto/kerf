/**
 * Assertion comparison — pure. The runner resolves the actual value (from
 * the extraction bag or a live page read) and the expected value (a
 * ValueRef), then calls `compare`. Fail-closed is the caller's job: a null
 * actual fails every op except a negative `present`.
 */

export type AssertOp = "eq" | "approx" | "lte" | "gte" | "matches" | "present";

export interface CompareResult {
  ok: boolean;
  detail: string;
}

/** Compare `actual` against `expected` under `op`. */
export function compare(
  op: AssertOp,
  actual: unknown,
  expected: unknown,
  toleranceMinor?: number,
): CompareResult {
  if (op === "present") {
    const ok = actual !== null && actual !== undefined && actual !== "";
    return { ok, detail: `present(${fmt(actual)}) = ${ok}` };
  }

  if (actual === null || actual === undefined) {
    return { ok: false, detail: `actual is ${fmt(actual)} (fail-closed)` };
  }

  switch (op) {
    case "eq": {
      const ok = numericEq(actual, expected) ?? strEq(actual, expected);
      return { ok, detail: `${fmt(actual)} == ${fmt(expected)} → ${ok}` };
    }
    case "approx": {
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a === null || e === null) {
        return { ok: false, detail: `approx needs numbers (${fmt(actual)}, ${fmt(expected)})` };
      }
      const tol = toleranceMinor ?? 0;
      const ok = Math.abs(a - e) <= tol;
      return { ok, detail: `|${a} - ${e}| <= ${tol} → ${ok}` };
    }
    case "lte":
    case "gte": {
      const a = asNumber(actual);
      const e = asNumber(expected);
      if (a === null || e === null) {
        return { ok: false, detail: `${op} needs numbers (${fmt(actual)}, ${fmt(expected)})` };
      }
      const ok = op === "lte" ? a <= e : a >= e;
      return { ok, detail: `${a} ${op} ${e} → ${ok}` };
    }
    case "matches": {
      const re = new RegExp(String(expected));
      const ok = re.test(String(actual));
      return { ok, detail: `/${expected}/.test(${fmt(actual)}) → ${ok}` };
    }
    default: {
      const _exhaustive: never = op;
      return { ok: false, detail: `unknown op ${String(_exhaustive)}` };
    }
  }
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numericEq(a: unknown, e: unknown): boolean | null {
  const na = asNumber(a);
  const ne = asNumber(e);
  if (na === null || ne === null) return null;
  return na === ne;
}

function strEq(a: unknown, e: unknown): boolean {
  return String(a).trim() === String(e).trim();
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
