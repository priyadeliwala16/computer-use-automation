import { z } from "zod";
import { LocatorSpecSchema } from "../surface/locator.js";
import { SURFACE_ACTION_TYPES } from "../surface/types.js";

/**
 * The capability artifact is the central contract of this system (§3.2): a typed, versioned,
 * reviewable description of a flow that an AI agent can invoke without the LLM in the loop, and
 * that a human reviewer can read and understand. Every design choice below is in service of
 * that dual audience.
 */

// ---------------------------------------------------------------------------
// Typed I/O contract
// ---------------------------------------------------------------------------

export const PrimitiveTypeSchema = z.enum(["string", "number", "boolean"]);
export type PrimitiveType = z.infer<typeof PrimitiveTypeSchema>;

export const ParamSpecSchema = z.object({
  name: z.string(),
  type: PrimitiveTypeSchema,
  required: z.boolean().default(true),
  /** Never logged or persisted in raw form anywhere (RunTrace, artifact examples, evidence).
   *  See src/safety/redaction.ts — this flag is the single source of truth redaction reads from. */
  redact: z.boolean().default(false),
  description: z.string(),
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z.object({
  name: z.string(),
  type: PrimitiveTypeSchema,
  /** Which step's `extract` produced this — traceability from output back to the step that
   *  computed it, useful when debugging a replay that returned an unexpected value. */
  fromStepId: z.string(),
  description: z.string(),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** A step's `value` is either a literal captured at record time, or a binding to one of the
 *  artifact's declared `inputs` — this is what makes a recorded flow *parameterized* rather than
 *  a fixed replay of exactly what happened during discovery. */
export const ValueBindingSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), param: z.string() }),
]);
export type ValueBinding = z.infer<typeof ValueBindingSchema>;

/** Ways of detecting a condition on the page after a step runs. Reused by both per-step
 *  `expected[]` entries and the artifact-level `checkpoint`. */
export const StateAssertionSchema = z.union([
  z.object({ kind: z.literal("locatorVisible"), locator: LocatorSpecSchema }),
  z.object({ kind: z.literal("urlContains"), value: z.string() }),
  z.object({ kind: z.literal("textVisible"), value: z.string() }),
]);
export type StateAssertion = z.infer<typeof StateAssertionSchema>;

/**
 * An anticipated non-happy-path condition a step might land in. This is what lets the replay
 * executor distinguish, per §3.3:
 *   - business_outcome: a legitimate answer the caller needs (e.g. "user is locked out").
 *   - recoverable: something the executor itself resolves and continues past (e.g. dismiss a
 *     known interstitial, or wait and retry once).
 * Anything that occurs but was NOT declared here surfaces as a hard_failure — see
 * src/replay/outcomes.ts. Declaring these is a curation act: discovery captures the happy path;
 * a human reviewer (or a future assisted-fallback pass — see REPORT.md §7) adds the exceptional
 * branches, exactly as the brief frames "reviewable."
 */
export const ExpectedConditionSchema = z.object({
  description: z.string(),
  detect: StateAssertionSchema,
  classification: z.enum(["business_outcome", "recoverable"]),
  /** Required for business_outcome: a stable, machine-readable code the calling agent can
   *  branch on (e.g. "user_locked_out"), independent of the human-readable description. */
  outcomeCode: z.string().optional(),
  /** Required for recoverable: what the executor should do before re-checking the checkpoint. */
  recovery: z.enum(["dismiss", "retry_step", "wait_and_continue"]).optional(),
  /** For "dismiss"/retry_step: which control to act on (e.g. the interstitial's close button). */
  recoveryTarget: LocatorSpecSchema.optional(),
});
export type ExpectedCondition = z.infer<typeof ExpectedConditionSchema>;

export const StepActionTypeSchema = z.enum(SURFACE_ACTION_TYPES);

export const StepSchema = z.object({
  id: z.string(),
  action: StepActionTypeSchema,
  /** Omitted for `navigate` (the destination is the value) and timer-only `waitFor`. */
  target: LocatorSpecSchema.optional(),
  value: ValueBindingSchema.optional(),
  /** Captured at record time: why this locator strategy chain was chosen for this control.
   *  Human-reviewable, per §3.2's "reasoning about robustness" requirement. */
  locatorReasoning: z.string().optional(),
  expected: z.array(ExpectedConditionSchema).default([]),
  timeoutMs: z.number().int().positive().optional(),
});
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export const CheckpointSchema = z.object({
  description: z.string(),
  assertion: StateAssertionSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const RiskLevelSchema = z.enum(["safe", "risky"]);
export const ArtifactStatusSchema = z.enum(["draft", "approved"]);

export const PolicySchema = z.object({
  riskLevel: RiskLevelSchema,
  /** Draft/approved gate (§8 stretch: confidence & approval). An artifact whose riskLevel is
   *  "risky" AND whose status is "draft" cannot run unattended — see src/replay/executor.ts. */
  requiresApproval: z.boolean(),
});
export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const CapabilityArtifactSchema = z.object({
  id: z.string().describe("Stable capability id, e.g. 'saucedemo.add_item_and_checkout'"),
  version: z.number().int().positive(),
  /** Artifact *format* version — decoupled from `version` (which tracks recordings of this
   *  capability). Bump this only when the shape of the artifact itself changes. */
  schemaVersion: z.literal("1.0"),
  name: z.string(),
  description: z.string(),
  target: z.object({
    app: z.string(),
    baseUrl: z.string().url(),
    /** The seam for §3.7 — see WebSurface vs. a future LegacyWebSurface/DesktopSurface. */
    surfaceType: z.enum(["web", "legacy-web", "desktop"]),
  }),
  provenance: z.object({
    discoveryRunId: z.string(),
    recordedAt: z.string(),
    model: z.string(),
  }),
  inputs: z.array(ParamSpecSchema),
  outputs: z.array(OutputSpecSchema),
  steps: z.array(StepSchema).min(1),
  checkpoint: CheckpointSchema,
  policy: PolicySchema,
  status: ArtifactStatusSchema,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
/** Pre-default shape (e.g. `step.expected` optional rather than required-with-default) — use
 *  this when hand-constructing an artifact literal in code (fixtures, the recorder); use
 *  `CapabilityArtifact` for anything already validated/loaded. */
export type CapabilityArtifactInput = z.input<typeof CapabilityArtifactSchema>;

export function parseCapabilityArtifact(data: unknown): CapabilityArtifact {
  const result = CapabilityArtifactSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid capability artifact: ${result.error.message}`);
  }
  return result.data;
}
