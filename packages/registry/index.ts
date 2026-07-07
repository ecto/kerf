/**
 * @kerf/registry — the vendor registry as importable data.
 *
 * JSON manifests/playbooks are imported statically so every bundler
 * (eve build, Next, esbuild, node) includes them; fixtures are embedded
 * as base64 so the runner can resolve file bytes without a filesystem.
 */

import type {
  ConfiguratorIntent,
  Playbook,
  VendorManifest,
} from "@kerf/core";

import sendcutsendManifest from "./sendcutsend/manifest.json" with { type: "json" };
import sendcutsendQuote from "./sendcutsend/playbooks/quote.json" with { type: "json" };
import sendcutsendCanaryIntent from "./sendcutsend/fixtures/canary-intent.json" with { type: "json" };

/** Embedded fixture bytes, keyed `<vendor>/<file name>`. Small by design —
 *  real order artifacts come from the artifact store, never from here. */
export const FIXTURES_B64: Record<string, string> = {
  "sendcutsend/kerf-canary-100x50.dxf":
    "MApTRUNUSU9OCjIKSEVBREVSCjkKJEFDQURWRVIKMQpBQzEwMDkKMApFTkRTRUMKMApTRUNUSU9OCjIKRU5USVRJRVMKMApQT0xZTElORQo4CjAKNjYKMQo3MAoxCjAKVkVSVEVYCjgKMAoxMAowLjAKMjAKMC4wCjAKVkVSVEVYCjgKMAoxMAoxMDAuMAoyMAowLjAKMApWRVJURVgKOAowCjEwCjEwMC4wCjIwCjUwLjAKMApWRVJURVgKOAowCjEwCjAuMAoyMAo1MC4wCjAKU0VRRU5ECjAKQ0lSQ0xFCjgKMAoxMAoxMC4wCjIwCjI1LjAKNDAKMi41CjAKQ0lSQ0xFCjgKMAoxMAo5MC4wCjIwCjI1LjAKNDAKMi41CjAKRU5EU0VDCjAKRU9GCg==",
};

export interface VendorEntry {
  manifest: VendorManifest;
  playbooks: Record<string, Playbook>;
  /** Fixture intents by name (canary etc.). */
  intents: Record<string, ConfiguratorIntent>;
}

const REGISTRY: Record<string, VendorEntry> = {
  sendcutsend: {
    manifest: sendcutsendManifest as unknown as VendorManifest,
    playbooks: {
      quote: sendcutsendQuote as unknown as Playbook,
    },
    intents: {
      canary: sendcutsendCanaryIntent as unknown as ConfiguratorIntent,
    },
  },
};

export function listVendors(): string[] {
  return Object.keys(REGISTRY);
}

export function getVendor(id: string): VendorEntry {
  const entry = REGISTRY[id];
  if (!entry) {
    throw new Error(
      `kerf registry: unknown vendor "${id}" (have: ${Object.keys(REGISTRY).join(", ")})`,
    );
  }
  return entry;
}

/** Resolve embedded fixture bytes for a vendor file name. */
export function getFixtureBytes(vendor: string, name: string): Uint8Array {
  const b64 = FIXTURES_B64[`${vendor}/${name}`];
  if (!b64) throw new Error(`kerf registry: no fixture ${vendor}/${name}`);
  return Uint8Array.from(Buffer.from(b64, "base64"));
}
