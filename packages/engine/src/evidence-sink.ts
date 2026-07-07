/**
 * EvidenceSink — where the runner hands captured artifacts. The engine
 * stays storage-agnostic: the workflow layer supplies a sink that hashes,
 * masks, and persists into the artifact store, then folds the results into
 * the job's EvidenceBundle (@kerf/core). A no-op sink is fine for canaries.
 */

export interface EvidenceCapture {
  kind: "screenshot" | "dom_snapshot";
  name: string;
  bytesBase64: string;
  stepRef?: string;
}

export interface EvidenceSink {
  capture(item: EvidenceCapture): void;
}

/** Collects captures in memory — handy for tests and canary summaries. */
export class MemoryEvidenceSink implements EvidenceSink {
  readonly items: EvidenceCapture[] = [];
  capture(item: EvidenceCapture): void {
    this.items.push(item);
  }
}
