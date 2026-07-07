/**
 * BrowserHost — the swappable browser substrate.
 *
 * The engine talks to this ACTION-SHAPED interface, never to a vendor SDK.
 * The host adapter owns the CDP/JS translation (selector resolution, event
 * dispatch, in-page file delivery); the engine owns orchestration, ValueRef
 * resolution, money parsing, and assertions. That split is what keeps the
 * smart logic testable without a real browser and lets kerf swap Browser Use
 * for Browserbase/Sandbox-Chromium behind the same shape.
 *
 * Selector resolution order (host contract): css → role → then narrow by
 * text/label as SOFT filters (a filter that would empty the candidate set is
 * skipped, so `{ css: "input[type=file]", label: "BROWSE FILES" }` resolves
 * to the input even though the label lives on a sibling). First match wins.
 */

import type { Selector } from "@kerf/core";

/** A live browser session, addressable across workflow suspensions by `id`. */
export interface BrowserSession {
  /** Stable session id (survives workflow suspend/resume). */
  readonly id: string;
  /** Shareable human watch URL; null if the host has none. */
  readonly liveUrl: string | null;

  /** Navigate the focused tab and wait for load. */
  navigate(url: string): Promise<void>;

  /** Click the first element matching `selector`. Rejects if none match. */
  click(selector: Selector): Promise<void>;

  /** Set an input's value and fire input/change. Rejects if none match. */
  fill(selector: Selector, value: string): Promise<void>;

  /**
   * Choose an option by its visible label within `selector`'s scope — a
   * `<select>` option, a radio tile, or a clickable option link/card. The
   * host clicks it and fires the events the SPA listens for. Rejects if no
   * option with that label is found.
   */
  selectByLabel(selector: Selector, label: string): Promise<void>;

  /**
   * Deliver file bytes to a file input matched by `selector`. Implemented
   * in-page (File + DataTransfer + change event — the technique proven on
   * the SCS recording run), so no host filesystem is required.
   */
  uploadFile(args: {
    selector: Selector;
    fileName: string;
    bytesBase64: string;
    mediaType?: string;
  }): Promise<void>;

  /** innerText of the first match, or null if none. */
  readText(selector: Selector): Promise<string | null>;

  /** `.value` of the first matching input, or null if none. */
  readValue(selector: Selector): Promise<string | null>;

  /** Capture a PNG screenshot, returned base64. The caller masks payment
   *  fields before calling — a PAN in a screenshot is a capture bug. */
  screenshot(): Promise<string>;
}

/** Provisions and disposes sessions. */
export interface BrowserHost {
  readonly key: string;
  open(): Promise<BrowserSession>;
  close(session: BrowserSession): Promise<void>;
}
