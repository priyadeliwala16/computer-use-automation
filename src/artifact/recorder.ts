import type { AllowlistPolicy } from "../config/allowlist.js";
import type { RunTrace, RunTraceTurn } from "../agent/run-trace.js";
import type { AgentToolCall } from "../agent/tools.js";
import { buildLocatorSpec, type LocatorSpec } from "../surface/locator.js";
import { redactSensitiveValues } from "../safety/redaction.js";
import type {
  CapabilityArtifact,
  CapabilityArtifactInput,
  OutputSpec,
  ParamSpec,
  Step,
  ValueBinding,
} from "./schema.js";
import { parseCapabilityArtifact } from "./schema.js";

export class RecorderError extends Error {}

export interface RecorderOptions {
  /** Stable capability id, e.g. "saucedemo.add_item_and_checkout". Not derived automatically —
   *  naming a capability is a human/product decision, same as naming a function. */
  capabilityId: string;
  /** Which recording of this capability this is. Callers resolve this via
   *  `ArtifactStore.nextVersion(capabilityId)` — the recorder itself is a pure function of its
   *  inputs and doesn't touch the filesystem, so it stays trivially unit-testable. */
  version: number;
  name: string;
  description: string;
  /** The seam for §3.7 — today only "web" surfaces exist (WebSurface/Playwright). */
  surfaceType: "web" | "legacy-web" | "desktop";
}

/**
 * Turns a completed `RunTrace` into a `CapabilityArtifact` (§3.2). This is a mechanical,
 * deterministic transformation — no LLM involved — which is exactly the point: everything the
 * replay engine later depends on must be derivable without asking a model anything again.
 *
 * Three things this function deliberately does NOT do, all left for a human reviewer per the
 * brief's "reviewable" framing:
 *   1. It never adds `expected[]` conditions to a step. Discovery only ever demonstrates the
 *      happy path it actually walked; declaring exceptional branches (a validation error, a
 *      locked-out account) is curation a human adds afterward, by editing the artifact's JSON.
 *   2. Its `checkpoint` is a best-effort default (URL-contains-the-final-path), not a
 *      considered assertion — flagged in the artifact's `status: "draft"` until a human tightens
 *      or confirms it.
 *   3. Risk classification only ever escalates `requiresApproval` — it never grants approval.
 *      Every recorded artifact starts life as `status: "draft"`.
 */
export function recordArtifact(
  runTrace: RunTrace,
  policy: AllowlistPolicy,
  options: RecorderOptions,
): CapabilityArtifact {
  if (runTrace.status !== "completed") {
    throw new RecorderError(
      `Cannot record capability "${options.capabilityId}" from a run with status "${runTrace.status}" — ` +
        `only a run that ended by calling "finish" demonstrates a repeatable happy path.`,
    );
  }

  const actionTurns = runTrace.turns.filter((t) => t.toolCall.name !== "finish" && t.toolCall.name !== "escalate");
  if (actionTurns.length === 0) {
    throw new RecorderError(
      `Run "${runTrace.runId}" completed without performing any actions — nothing to record.`,
    );
  }

  const usedParamNames = new Set<string>();
  let risky = false;

  const steps: Step[] = actionTurns.map((turn, i) => {
    const step = buildStep(turn, i, runTrace.paramHints, usedParamNames);
    if (isRiskyStep(step, policy)) risky = true;
    return step;
  });

  const outputs: OutputSpec[] = actionTurns
    .map((turn, i) =>
      turn.toolCall.name === "extract" ? buildOutput(turn.toolCall, steps[i]!.id, runTrace.paramHints) : undefined,
    )
    .filter((o): o is OutputSpec => o !== undefined);

  // Only the params a step actually bound to are declared as inputs — an artifact's I/O
  // contract should describe what the flow consumes, not everything the human happened to type
  // on the command line when demonstrating it (some of which may never have been used).
  const inputs: ParamSpec[] = runTrace.paramHints
    .filter((hint) => usedParamNames.has(hint.name))
    .map((hint) => ({
      name: hint.name,
      type: "string",
      required: true,
      redact: hint.redact,
      description: hint.description ?? `Value used for "${hint.name}" (captured during discovery).`,
      // `example` exists to help a future caller of this artifact understand what kind of value
      // is expected — never worth leaking the actual secret for. A redacted param gets no
      // example at all rather than a fake-looking placeholder, so nobody mistakes it for real
      // guidance about the value's shape.
      example: hint.redact ? undefined : hint.value,
    }));

  const artifactInput: CapabilityArtifactInput = {
    id: options.capabilityId,
    version: options.version,
    schemaVersion: "1.0",
    name: options.name,
    description: options.description,
    target: {
      app: runTrace.target.app,
      baseUrl: runTrace.target.baseUrl,
      surfaceType: options.surfaceType,
    },
    provenance: {
      discoveryRunId: runTrace.runId,
      recordedAt: new Date().toISOString(),
      model: runTrace.model,
    },
    inputs,
    outputs,
    steps,
    checkpoint: buildCheckpoint(runTrace),
    policy: { riskLevel: risky ? "risky" : "safe", requiresApproval: risky },
    status: "draft",
  };

  const artifact = parseCapabilityArtifact(artifactInput);
  assertNoLeakedSecrets(artifact, runTrace.paramHints);
  return artifact;
}

/**
 * Defense in depth, on top of `bindValue`'s param-matching: the normal path never puts a
 * `redact`-flagged value into the artifact at all (it becomes a `{kind:"param"}` reference
 * instead — see `bindValue`), but nothing above proves that's the *only* way a raw secret could
 * end up somewhere in the recorded JSON (a step's literal falling back because the model typed
 * something merely containing the value rather than exactly matching it; a reasoning string
 * echoed into an output's description; etc.). This is a final, blanket check across the fully
 * serialized artifact — if a declared secret shows up anywhere, refuse to record rather than
 * silently ship a leak into a file meant to be safely reviewable and shareable.
 */
function assertNoLeakedSecrets(artifact: CapabilityArtifact, paramHints: RunTrace["paramHints"]): void {
  const serialized = JSON.stringify(artifact);
  for (const hint of paramHints) {
    if (hint.redact && hint.value && serialized.includes(hint.value)) {
      throw new RecorderError(
        `Refusing to record capability "${artifact.id}": the sensitive value declared for param ` +
          `"${hint.name}" appears verbatim somewhere in the recorded artifact. This should be ` +
          "impossible via the normal typed/selected-value parameterization path — investigate the " +
          "run trace before recording.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step construction
// ---------------------------------------------------------------------------

function buildStep(
  turn: RunTraceTurn,
  index: number,
  paramHints: RunTrace["paramHints"],
  usedParamNames: Set<string>,
): Step {
  const toolCall = turn.toolCall;
  const id = `step-${index + 1}-${toolCall.name}`;

  if (toolCall.name === "navigate") {
    return {
      id,
      action: "navigate",
      value: { kind: "literal", value: toolCall.url },
      locatorReasoning: redactReasoning(toolCall.reasoning, paramHints),
      expected: [],
    };
  }

  const target = buildTarget(turn);
  const reasoning = "reasoning" in toolCall ? redactReasoning(toolCall.reasoning, paramHints) : undefined;

  switch (toolCall.name) {
    case "click":
      return { id, action: "click", target, locatorReasoning: reasoning, expected: [] };
    case "extract":
      return { id, action: "extract", target, locatorReasoning: reasoning, expected: [] };
    case "type":
      return {
        id,
        action: "type",
        target,
        value: bindValue(toolCall.text, paramHints, usedParamNames),
        locatorReasoning: reasoning,
        expected: [],
      };
    case "select":
      return {
        id,
        action: "select",
        target,
        value: bindValue(toolCall.value, paramHints, usedParamNames),
        locatorReasoning: reasoning,
        expected: [],
      };
    case "finish":
    case "escalate":
      // Unreachable: `recordArtifact` filters these out before calling `buildStep`. Handled
      // here only so the switch above is exhaustive from the type checker's point of view.
      throw new RecorderError(`buildStep should never be called with the terminal tool "${toolCall.name}"`);
  }
}

/**
 * The model's own free-text `reasoning`/`reason` on a tool call is untrusted the same way its
 * `ref`/`text`/`value` fields are — nothing stops it from echoing an example value verbatim
 * inside an explanatory sentence (observed in practice: "Now I need to enter the password
 * \"secret_sauce\" into the password field..." — the console/JSONL log for that turn is
 * correctly redacted via this same function, but the *raw* `toolCall.reasoning` is what
 * `buildStep`/`buildOutput` persist into the artifact's `locatorReasoning`/`description` fields
 * unless it's passed through this first). Redacting here — at the one place free-text model
 * output becomes part of a `Step`/`OutputSpec` — is what `assertNoLeakedSecrets` below is
 * defense in depth *for*, not a replacement for it: this catches the literal case; that catches
 * anything this doesn't.
 */
function redactReasoning(text: string, paramHints: RunTrace["paramHints"]): string {
  return redactSensitiveValues(text, paramHints);
}

function buildTarget(turn: RunTraceTurn): LocatorSpec {
  if (!turn.targetNode) {
    throw new RecorderError(
      `Step ${turn.index} (${turn.toolCall.name}) has no captured target node — the ref the model ` +
        "used didn't match anything in that turn's observation. This indicates a bug in the " +
        "discovery loop's bookkeeping (see findTargetNode in src/agent/loop.ts), not a bad run.",
    );
  }
  return buildLocatorSpec(turn.targetNode);
}

/**
 * The deterministic parameterization step described in the discovery prompt's design (see
 * src/agent/prompt.ts): if the concrete value typed/selected during discovery exactly matches
 * one of the example values the human declared up front, bind the step to that named parameter
 * instead of baking in the literal. Anything else recorded is either genuinely fixed for this
 * capability (e.g. a search filter that's always the same) or wasn't anticipated as variable —
 * either way, keeping it literal is the safe default, reviewable and editable in the JSON.
 */
function bindValue(
  raw: string,
  paramHints: RunTrace["paramHints"],
  usedParamNames: Set<string>,
): ValueBinding {
  const hint = paramHints.find((h) => h.value === raw);
  if (!hint) return { kind: "literal", value: raw };
  usedParamNames.add(hint.name);
  return { kind: "param", param: hint.name };
}

function isRiskyStep(step: Step, policy: AllowlistPolicy): boolean {
  if (!step.target) return false;
  return Boolean(policy.matchRiskyControl(step.target.role, step.target.name));
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function buildOutput(
  toolCall: Extract<AgentToolCall, { name: "extract" }>,
  stepId: string,
  paramHints: RunTrace["paramHints"],
): OutputSpec {
  return {
    name: toolCall.label,
    // Discovery only ever reads text via Surface#extract, which always yields a string — a
    // human reviewer can retype this to "number"/"boolean" in the artifact JSON if the captured
    // value is more usefully typed that way for callers.
    type: "string",
    fromStepId: stepId,
    description: redactReasoning(toolCall.reasoning, paramHints),
  };
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/**
 * Best-effort default checkpoint: the final URL's path segment, which is usually meaningful
 * (e.g. `/checkout-complete.html`) even when the rest of the page's content is dynamic. Falls
 * back to the full URL if the path is just "/", which is too generic to assert on. This is
 * intentionally the weakest part of the automatically-recorded artifact — see this function's
 * module doc comment — and is exactly what a human reviewer should look at first.
 */
function buildCheckpoint(runTrace: RunTrace): CapabilityArtifact["checkpoint"] {
  const url = new URL(runTrace.finalUrl);
  const value = url.pathname && url.pathname !== "/" ? url.pathname : runTrace.finalUrl;
  return {
    description: `Reached ${runTrace.finalUrl} after completing: "${runTrace.goal}" (auto-derived — review before approving this capability).`,
    assertion: { kind: "urlContains", value },
  };
}
