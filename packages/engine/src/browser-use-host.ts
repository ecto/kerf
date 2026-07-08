/**
 * BrowserUseHost — the Browser Use cloud implementation of BrowserHost.
 *
 * This is the ONE engine module that imports a vendor SDK, and it is
 * deliberately not re-exported from `./index.ts`: the deterministic core
 * stays SDK-free, and the runtime layer (route handlers, workflows)
 * deep-imports this file when it needs a real browser.
 *
 * How it drives the page: `browser-use-sdk` provisions a cloud Chrome
 * (`browsers.create` → poll until `cdpUrl` → `GET /json/version` →
 * `webSocketDebuggerUrl` — the same dance `@browser_use/eve` does), then
 * this host speaks raw CDP over a WebSocket: `Target.attachToTarget` on
 * the first page target (flat protocol), `Page.*` for navigation and
 * screenshots, and `Runtime.evaluate` for everything element-shaped.
 *
 * Selector semantics (the BrowserHost contract, implemented in-page):
 * css → role → no-anchor, with `text`/`label` as SOFT filters — a filter
 * that would empty the candidate set is skipped. Text-anchored candidate
 * sets are reduced to the INNERMOST matching elements (every ancestor of a
 * match also "contains" the text), and the first match in document order
 * wins. Hidden elements are NOT filtered out — real configurators hide
 * `input[type=radio]` behind styled label tiles, and those inputs must
 * stay selectable.
 *
 * Actions retry element resolution until `elementTimeoutMs` (SPA renders
 * are asynchronous; the ScriptedHost is instant but a real page is not).
 * The retried unit is resolve-AND-act in a single `Runtime.evaluate`, so a
 * "not found yet" poll has no side effects and there is no gap between
 * finding an element and acting on it.
 *
 * KNOWN LIMITATIONS (Wave 0, honest list):
 *  - Clicks are `element.click()` (plus native value setters + input/change
 *    events for fills), not trusted CDP input events. SPAs listening for
 *    synthetic-excluded `isTrusted` events would not fire; the recorded SCS
 *    flow does not require trusted events.
 *  - `uploadFile` is delivered in-page (File + DataTransfer + change — the
 *    technique proven on the SCS recording run). The bytes travel inside a
 *    `Runtime.evaluate` expression as base64, which is fine for CAD files
 *    up to a few MB but is not a path for huge artifacts.
 *  - No per-job domain allowlist yet: the vendor-manifest allowlist the
 *    architecture doc calls for needs proxy/session support wired at the
 *    Browser Use session level.
 *  - Selectors are proven only by a live run. Text-anchored extraction
 *    (e.g. `{ text: "/ea" }`) resolves the innermost element containing
 *    the needle; if a vendor splits the price and its unit suffix into
 *    sibling spans the playbook selector needs tightening after the first
 *    live run — that is the recorded-playbook repair loop working as
 *    designed, not a host bug to paper over.
 */

import { BrowserUse } from "browser-use-sdk";
import type { Selector } from "@kerf/core";
import type { BrowserHost, BrowserSession } from "./browser-host.ts";

export interface BrowserUseHostOptions {
  /** Browser Use cloud API key. Defaults to `process.env.BROWSER_USE_API_KEY`. */
  apiKey?: string;
  /** Cloud session timeout in minutes (Browser Use bills hosting per hour).
   *  Default 15 — a quote walk takes minutes, not hours. */
  timeoutMinutes?: number;
  /** Per-action budget for an element to appear, ms. Default 15000. */
  elementTimeoutMs?: number;
  /** Budget for `document.readyState === "complete"` after navigate, ms.
   *  Default 30000. */
  navigateTimeoutMs?: number;
}

/** Provisions Browser Use cloud sessions. Construction is cheap and never
 *  talks to the network; `open()` does. */
export class BrowserUseHost implements BrowserHost {
  readonly key = "browser-use";
  private readonly apiKey: string | undefined;
  private readonly timeoutMinutes: number;
  private readonly elementTimeoutMs: number;
  private readonly navigateTimeoutMs: number;
  private client: BrowserUse | null = null;

  constructor(opts: BrowserUseHostOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.BROWSER_USE_API_KEY;
    this.timeoutMinutes = opts.timeoutMinutes ?? 15;
    this.elementTimeoutMs = opts.elementTimeoutMs ?? 15_000;
    this.navigateTimeoutMs = opts.navigateTimeoutMs ?? 30_000;
  }

  /** True when a Browser Use API key is available — the route layer uses
   *  this to answer "can live mode run here?" before opening anything. */
  static available(
    env: Record<string, string | undefined> = process.env,
  ): boolean {
    return Boolean(env.BROWSER_USE_API_KEY);
  }

  async open(): Promise<BrowserSession> {
    if (!this.apiKey) {
      throw new Error(
        "kerf: BrowserUseHost has no API key — set BROWSER_USE_API_KEY or pass { apiKey }. " +
          "Scripted mode (ScriptedHost) needs no key.",
      );
    }
    this.client ??= new BrowserUse({ apiKey: this.apiKey });

    // Provision, then poll until the CDP endpoint is live (same cadence as
    // @browser_use/eve: up to 30 × 1 s).
    let b = await this.client.browsers.create({ timeout: this.timeoutMinutes });
    for (let i = 0; i < 30 && !b.cdpUrl; i++) {
      await sleep(1000);
      b = await this.client.browsers.get(b.id);
    }
    if (!b.cdpUrl) {
      throw new Error(`kerf: cloud browser ${b.id} did not expose a cdpUrl in time`);
    }

    const wsUrl = await resolveWebSocketUrl(b.cdpUrl);
    const cdp = await CdpConnection.dial(wsUrl);
    try {
      const sessionId = await cdp.attachFirstPage();
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      return new BrowserUseSession(b.id, b.liveUrl ?? null, cdp, sessionId, {
        elementTimeoutMs: this.elementTimeoutMs,
        navigateTimeoutMs: this.navigateTimeoutMs,
      });
    } catch (err) {
      cdp.dispose();
      await this.stopQuietly(b.id);
      throw err;
    }
  }

  async close(session: BrowserSession): Promise<void> {
    if (session instanceof BrowserUseSession) session.dispose();
    await this.stopQuietly(session.id);
  }

  /** Stopping the cloud session is billing hygiene, not correctness — a
   *  failure here must never mask the run result (close runs in `finally`).
   *  Unstopped sessions expire at `timeoutMinutes` server-side. */
  private async stopQuietly(id: string): Promise<void> {
    try {
      await this.client?.browsers.stop(id);
    } catch (err) {
      console.warn(`kerf: failed to stop cloud browser ${id}:`, err);
    }
  }
}

/** `GET <cdpUrl>/json/version` → the browser-level WebSocket debugger URL. */
async function resolveWebSocketUrl(cdpUrl: string): Promise<string> {
  const base = cdpUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json/version`);
  if (!res.ok) {
    throw new Error(`kerf: GET ${base}/json/version failed: ${res.status}`);
  }
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) {
    throw new Error(`kerf: no webSocketDebuggerUrl from ${base}/json/version`);
  }
  return info.webSocketDebuggerUrl;
}

/* ------------------------------------------------------------------ */
/* CDP plumbing                                                        */
/* ------------------------------------------------------------------ */

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: string };
}

/** Minimal flat-protocol CDP client over the browser WebSocket. Commands
 *  only — the host polls state rather than subscribing to events, which
 *  keeps the failure modes enumerable. */
class CdpConnection {
  private nextId = 1;
  private readonly ws: WebSocket;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      this.onMessage(typeof ev.data === "string" ? ev.data : "");
    });
    ws.addEventListener("close", () => this.rejectAll(new Error("kerf: CDP socket closed")));
    ws.addEventListener("error", () => this.rejectAll(new Error("kerf: CDP socket error")));
  }

  static async dial(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(`kerf: failed to open CDP WebSocket ${wsUrl}`));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onErr);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onErr);
    });
    return new CdpConnection(ws);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`kerf: CDP ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Don't hold the process open for a timer that will never matter.
      timer.unref?.();
    });
    this.ws.send(msg);
    return result;
  }

  /** Attach to the first page target (flat protocol) → CDP sessionId. */
  async attachFirstPage(): Promise<string> {
    const res = await this.send("Target.getTargets");
    const infos = (res.targetInfos ?? []) as Array<{ targetId: string; type: string }>;
    let target = infos.find((t) => t.type === "page");
    if (!target) {
      const created = await this.send("Target.createTarget", { url: "about:blank" });
      target = { targetId: String(created.targetId), type: "page" };
    }
    const attached = await this.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    return String(attached.sessionId);
  }

  dispose(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.rejectAll(new Error("kerf: CDP connection disposed"));
  }

  private onMessage(raw: string): void {
    let msg: CdpResponse;
    try {
      msg = JSON.parse(raw) as CdpResponse;
    } catch {
      return; // not JSON — nothing of ours
    }
    if (msg.id === undefined) return; // event — this client only tracks commands
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      waiter.reject(new Error(`kerf: CDP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      waiter.resolve(msg.result ?? {});
    }
  }

  private rejectAll(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------ */
/* In-page selector resolution + actions                               */
/* ------------------------------------------------------------------ */

/**
 * The in-page library, injected as the prelude of every evaluate call.
 * Implements the BrowserHost selector contract: css → role → no anchor,
 * text/label as soft filters, innermost-first, first match wins.
 */
const PAGE_LIB = /* js */ `
  const norm = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
  const lower = (s) => norm(s).toLowerCase();
  const ownText = (el) => norm(el.innerText ?? el.textContent ?? "");
  const IMPLICIT_ROLE = {
    button: "button, input[type=button], input[type=submit], input[type=reset], [role=button]",
    link: "a[href], [role=link]",
    radio: "input[type=radio], [role=radio]",
    checkbox: "input[type=checkbox], [role=checkbox]",
    textbox: "input:not([type]), input[type=text], input[type=email], input[type=number], input[type=search], textarea, [role=textbox]",
    combobox: "select, [role=combobox]",
    option: "option, [role=option]",
  };
  function labelText(el) {
    const parts = [];
    if (el.getAttribute) {
      const aria = el.getAttribute("aria-label");
      if (aria) parts.push(aria);
      const ph = el.getAttribute("placeholder");
      if (ph) parts.push(ph);
    }
    if (el.labels) for (const l of el.labels) parts.push(ownText(l));
    const wrap = el.closest ? el.closest("label") : null;
    if (wrap) parts.push(ownText(wrap));
    parts.push(ownText(el));
    return norm(parts.join(" "));
  }
  function innermost(list) {
    return list.filter((el) => !list.some((o) => o !== el && el.contains(o)));
  }
  function candidates(sel) {
    let list;
    if (sel.css) {
      list = Array.from(document.querySelectorAll(sel.css));
    } else if (sel.role) {
      const css = IMPLICIT_ROLE[sel.role];
      list = css
        ? Array.from(document.querySelectorAll(css))
        : Array.from(document.querySelectorAll('[role="' + sel.role + '"]'));
    } else {
      list = Array.from(document.querySelectorAll("*"));
    }
    if (sel.text) {
      const t = list.filter((el) => ownText(el).includes(norm(sel.text)));
      if (t.length) list = t; // soft filter: never empties the set
    }
    if (sel.label) {
      const t = list.filter((el) => lower(labelText(el)).includes(lower(sel.label)));
      if (t.length) list = t; // soft filter
    }
    return innermost(list);
  }
  function resolveOne(sel) {
    return candidates(sel)[0] ?? null;
  }
  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    fire(el, "input");
    fire(el, "change");
  }
  function activate(el) {
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
      const label = el.labels && el.labels[0];
      (label ?? el).click();
      if (!el.checked) el.click();
      if (!el.checked) { el.checked = true; fire(el, "input"); fire(el, "change"); }
      return;
    }
    el.click();
  }
  function findOption(scope, target) {
    for (const s of scope.querySelectorAll("select")) {
      for (const o of s.options) if (lower(o.textContent) === target) return { kind: "option", select: s, option: o };
    }
    for (const inp of scope.querySelectorAll("input[type=radio], input[type=checkbox]")) {
      if (lower(labelText(inp)).includes(target)) return { kind: "el", el: inp };
    }
    const clickables = Array.from(
      scope.querySelectorAll("a, button, [role=option], [role=button], [role=radio], label, li"),
    );
    const exact = innermost(clickables.filter((el) => lower(ownText(el)) === target));
    if (exact[0]) return { kind: "el", el: exact[0] };
    const loose = innermost(clickables.filter((el) => lower(ownText(el)).includes(target)));
    if (loose[0]) return { kind: "el", el: loose[0] };
    return null;
  }
`;

interface PageResult {
  found: boolean;
  error?: string;
  value?: string | null;
}

interface SessionTimeouts {
  elementTimeoutMs: number;
  navigateTimeoutMs: number;
}

/** One live cloud page. All element work happens in-page via
 *  `Runtime.evaluate`; see the module header for semantics and limits. */
class BrowserUseSession implements BrowserSession {
  readonly id: string;
  readonly liveUrl: string | null;
  private readonly cdp: CdpConnection;
  private readonly sessionId: string;
  private readonly timeouts: SessionTimeouts;

  constructor(
    id: string,
    liveUrl: string | null,
    cdp: CdpConnection,
    sessionId: string,
    timeouts: SessionTimeouts,
  ) {
    this.id = id;
    this.liveUrl = liveUrl;
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
  }

  dispose(): void {
    this.cdp.dispose();
  }

  async navigate(url: string): Promise<void> {
    const res = await this.cdp.send("Page.navigate", { url }, this.sessionId);
    if (typeof res.errorText === "string" && res.errorText.length > 0) {
      throw new Error(`kerf: navigation to ${url} failed: ${res.errorText}`);
    }
    // Poll readiness rather than juggling load events: same-document hash
    // navigations never fire load, and an SPA's readyState is already
    // "complete" the moment the shell is up. Element waits (per action)
    // absorb the render lag that follows.
    const deadline = Date.now() + this.timeouts.navigateTimeoutMs;
    for (;;) {
      const state = await this.rawEval(`document.readyState`);
      if (state === "complete") return;
      if (Date.now() > deadline) {
        throw new Error(
          `kerf: navigation to ${url} did not reach readyState "complete" within ${this.timeouts.navigateTimeoutMs}ms`,
        );
      }
      await sleep(250);
    }
  }

  async click(selector: Selector): Promise<void> {
    await this.actOnElement(
      selector,
      `activate(el); return { found: true };`,
      `click ${describe(selector)}`,
    );
  }

  async fill(selector: Selector, value: string): Promise<void> {
    await this.actOnElement(
      selector,
      `setNativeValue(el, ${JSON.stringify(value)}); return { found: true };`,
      `fill ${describe(selector)}`,
    );
  }

  async selectByLabel(selector: Selector, label: string): Promise<void> {
    const body = `
      const target = lower(${JSON.stringify(label)});
      const cands = candidates(sel);
      if (!cands.length) return { found: false };
      // 1. A <select> candidate: choose the option by visible text.
      for (const el of cands) {
        if (el instanceof HTMLSelectElement) {
          for (const o of el.options) {
            if (lower(o.textContent) === target || lower(o.textContent).includes(target)) {
              setNativeValue(el, o.value);
              return { found: true };
            }
          }
        }
      }
      // 2. A candidate that itself carries the label (radio tile, link, card).
      for (const el of cands) {
        if (lower(labelText(el)).includes(target)) { activate(el); return { found: true }; }
      }
      // 3. Nearest-ancestor scope: walk up from each candidate (a text
      //    anchor like { text: "Confirm drawing units" } resolves to the
      //    heading, while the options live in the surrounding modal) and
      //    take the closest scope that contains a matching option.
      for (const el of cands) {
        for (let scope = el; scope; scope = scope.parentElement) {
          const hit = findOption(scope, target);
          if (!hit) continue;
          if (hit.kind === "option") { setNativeValue(hit.select, hit.option.value); return { found: true }; }
          activate(hit.el);
          return { found: true };
        }
      }
      return { found: false };
    `;
    await this.retryUntilFound(
      body,
      { sel: selector },
      `selectByLabel ${JSON.stringify(label)} within ${describe(selector)}`,
    );
  }

  async uploadFile(args: {
    selector: Selector;
    fileName: string;
    bytesBase64: string;
    mediaType?: string;
  }): Promise<void> {
    // In-page File + DataTransfer + change — the technique proven on the
    // SCS recording run. No host filesystem, no DOM.setFileInputFiles.
    const body = `
      const el = resolveOne(sel);
      if (!el) return { found: false };
      if (!(el instanceof HTMLInputElement) || el.type !== "file") {
        return { found: true, error: "uploadFile: matched element is not an <input type=file>" };
      }
      const b64 = ${JSON.stringify(args.bytesBase64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(args.fileName)}, {
        type: ${JSON.stringify(args.mediaType ?? "application/octet-stream")},
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      fire(el, "input");
      fire(el, "change");
      if (!el.files || el.files.length !== 1) {
        return { found: true, error: "uploadFile: file input did not accept the file" };
      }
      return { found: true };
    `;
    await this.retryUntilFound(
      body,
      { sel: args.selector },
      `uploadFile ${JSON.stringify(args.fileName)} into ${describe(args.selector)}`,
    );
  }

  async readText(selector: Selector): Promise<string | null> {
    return this.read(selector, `return { found: true, value: el.innerText ?? el.textContent ?? null };`);
  }

  async readValue(selector: Selector): Promise<string | null> {
    return this.read(selector, `return { found: true, value: "value" in el ? String(el.value) : null };`);
  }

  async screenshot(): Promise<string> {
    const res = await this.cdp.send(
      "Page.captureScreenshot",
      { format: "png" },
      this.sessionId,
      60_000,
    );
    if (typeof res.data !== "string") {
      throw new Error("kerf: Page.captureScreenshot returned no data");
    }
    return res.data;
  }

  /* ---------------- internals ---------------- */

  /** Reads wait for presence like actions do (the price node renders after
   *  the SPA finishes quoting), then return null per the contract if the
   *  element never appears. */
  private async read(selector: Selector, onFound: string): Promise<string | null> {
    try {
      const result = await this.retryUntilFound(
        `const el = resolveOne(sel); if (!el) return { found: false }; ${onFound}`,
        { sel: selector },
        `read ${describe(selector)}`,
      );
      return result.value ?? null;
    } catch (err) {
      if (err instanceof ElementNotFoundError) return null;
      throw err;
    }
  }

  private async actOnElement(selector: Selector, onFound: string, what: string): Promise<void> {
    await this.retryUntilFound(
      `const el = resolveOne(sel); if (!el) return { found: false }; ${onFound}`,
      { sel: selector },
      what,
    );
  }

  /** Evaluate resolve-and-act until it reports `found` or the element
   *  budget runs out. A not-found poll has no side effects, so retrying is
   *  safe; an in-page `error` is a real failure and is never retried. */
  private async retryUntilFound(
    body: string,
    bindings: Record<string, unknown>,
    what: string,
  ): Promise<PageResult> {
    const deadline = Date.now() + this.timeouts.elementTimeoutMs;
    for (;;) {
      const result = await this.evalPage(body, bindings);
      if (result.error) throw new Error(`kerf: ${what} — ${result.error}`);
      if (result.found) return result;
      if (Date.now() > deadline) {
        throw new ElementNotFoundError(
          `kerf: ${what} — no element matched within ${this.timeouts.elementTimeoutMs}ms`,
        );
      }
      await sleep(250);
    }
  }

  /** Run `body` in-page with the shared PAGE_LIB prelude and JSON bindings.
   *  `body` must `return` a PageResult-shaped object. */
  private async evalPage(
    body: string,
    bindings: Record<string, unknown>,
  ): Promise<PageResult> {
    const decls = Object.entries(bindings)
      .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
      .join("\n");
    const expression = `(() => { ${PAGE_LIB}\n${decls}\n${body}\n})()`;
    const raw = await this.rawEval(expression);
    if (raw === null || typeof raw !== "object") {
      throw new Error(`kerf: in-page evaluation returned ${JSON.stringify(raw)} — expected an object`);
    }
    return raw as PageResult;
  }

  private async rawEval(expression: string): Promise<unknown> {
    const res = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );
    const exception = res.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (exception) {
      const detail = exception.exception?.description ?? exception.text ?? "unknown";
      throw new Error(`kerf: in-page evaluation threw: ${detail}`);
    }
    const result = res.result as { value?: unknown } | undefined;
    return result?.value ?? null;
  }
}

/** Distinguishes "element never appeared" (reads map it to null) from real
 *  in-page failures (always thrown). */
class ElementNotFoundError extends Error {}

function describe(sel: Selector): string {
  return JSON.stringify(sel);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
