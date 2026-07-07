import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInt10, parseMoney } from "./money.ts";

test("parseMoney: recorded SCS strings", () => {
  assert.equal(parseMoney("$5.58 /ea"), 558);
  assert.equal(parseMoney("Subtotal $5.58"), 558);
  assert.equal(parseMoney("$1,234.50"), 123450);
  assert.equal(parseMoney("$0.99"), 99);
  assert.equal(parseMoney("$12"), 1200);
});

test("parseMoney: no currency → null (fail-closed, never 0)", () => {
  assert.equal(parseMoney("Arrives as soon as Jul 11"), null);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("free shipping"), null);
});

test("parseInt10", () => {
  assert.equal(parseInt10("Qty: 1"), 1);
  assert.equal(parseInt10("100"), 100);
  assert.equal(parseInt10("none"), null);
});
