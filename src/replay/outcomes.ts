/**
 * The replay contract (§3.3). This is deliberately a discriminated union, not a boolean plus an
 * error field bolted on afterward — the brief calls conflating "business outcome" with "failure"
 * the most common design mistake here, and a union makes that conflation a type error rather
 * than a judgment call made ad hoc at each call site.
 *
 *  - success: the artifact's checkpoint held, with declared outputs extracted and typed.
 *  - business_outcome: a legitimate, anticipated answer that isn't the happy path (e.g. "user is
 *    locked out", "validation error: postal code required"). Not a bug, not a crash — the caller
 *    (an AI agent, in production) needs this to make its own next decision.
 *  - hard_failure: something the artifact did not anticipate. Carries exactly what a debugging
 *    engineer needs: which step, what was expected, what was actually observed.
 *
 * What is intentionally NOT part of this union: transient/recoverable conditions (a known
 * interstitial, a slow load). Those are resolved *inside* the executor (see
 * ExpectedCondition.classification === "recoverable" in src/artifact/schema.ts) and never
 * surface to the caller at all if recovery succeeds — only if recovery itself fails do they
 * become a hard_failure. A caller should never have to write retry logic for a condition the
 * artifact already knew how to handle.
 */
export type ReplayResult =
  | {
      kind: "success";
      outputs: Record<string, string | number | boolean>;
      evidenceId: string;
    }
  | {
      kind: "business_outcome";
      outcomeCode: string;
      description: string;
      stepId: string;
      evidenceId: string;
    }
  | {
      kind: "hard_failure";
      stepId: string;
      expected: string;
      observed: string;
      evidenceId: string;
    };

/** Caller/programming errors — invalid input, or an artifact that isn't allowed to run
 *  unattended. Thrown, not returned, because these are contract violations by the caller, not
 *  runtime conditions encountered while operating the target application. Conflating these two
 *  categories would be exactly the mistake the ReplayResult union above is designed to avoid. */
export class ReplayInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayInputValidationError";
  }
}

export class UnapprovedRiskyArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedRiskyArtifactError";
  }
}
