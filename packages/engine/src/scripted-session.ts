/**
 * ScriptedSession — a faithful in-memory model of the RECORDED SendCutSend
 * quote flow (2026-07-07), for testing the runner without a live browser.
 *
 * It reproduces exactly the transitions the recording observed: upload →
 * units modal → material category → family → alloy → thickness radios →
 * priced configurator, and answers the grounded reads (checked radio value,
 * quantity input value, "$5.58 /ea", "Subtotal $x", lead line). It does NOT
 * model real selectors — only a live run proves those. What it proves is the
 * RUNNER: sequencing, ValueRef resolution, money parsing, assertion
 * evaluation, and abort/repair outcomes.
 */

import type { Selector } from "@kerf/core";
import type { BrowserSession } from "./browser-host.ts";

type Stage =
  | "await_upload"
  | "units"
  | "confirm"
  | "category"
  | "family"
  | "alloy"
  | "thickness"
  | "priced";

const THICKNESS_LABEL_TO_CODE: Record<string, string> = {
  '.125" (3.2 MM)': "ALU-125",
  '.040" (1.0 MM)': "ALU-040",
  '.250" (6.3 MM)': "ALU-250",
};

const KNOWN = {
  categories: new Set(["Metals", "Composites", "Plastics", "Wood And MDF", "Rubber And Gasket"]),
  families: new Set(["Aluminum", "Brass", "Copper", "Stainless Steel", "Steel", "Titanium"]),
  alloys: new Set(["2024 T3", "5052 H32", "6061 T6", "7075 T6", "MIC-6"]),
};

/** The unit price the recording observed at qty 1, in minor units. */
const UNIT_PRICE_MINOR = 558;

function sig(sel: Selector): string {
  return sel.css ?? sel.text ?? sel.label ?? sel.role ?? "";
}

export class ScriptedSession implements BrowserSession {
  readonly id = "scripted-scs";
  readonly liveUrl = "https://live.example/scripted";

  private stage: Stage = "await_upload";
  private units: string | null = null;
  private thicknessCode: string | null = null;
  private qty = 1;
  screenshots = 0;

  async navigate(_url: string): Promise<void> {
    this.stage = "await_upload";
  }

  async uploadFile(_args: {
    selector: Selector;
    fileName: string;
    bytesBase64: string;
  }): Promise<void> {
    if (this.stage !== "await_upload") throw new Error("upload: unexpected stage");
    this.stage = "units";
  }

  async selectByLabel(selector: Selector, label: string): Promise<void> {
    const s = sig(selector);
    if (s === "Confirm drawing units") {
      this.units = label;
      return;
    }
    if (s === "input[type=radio]") {
      // Thickness tile chosen by its visible label.
      this.thicknessCode = THICKNESS_LABEL_TO_CODE[label] ?? null;
      this.stage = "priced";
      return;
    }
    // Material navigation links (category → family → alloy).
    if (this.stage === "category") {
      if (!KNOWN.categories.has(label)) throw new Error(`no category "${label}"`);
      this.stage = "family";
      return;
    }
    if (this.stage === "family") {
      if (!KNOWN.families.has(label)) throw new Error(`no family "${label}"`);
      this.stage = "alloy";
      return;
    }
    if (this.stage === "alloy") {
      if (!KNOWN.alloys.has(label)) throw new Error(`no alloy "${label}"`);
      this.stage = "thickness";
      return;
    }
    throw new Error(`selectByLabel("${label}") unexpected at stage ${this.stage}`);
  }

  async click(selector: Selector): Promise<void> {
    if (sig(selector) === "CONFIRM") {
      if (this.stage !== "units") throw new Error("CONFIRM: units not chosen");
      this.stage = "category";
      return;
    }
    throw new Error(`click: no element ${sig(selector)}`);
  }

  async fill(selector: Selector, value: string): Promise<void> {
    if (sig(selector) === "input[type=number]") {
      if (this.stage !== "priced") throw new Error("qty before priced");
      this.qty = Number.parseInt(value, 10);
      return;
    }
    throw new Error(`fill: no element ${sig(selector)}`);
  }

  async readValue(selector: Selector): Promise<string | null> {
    const s = sig(selector);
    if (s === "input[type=radio]:checked") return this.thicknessCode;
    if (s === "input[type=number]") return String(this.qty);
    return null;
  }

  async readText(selector: Selector): Promise<string | null> {
    if (this.stage !== "priced") return null;
    const s = sig(selector);
    if (s === "/ea") return `$${(UNIT_PRICE_MINOR / 100).toFixed(2)} /ea`;
    if (s === "Subtotal") {
      return `Subtotal $${((UNIT_PRICE_MINOR * this.qty) / 100).toFixed(2)}`;
    }
    if (s === "Arrives as soon as") return "Arrives as soon as: Jul 11";
    return null;
  }

  async screenshot(): Promise<string> {
    this.screenshots += 1;
    return "iVBORw0KGgo="; // 1x1 PNG stand-in
  }
}
