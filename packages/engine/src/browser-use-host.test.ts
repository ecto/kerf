import { test } from "node:test";
import assert from "node:assert/strict";

import { BrowserUseHost } from "./browser-use-host.ts";

// These tests never touch the network: they prove the key-handling contract
// (honest errors, availability probe). Driving a real cloud session is the
// live-verification step the Wave-0 roadmap tracks separately.

test("BrowserUseHost.available reflects the presence of the API key", () => {
  assert.equal(BrowserUseHost.available({}), false);
  assert.equal(BrowserUseHost.available({ BROWSER_USE_API_KEY: "" }), false);
  assert.equal(BrowserUseHost.available({ BROWSER_USE_API_KEY: "bu_test" }), true);
});

test("BrowserUseHost.open without a key fails loudly, not lazily", async () => {
  const saved = process.env.BROWSER_USE_API_KEY;
  delete process.env.BROWSER_USE_API_KEY;
  try {
    const host = new BrowserUseHost();
    assert.equal(host.key, "browser-use");
    await assert.rejects(host.open(), /BROWSER_USE_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.BROWSER_USE_API_KEY = saved;
  }
});
