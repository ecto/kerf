/**
 * Content hashing — the binding that ACP-CM is built on. `intentHash` is the
 * `intent_hash` a VendorQuote carries and the money plane's mandate binds to:
 * if the order parameters change, the hash changes, and the quote/mandate is
 * void. Uses Web Crypto (portable across Node and edge) over a canonical
 * (key-sorted) JSON encoding so the hash is stable regardless of key order.
 */

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 of the canonical JSON, hex. */
export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The order-parameter hash for an intent (excludes volatile fields like the
 *  idempotency key so a re-quote of the same design collides intentionally). */
export async function intentHash(intent: {
  vendor: string;
  process?: string;
  files?: Array<{ sha256: string }>;
  config?: Record<string, unknown>;
  quantity?: number;
}): Promise<string> {
  return sha256Hex({
    vendor: intent.vendor,
    process: intent.process ?? null,
    files: (intent.files ?? []).map((f) => f.sha256),
    config: intent.config ?? {},
    quantity: intent.quantity ?? null,
  });
}
