import { test } from "node:test";
import assert from "node:assert/strict";
import { compare } from "./assert.ts";
import { pointer, resolveValueRef } from "./value.ts";
import type { OrderIntent } from "@kerf/core";

test("compare: present fails closed on null/empty", () => {
  assert.equal(compare("present", null, undefined).ok, false);
  assert.equal(compare("present", "", undefined).ok, false);
  assert.equal(compare("present", 558, undefined).ok, true);
});

test("compare: eq is numeric when both sides are numbers, else string", () => {
  assert.equal(compare("eq", 1, "1").ok, true); // "1" coerces
  assert.equal(compare("eq", "ALU-125", "ALU-125").ok, true);
  assert.equal(compare("eq", "5052 H32", "6061 T6").ok, false);
});

test("compare: approx honors tolerance, non-numbers fail closed", () => {
  assert.equal(compare("approx", 560, 558, 5).ok, true);
  assert.equal(compare("approx", 570, 558, 5).ok, false);
  assert.equal(compare("approx", null, 558, 5).ok, false);
});

test("compare: lte/gte need numbers", () => {
  assert.equal(compare("lte", 500, 558).ok, true);
  assert.equal(compare("gte", 600, 558).ok, true);
  assert.equal(compare("lte", "n/a", 558).ok, false);
});

test("pointer + resolveValueRef read into the intent", () => {
  const intent = {
    kind: "configurator",
    quantity: 3,
    config: { material: "5052 H32", thickness: "ALU-125" },
    files: [{ name: "p.dxf", bytes: 10, sha256: "abc" }],
  } as unknown as OrderIntent;

  assert.equal(pointer(intent, "/quantity"), 3);
  assert.equal(pointer(intent, "/config/material"), "5052 H32");
  assert.equal((pointer(intent, "/files/0") as { name: string }).name, "p.dxf");
  assert.equal(resolveValueRef({ from_intent: "/config/thickness" }, intent), "ALU-125");
  assert.equal(resolveValueRef({ literal: "MM" }, intent), "MM");
  assert.throws(() => resolveValueRef({ from_intent: "/nope" }, intent));
});
