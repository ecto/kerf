/**
 * ValueRef resolution — literals and JSON-pointer-lite reads into the
 * OrderIntent. Values flow FROM the intent TO the page, never the reverse:
 * this is the one-way gate that keeps page content (untrusted) out of the
 * decisions the runner makes.
 */

import type { OrderIntent, ValueRef } from "@kerf/core";

/** Resolve a `/a/b/0` pointer against an object. Returns undefined on any
 *  missing segment — callers decide whether that is fatal. */
export function pointer(root: unknown, path: string): unknown {
  if (path === "" || path === "/") return root;
  let cur: unknown = root;
  for (const rawSeg of path.replace(/^\//, "").split("/")) {
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Resolve a ValueRef to a primitive (or an object, for file refs). */
export function resolveValueRef(ref: ValueRef, intent: OrderIntent): unknown {
  if ("literal" in ref) return ref.literal;
  const v = pointer(intent, ref.from_intent);
  if (v === undefined) {
    throw new Error(
      `kerf: intent pointer "${ref.from_intent}" resolved to undefined`,
    );
  }
  return v;
}

/** Resolve to a string for fill/select actions. */
export function resolveString(ref: ValueRef, intent: OrderIntent): string {
  const v = resolveValueRef(ref, intent);
  if (v === null || typeof v === "object") {
    throw new Error(
      `kerf: value ref did not resolve to a scalar (got ${typeof v})`,
    );
  }
  return String(v);
}
