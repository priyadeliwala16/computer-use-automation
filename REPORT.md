# Design write-up

An LLM-driven discovery agent turns a natural-language goal into a typed, versioned **capability
artifact**; a deterministic **replay engine** executes that artifact in production with no model
in the loop; a resumable human-in-the-loop path handles what the system can't safely finish alone;
guardrails apply throughout. Target: [saucedemo.com](https://www.saucedemo.com), a stand-in for a
bank/credit-union back-office app.

## 1. Architecture

**Language/runtime**: TypeScript + Node.js. A typed language matters most at the two boundaries
this system straddles — the LLM's untrusted tool-call output, and the artifact schema a human
reviewer and a calling agent both depend on — and Playwright's TS-first API avoids a wrapper
layer. **Process model**: a single process per invocation (`discover`/`replay`), no queue, no
services — per §5, scaling infrastructure the problem doesn't need isn't rewarded, but the
abstractions below don't preclude adding it later.

**Modules** (`src/`): `agent/` (Claude-driven observe→decide→act loop, tools, prompt), `surface/`
(the `Surface` interface + its Playwright implementation + locator resolution), `artifact/`
(schema, filesystem store, recorder), `replay/` (deterministic executor + result contract),
`safety/` (policy decorator + redaction), `hitl/` (`ControlLock`, operator CLI), `evidence/`
(JSONL logging, screenshots), `config/` (env, allowlist), `cli/` (`discover`, `replay`).

Key decisions:

- **`Surface` is the one seam between "perceive/act" and everything else.** Both the discovery
  loop and the replay executor depend only on `observe()`/`act()`/`screenshot()`, never on
  Playwright directly — the extension point for §3.7 (§4 below).
- **`GuardedSurface` is a decorator, not logic inside `WebSurface`**, so policy is enforced in
  exactly one place regardless of which path — LLM-driven or deterministic — is driving.
- **Perception is an accessibility-tree/DOM snapshot, not screenshot+coordinates.** The LLM's
  "view" is a pruned tree of interactive/informative nodes (role, accessible name, text,
  `data-test*`, a structural CSS path) with short-lived `ref` IDs; screenshots are evidence only,
  never the decision input. This generalizes better to "no clean DOM": an accessibility tree
  exists even for non-semantic markup and native desktop apps, whereas coordinate-grounding
  depends on a vision model and breaks under any layout shift.
- **One tool per action** (`click`/`type`/`select`/`navigate`/`extract`, plus terminal
  `finish`/`escalate`), each requiring a `reasoning`/`reason` field — the structured "what and
  why" log (§3.5) falls directly out of the tool-call payload, no extraction pass needed.
- **Discovery and replay are fully separate paths**, sharing only `Surface`, `GuardedSurface`,
  locator resolution, and the artifact schema — mirroring the brief: the model discovers, the
  artifact is the capability, deterministic replay is how it's invoked in production.

## 2. Artifact schema

A `CapabilityArtifact` (`src/artifact/schema.ts`, Zod-validated): `id`/`version`/`schemaVersion`
(three independent axes — identity, recording generation, format — so bumping one never forces
another); `target: {app, baseUrl, surfaceType}` (the §3.7 seam); `provenance` (discovery run id,
timestamp, model — traceable without embedding the transcript); `inputs: ParamSpec[]` (the
agent-invocable calling contract — name, type, required, `redact`, description, an `example`
omitted whenever `redact` is true); `outputs: OutputSpec[]` (typed, each traced to the
`fromStepId` that produced it); `steps: Step[]` (action, `target: LocatorSpec`, `value:
ValueBinding` — literal or a reference to a named input, which is what makes a recording
*parameterized* — `locatorReasoning`, and `expected: ExpectedCondition[]`, the declared
non-happy-path branches); `checkpoint` (an assertion the flow actually reached the claimed state);
`policy`/`status` (the approval gate, §6).

**Why shaped this way**: decoupled from the raw transcript by construction — `recordArtifact` is
a pure, deterministic function of a `RunTrace`, no model calls of its own, so nothing in the
artifact is an LLM message or completion. Every field is either reviewable prose or typed data a
function-calling harness could bind directly — satisfying a human reviewer and a calling agent at
once shaped almost every naming choice. `expected[]` living on each *step* rather than as one
top-level handler is what lets the three-way outcome taxonomy (§3) be declared once at
review/approval time instead of re-derived ad hoc per caller.

## 3. Determinism & error handling

**Determinism**: replay never asks the model anything. Each `LocatorSpec` carries a ranked
`fallbackOrder` (`role` → `testId` → `text` → `css`); `resolveLocator` tries each against the
*live* page until exactly one visible element matches — never the ephemeral discovery-time `ref`.
Role+name is preferred first (survives DOM refactors); `testId` ranks below it despite usually
being more stable in principle, because legacy enterprise apps essentially never have one — a
strategy ordered around its presence would be the wrong default here. One nuance found by testing
live: an accessible name embedding a mutable count (saucedemo's cart icon, "Cart, 1 items") is
deprioritized below `testId` when both exist, since a role+name match that "sometimes" fails is
worse than one that predictably falls back. Waits are event-driven (a `framenavigated` listener
registered before any action that can trigger navigation), not fixed sleeps.

**Error handling** is a three-way union (`ReplayResult`), chosen because conflating "business
outcome" with "failure" is, per the brief, the most common mistake here:
- `success` — checkpoint held, typed outputs extracted.
- `business_outcome` — a legitimate anticipated result (e.g. "validation error", "locked out"),
  declared per-step and matched **unconditionally** after every step (even a successful one,
  since a business state is often reached via a perfectly successful click).
- `hard_failure` — anything unanticipated: an action that genuinely erred with no matching
  `expected[]` entry, or a declared *recoverable* condition (`dismiss`/`wait_and_continue`/
  `retry_step`, one bounded attempt) whose recovery didn't resolve it. A recoverable condition
  never reaches the caller if recovery succeeds.

`validateParams` distinguishes an explicit empty string from a missing key, so a caller can
deliberately exercise a "blank postal code" outcome (see `evidence/replay-runs/`). Caller/
programming errors (`ReplayInputValidationError`, `UnapprovedRiskyArtifactError`) are thrown, not
returned — contract violations, not runtime conditions, and keeping that split structural is what
keeps the two from blurring. UI drift is absorbed the same way as ordinary variance up to a point
— the fallback chain tolerates small changes; anything it can't resolve is a
`LocatorResolutionError` → `hard_failure`, correctly, since drift that severe needs a human to
re-review the artifact rather than be silently papered over.

## 4. Heterogeneity & multi-tenant

**Surface abstraction**: `Surface` is the only contract the loop and executor depend on.
`WebSurface` is the sole implementation, but a `LegacyWebSurface` (frames, tables, no test IDs) or
`DesktopSurface` (native OS accessibility APIs instead of a browser AX tree) would implement the
same interface — the crossing data shapes (`SnapshotNode`, `LocatorSpec`/`ActionTarget`) are
already technology-agnostic; role/name/text/a structural fallback exist on desktop accessibility
APIs too. `target.surfaceType` records which implementation a capability needs.

**Multi-tenant reuse**: the schema already separates vendor-product identity (`target.app`) from a
specific instance (`target.baseUrl`) — the right split for hundreds of tenants on ~20 shared
vendor apps. Not built (per §3.7's "design, not necessarily build"): a tenant-override layer —
one base artifact per `(app, flow)` plus a small per-tenant override object (`baseUrl`, and
optional per-step locator overrides keyed by tenant + step id), resolved at replay time, so a
rebranded/reconfigured tenant needs an override only for the steps that actually differ, not a
full re-recording.

**Drift detection**: `resolveLocator` already returns which strategy resolved a step
(`strategyUsed`) — unused today, but the right signal: aggregated across tenants on the same
app+version, a step that reliably resolved via `role` and starts consistently falling back to
`css` is an early warning the underlying app changed, before it produces a hard failure. Designed
for; no aggregation/alerting layer exists yet (§7).

## 5. Escalation & handoff

**Detecting "stuck"**: two triggers through one decision point (`onEscalate`) so callers never
special-case why — an explicit model `escalate` call, or an automatic dead-end (consecutive
failures, a malformed tool call, a text-only response). Both carry reason, whether explicit, the
current observation, and a snapshot of turns so far.

**Routing**: `discover`'s handler builds an `InterventionRequest` (goal, reason, current URL,
redacted recent steps, a CDP endpoint) and opens a `ControlLock` — a small `node:http` server on
an OS-assigned loopback port exposing `GET /intervention`, `POST /resume`, `POST /abort`.

**Taking control of the live session** — the part that had to be real, not mocked: `WebSurface`
launches Chromium with `--remote-debugging-port`; the operator CLI, run by a human in a second
terminal, attaches via `chromium.connectOverCDP(cdpEndpoint)`. Playwright's higher-level
`connect()` looked like the obvious fit first but (confirmed empirically, see
`tests/integration/hitl-handoff.test.ts`) gives each connection an isolated view of contexts —
only a CDP-level attach shares live state across independent processes. With
`PLAYWRIGHT_HEADLESS=false` by default, the same window is also visibly on screen, so a human can
just use the mouse instead of the CLI's scripted `goto`/`click`/`screenshot` commands.

**Handing control back**: `resume` clears the failure counter and continues from the next turn —
the model is told a human intervened and to re-observe, not given a bare "OK." `abort` ends the
run as `"escalated"`. `waitForOperator()` times out so an unresponsive human can't hang the
process. Context/evidence survive the handoff — the intervention request and evidence directory
are available to the operator without reading code, and resume/abort/timeout are all logged.

**Scope honored deliberately**: the operator surface is a CLI, not a real-time co-browsing
console (explicit brief scope-out). What's real underneath: pause, cede control of the *same*
session, resume, with one clear owner of control at each moment — proven against a live browser
in `tests/integration/hitl-handoff.test.ts`, not just described.

## 6. Safety

Both guardrails live in `GuardedSurface`, which both `discover` and `replay` construct their
`Surface` through — one enforcement point regardless of which path drives:

1. **Allowlist** (`config/allowlist.json`): explicit allowed domains (checked on `navigate`) and
   allowed action types. A violation throws `AllowlistViolationError`, unmissable in logs.
2. **Risky/irreversible actions**: a declarative rule list (role + name pattern, e.g. button
   `"Finish"`) matched against a click's resolved target. Default (`allowRiskyActions: false`)
   **blocks outright** — right for an autonomous run with no prior human sign-off — and the error
   explicitly suggests `escalate`. Replay only allows a risky click when the caller passes
   `allowRiskyActions: true`, which the `replay` CLI only does for an `"approved"` artifact — and
   even then `ReplayExecutor.enforceApprovalGate` independently refuses to *start* a
   risky+unapproved artifact before any step runs. Two independent checks, neither trusted alone.

**Sensitive data**: a param's `redact` flag is enforced at three points — the recorder never
bakes a redacted value in as a literal (it becomes a `{kind:"param"}` reference) and omits its
`example` entirely; every console/JSONL line in both CLIs passes through `redactSensitiveValues`
first; and `recordArtifact` runs a final sweep over the serialized artifact, refusing to record if
a declared secret appears anywhere. Deliberately narrow, not a general PII scrubber — it protects
only values explicitly named as sensitive, by exact match. Stated as a limit up front (§7), not
discovered later.

## 7. Cuts

**Worth calling out even though it's done, not cut**: the live discovery run
(`evidence/discovery-run/`) itself surfaced a real bug on its first attempt. The model's own
free-text `reasoning` for the password-entry step echoed the raw param value verbatim inside an
explanatory sentence; the console/JSONL log for that turn was correctly redacted, but
`recorder.ts` was copying the *raw* reasoning straight into the artifact's `locatorReasoning`
field. `assertNoLeakedSecrets` (defense in depth, built before any live model output existed to
test it against) caught it and refused to record rather than ship a leak. Fixed by redacting
free-text reasoning at the one point it becomes part of an artifact, with regression tests added
in `tests/unit/recorder.test.ts`. This is the clearest argument in this whole project for why
the brief insists the discovery run be genuine: no scripted/mocked test would ever have produced
this exact failure mode, because nothing scripted echoes a secret back inside a sentence the way
a real model occasionally will.

**Scoped out per the brief's own notes**: the HITL operator surface is a CLI, not a co-browsing
console; multi-tenant overrides and cross-tenant drift detection are designed for (§4 — the
`app`/`baseUrl` split and `strategyUsed` signal both support it) but not built; a second `Surface`
implementation (legacy web or desktop) is designed for but not built — only `WebSurface` exists.

**Cut for time**: none of the §8 stretch goals are implemented (capability catalog, code
generation, confidence scoring beyond the binary draft/approved gate already built, assisted
fallback, canonicalization, multi-run stability) — depth on the required core was prioritized over
breadth into optional ones. Evidence is one screenshot per turn/outcome plus a JSONL log, no full
trace or DOM snapshot, though `EvidenceSink` is an interface specifically so a richer sink could
be added without touching the loop or executor. Locator resolution has no self-healing beyond the
four-strategy fallback — a target failing all four is correctly a `hard_failure`, not a "try
harder" loop. Only one real target app was exercised; §4's generalization claims are argued from
the abstraction's shape, not proven against a second, differently-built surface.

**Next, in order**: (1) a small second `Surface` — a hand-built legacy-style page (frames,
tables, no test IDs) — to prove the abstraction holds under a second real implementation rather
than just arguing it does; (2) the drift-detection aggregation in §4, since the signal already
exists and just isn't collected anywhere yet; (3) approve the freshly-recorded artifact in
`artifacts/` (add its happy-path `expected[]` branches, flip `status` to `"approved"`) so it,
not just the hand-authored one in `evidence/artifacts/`, is what a real replay caller would use.
