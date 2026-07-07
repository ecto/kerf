# kerf architecture

*Founding design doc, 2026-07-07. Ported from
`ecto/vcad/docs/plans/2026-07-07-kerf-browser-ordering-rail.md`; this copy
is canonical and moves with the code.*

kerf is the **commerce plane** for agentic hardware procurement —
*Stripe for metal*. A design surface (reference: [vcad](https://github.com/ecto/vcad))
produces geometry, DFM, and files; kerf turns **files + config** into a
manufactured part delivered, and hands back a receipt. Like Stripe, kerf
is *integrated, not integrating*: the design surface and the buyer agent
call kerf; kerf owns exactly the parts they must not touch — the supplier
drivers, the payment instrument, the out-of-band human approval, and the
evidence. The design surface never learns a CSS selector or touches a
card; the buyer agent never sees a PAN. The protocol is
[ACP-CM](https://github.com/ecto/vcad/blob/main/docs/agentic-commerce-custom-manufacturing.md).

## The problem

Most suppliers have no purchasing API — sheet metal has zero buyer APIs
industry-wide, JLCPCB denied its API application, and the long tail of job
shops never will have one. Every supplier does have one API: their
website. A browser agent is the adapter of last resort, and because it is
last-resort it is universal. kerf treats every supplier website as an
undocumented, unstable, **untrusted** API and builds a driver stack for
it: deterministic where possible, adaptive where necessary, evidence
everywhere, fail-closed at every money boundary.

## Stripe for metal — the boundary

Stripe is the reference for how this composes. A merchant integrates
Stripe with a `PaymentIntent`; Stripe owns the card networks, PCI scope,
the dashboard where the human sees and disputes charges, idempotency, and
the webhooks that report settlement. The merchant never touches a card
network. kerf is the same shape for fabrication:

| Stripe | kerf |
|---|---|
| `PaymentIntent` (amount + method) | `OrderIntent` (files + config + qty) |
| N payment methods behind one API | N suppliers × {browser, api, email} behind one API |
| the Dashboard (human's trusted, out-of-band surface) | kerf's approval + orders surface (the channel the agent can't control) |
| idempotency keys → exactly-once charge | idempotency keys → exactly-once order |
| webhooks → async settlement events | hooks → confirmation email, card settlement, tracking |
| Issuing / merchant-of-record | Stripe Issuing *inside* kerf; kerf is MoR for the part |

**The law that falls out of it: you integrate kerf; kerf does not
integrate you.** The design surface (vcad) and the buyer agent are kerf's
*merchants*. They call kerf. kerf never calls back into a design surface,
and — critically — **the design surface does not orchestrate kerf.** An
earlier draft had vcad's fabricate broker run a kerf quote job and vcad's
`place_order` issue the card; that inverted the dependency and is dropped.

### Three planes, one integrator

1. **Design** — geometry, DFM, files, the `doc_hash`. vcad, or any CAD
   tool, or an agent with a DXF. Standalone; knows nothing about kerf.
2. **Commerce** — wallet, out-of-band human approval, card issuing, the
   supplier drivers, evidence, receipts. **This is all kerf.** Money and
   execution live *together* here for one non-negotiable reason (below).
3. The **buyer agent** (Claude) is the integrator: it designs in plane 1,
   exports files, and hands them to plane 2. It holds both MCPs as peers.

**Why money and execution must be one service:** the card issuer has to
hand the PAN to the runtime that *types* it, over a server-to-server link
**the agent never mediates** — that is what keeps the agent from ever
seeing card data. If the agent were the courier ("vcad issues a card, the
agent passes it to kerf") the whole containment model collapses. So the
wallet, the human approval surface, Stripe Issuing, and the browser
runtime are one deployable: kerf. From the agent's side it is *just a kerf
MCP* — `quote`, `authorize_spend` (proposes; the human approves in kerf's
own surface), `place_order` (kerf verifies the mandate, issues the card,
its runtime types it — all server-side).

### What is shared — data, never calls

The only thing that crosses the boundary is **schema**, not service calls:

- **Receipts.** kerf emits commerce claims (`kerf/upload-hash`,
  `kerf/card-settlement`, `kerf/tracking`) into the shared
  [`vcad-receipt`](https://github.com/ecto/vcad/tree/main/crates/vcad-receipt)
  format; vcad emits design claims into the same format; the agent (or
  whoever wants the unified "receipt you can hear") assembles both. A
  shared format, not a dependency.
- **`doc_hash` provenance.** vcad computes it; the agent carries it into
  the `OrderIntent`; kerf binds its mandate to `intent_hash` and records
  `doc_hash` as provenance. Data flowing with the design, not a callback.

### The non-agent path

A human clicking "Order" in the vcad **web app** resolves the same way:
the app is a *client* of kerf's API, exactly like the agent — not vcad's
kernel or MCP embedding kerf. Every road leads to "integrate kerf," none
to "kerf inside vcad."

## Four load-bearing decisions

1. **The mandate compiles into the payment instrument.** At order time
   kerf debits its wallet and funds a **single-use virtual card**
   (Stripe Issuing): amount-capped at the authorized total plus a shipping
   tolerance, merchant-locked on first settlement, ~48 h expiry. kerf
   receives a card *reference*; a server-side workflow step resolves it
   and types the PAN via CDP — the number never enters any model context.
   A fully compromised agent cannot overspend: the failure domain is
   bounded by card economics, not model behavior. The settlement webhook
   doubles as an independent oracle that the vendor charged what the human
   authorized.
2. **Playbooks are data; the agent is the repair mechanism.** Versioned
   JSON step graphs (semantic selectors, recorded DOM fixtures, assertions
   on every money-adjacent step) execute deterministically — Tier 1. A
   computer-use agent (Tier 2) is summoned per failed step or for unknown
   vendors, and its second job is emitting a playbook patch as a PR with
   fresh fixtures. Daily quote-only canaries turn "brittle" into a
   measured SLO and auto-open repair jobs on drift. Tier 0 (a vendor's own
   stable XHR endpoints) exists as a per-vendor policy option, off by
   default.
3. **Checkout is a distributed transaction.** The buy click is two-phase:
   durably record the placing attempt + review-page evidence, click once,
   then confirm via **two independent oracles** — confirmation page,
   plus-addressed confirmation email, card settlement (any two; they share
   no failure mode). Ambiguity parks the job in `RECONCILING`, whose first
   move is scanning the vendor's order history and the inbox for the
   idempotency key (written into the vendor's PO/notes field when
   supported). The buy click is never blindly retried; a provably-absent
   order is re-attempted only as a *new* job.
4. **Autonomy is a per-vendor ladder, not a switch.** L0 structured
   handoff → **L1 assisted** (kerf uploads, configures, carts; the human
   clicks buy in the live view — near-zero ToS/anti-bot/payment risk, and
   ~95% of the friction removed) → L2 supervised (kerf clicks buy under
   mandate + card) → L3 standing mandates. Rungs are **policy**, earned by
   canary history and capped by the vendor manifest's `autonomy_ceiling`.
   A vendor that has declined automation stays pinned at L1 forever;
   that is a feature, and the exit ramp is conversion — order volume
   through kerf is the pitch for the API we wish they had, and browser
   adapters are designed to be retired into `api` transport gracefully.

## Stack: eve, fully adopted

kerf is an [eve](https://vercel.com/eve) project end to end (decision
2026-07-07: no framework hedging).

- **The Tier-2 operator is an eve agent** (`agent/` — filesystem-first:
  `instructions.md`, `tools/`, `skills/`, `schedules/`). Its toolset is
  capability-gated: it can `request_confirmation` and `request_takeover`;
  it has no buy-click tool and never sees payment data. Capability gating
  is workflow structure, not prompting.
- **Jobs are durable workflows** (`workflows/`). Every money-adjacent
  action is its own step — retried on infra failure, memoized once
  complete (a finished buy click never re-executes on replay), fully
  traced (the trace is a free chunk of the evidence bundle). **Hooks**
  suspend a run for out-of-band humans and webhooks; **sleep** spans
  production lead times. One durable run spans quote → delivery:

  | lifecycle moment | primitive |
  |---|---|
  | upload / configure / assert / extract | step (retried, memoized) |
  | human approves mandate (out-of-band) | hook ← kerf's approval surface |
  | CAPTCHA / 2FA / L1 buy click | hook ← human resolves in live view |
  | the L2 buy click | dedicated step, gated by the auditor step |
  | confirmation email | hook ← inbound-email webhook |
  | card settlement | hook ← Stripe Issuing webhook |
  | production + shipping | sleep (days–weeks) + tracking steps |
  | delivery | final steps emit the evidence bundle |

- **Canaries are eve schedules** (`agent/schedules/`).
- **The browser is a cloud `BrowserHost`** — Browser Use cloud first (the
  `@browser_use/eve` integration and template exist), alternates behind
  the same interface. Sessions persist by id independently of function
  invocations, so a suspended workflow reattaches via CDP on resume;
  live-view URLs give watch-and-takeover from any device; proxies and
  profile persistence are host features, not kerf code. Per-job domain
  allowlists (from the vendor manifest) are enforced at the session — the
  browser physically cannot navigate off-vendor.
- **Agent-facing surface: remote MCP** (quote/order/track/cancel jobs +
  live status) — the integration surface for the buyer agent. The vcad web
  app (the non-agent path) is a client of the same HTTP + signed-webhook
  job API. Both are *merchants* calling kerf; neither hosts it.

## Prompt-injection defense

The page is untrusted input. Layered: the operator carries a typed
`OrderIntent`, never a prose goal; a separate **auditor** step re-extracts
the review page and compares it against the intent before the workflow
enables the click (`kerf/intent-audit`); the session's domain allowlist is
enforced below the model; and the merchant-locked card bounds whatever
survives all of the above.

## Evidence → receipts

Per job, a hash-manifested `EvidenceBundle`: step trace, screenshots
(payment fields masked at capture), DOM snapshots of quote/review/
confirmation, the confirmation email, settlement record, tracking events.
The runtime feeds the vendor's file inputs, so it hashes the **exact
uploaded bytes in flight** — closing the chain
`design hash → file sha256 → uploaded-bytes sha256 → vendor order →
invoice → the box`. Oracle verdicts are `pass | fail | unverifiable` and
the house rule is fail-closed: an order whose confirmation could not be
scraped is *unverifiable*, never assumed. Oracles:
`kerf/upload-hash`, `kerf/quote-extraction`, `kerf/intent-audit`,
`kerf/confirmation-page`, `kerf/confirmation-email`,
`kerf/card-settlement`, `kerf/tracking`, `kerf/canary`.

## The registry

`packages/registry/<vendor>/` — data, not code: manifest (domains =
allowlist, processes, capability × transport matrix, autonomy ceiling,
vendor-native `config_schema`, canary spec with `budget_minor: 0` typed as
literal — canaries never spend), playbooks, fixtures. Vendors are
versioned packages; clients pin. Capability freshness ("green, verified
6 h ago") rides along with quotes. Three intent shapes cover every
commerce surface — `configurator` (SendCutSend, JLCPCB), `catalog`
(McMaster, DigiKey), `rfq` (email the job shop) — and three transports
(`browser`, `api`, `email`) satisfy the same contract, which is what
"order from every supplier across domains" cashes out to: transports ×
registry, not N bespoke integrations.

## The deterministic engine (`@kerf/engine`)

The Tier-1 runner that turns a recorded playbook into an executable,
assertion-checked run with **no model in the loop**. It talks to an
action-shaped `BrowserHost`/`BrowserSession` (navigate/click/fill/
selectByLabel/uploadFile/readText/readValue/screenshot) — never a vendor
SDK — so the browser substrate is swappable and the smart logic is testable
without a live browser. The engine owns: ValueRef/JSON-pointer resolution
(values flow intent→page, never page→decision), currency-anchored money
parsing (a bare "11" in "Jul 11" is not a price — returns null, not 0),
fail-closed assertion comparison, and the step loop. Every step's outcome
is one of `completed` / `aborted` (a money-adjacent assertion failed —
stop cold) / `needs_repair` (an `agent_repair` step failed → escalate to
Tier 2) / `needs_takeover` (an `await_hook` → escalate to a human). The
runner never guesses; a failure is always an escalation, never a proceed.

`runQuoteJob` wraps the runner with session lifecycle, `intentHash` (the
ACP-CM binding, key-order-invariant), and quote assembly, and `quoteFromRun`
maps a completed run to a `VendorQuote` with `pricing_basis: "quoted"` — and
refuses to fabricate a quote from any non-completed run. All of this is
covered by tests that drive the **real committed SCS playbook** to a $5.58
quote through a scripted model of the recorded flow, plus the abort and
escalate paths. What the tests do **not** prove is that the selectors match
live SCS or that a concrete `BrowserHost` drives real Chrome — only a live
run proves those, and that live run is the gate before the quote capability
is trusted beyond `unproven`.

## Roadmap

- **Wave 0** — *in progress.* Recorded SCS quote playbook ✓; deterministic
  engine + `runQuoteJob` + tests ✓; `quoteJob` workflow composing registry +
  engine ✓. **Remaining:** the concrete Browser Use CDP `BrowserHost` (build
  + verify against a live session), then a first live deterministic run to
  confirm selectors and flip the capability from `unproven` to `green` on
  merit. Then `quote` ships as a kerf MCP tool the buyer agent calls
  directly (no vcad broker adapter) — the agent designs in vcad, exports
  files, and calls kerf for a binding vendor price.
- **Wave 1** — L1 assisted checkout (staged cart, human clicks buy in the
  live view), inbound-email oracle, evidence bundles.
- **Wave 2** — L2: Stripe Issuing wired, auditor + one-shot placing step,
  two-oracle confirmation, `RECONCILING`, canaries live.
- **Wave 3** — OSH Cut (registry generalization proof), McMaster-Carr
  (first `catalog` vendor, simplest full money loop), JLCPCB at L1.
- **Wave 4** — email-RFQ transport, public registry + canary scoreboard,
  Tier-2 repair PRs fully automated.
