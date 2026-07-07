/**
 * Money parsing — page text → integer minor units. Pure and total.
 *
 * The page shows "$5.58 /ea", "$1,234.50", "Subtotal $5.58". We want 558,
 * 123450, 558. Returns null when no currency-looking number is present, so
 * a `present` assertion on a missing price fails closed rather than
 * defaulting to 0 (which would read as "free").
 */

/**
 * Parse the first currency amount in `text` to integer minor units.
 *
 * Currency-anchored on purpose: a bare integer like the "11" in "Jul 11" is
 * NOT money and must return null, or a lead-time string would parse as a
 * price. So a match requires either a `$` prefix or a 1–2 digit decimal.
 */
export function parseMoney(text: string): number | null {
  // Prefer a $-anchored amount; fall back to a bare decimal (e.g. "5.58").
  const dollar = text.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  const decimal = text.match(/(\d{1,3}(?:,\d{3})*\.\d{1,2}|\d+\.\d{1,2})/);
  const raw = dollar?.[1] ?? decimal?.[1];
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Parse the first integer in `text`, or null. */
export function parseInt10(text: string): number | null {
  const m = text.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}
