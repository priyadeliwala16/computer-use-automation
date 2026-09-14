import type {
  CapabilityArtifact,
  ExpectedCondition,
  PrimitiveType,
  StateAssertion,
  Step,
  ValueBinding,
} from "../artifact/schema.js";
import type { LocatorSpec } from "../surface/locator.js";
import type { ActionResult, Surface } from "../surface/types.js";
import type { EvidenceSink } from "../evidence/types.js";
import { NullEvidenceSink } from "../evidence/types.js";
import type { ReplayResult } from "./outcomes.js";
import { ReplayInputValidationError, UnapprovedRiskyArtifactError } from "./outcomes.js";

export type ReplayParams = Record<string, string | number | boolean>;

export interface StepLogEvent {
  stepId: string;
  action: string;
  ok: boolean;
  error?: string;
  matchedExpected?: { classification: string; outcomeCode?: string };
}

export interface ReplayExecutorOptions {
  evidenceSink?: EvidenceSink;
  /** Structured per-step log hook (§3.5). Phase 7 wires this to the real JSONL run logger; unset
   *  is a legitimate mode (e.g. tests that don't care about logging). */
  /** Awaited after each call, same rationale as `DiscoveryLoopOptions.onTurn` in
   *  src/agent/loop.ts: a caller persisting this to a structured log shouldn't have its writes
   *  race the executor moving on to the next step. */
  onStep?: (event: StepLogEvent) => void | Promise<void>;
}

/**
 * Executes a `CapabilityArtifact` against a live `Surface` with no LLM in the loop (§3.3). See
 * src/replay/outcomes.ts for the result contract this produces.
 *
 * Execution order per step, and why: run the action -> record any `extract`ed value -> check the
 * step's declared `expected[]` conditions -> only THEN treat a raw action failure as a hard
 * failure. This ordering matters: an anticipated business outcome (e.g. a validation banner
 * appearing) is often reached via a perfectly successful click — the interaction worked exactly
 * as automated, it's the resulting *state* that differs from the happy path. Checking `expected`
 * unconditionally (not just when the action itself failed) is what makes that distinction land
 * correctly instead of being reported as a mechanical failure.
 */
export class ReplayExecutor {
  constructor(
    private readonly surface: Surface,
    private readonly options: ReplayExecutorOptions = {},
  ) {}

  async run(artifact: CapabilityArtifact, params: ReplayParams): Promise<ReplayResult> {
    this.validateParams(artifact, params);
    this.enforceApprovalGate(artifact);

    await this.surface.act({ type: "navigate", url: artifact.target.baseUrl });

    const extracted: Record<string, string> = {};

    for (const step of artifact.steps) {
      const actionResult = await this.executeStep(step, params);
      await this.options.onStep?.({ stepId: step.id, action: step.action, ok: actionResult.ok, error: actionResult.error });

      if (step.action === "extract" && actionResult.ok) {
        extracted[step.id] = actionResult.extractedValue ?? "";
      }

      const matched = await this.matchExpectedCondition(step);
      if (matched) {
        await this.options.onStep?.({
          stepId: step.id,
          action: step.action,
          ok: true,
          matchedExpected: { classification: matched.classification, outcomeCode: matched.outcomeCode },
        });

        if (matched.classification === "business_outcome") {
          return {
            kind: "business_outcome",
            outcomeCode: matched.outcomeCode ?? "unknown_business_outcome",
            description: matched.description,
            stepId: step.id,
            evidenceId: await this.captureEvidence(`business_outcome:${matched.outcomeCode}`),
          };
        }

        const recovered = await this.recover(step, matched, params);
        if (!recovered) {
          return {
            kind: "hard_failure",
            stepId: step.id,
            expected: `Recovery ("${matched.recovery}") to resolve: ${matched.description}`,
            observed: "Condition was still present after attempting the declared recovery.",
            evidenceId: await this.captureEvidence(`recovery_failed:${step.id}`),
          };
        }
        continue;
      }

      if (!actionResult.ok) {
        return {
          kind: "hard_failure",
          stepId: step.id,
          expected: `Action "${step.action}" on step "${step.id}" to succeed`,
          observed: actionResult.error ?? "Unknown error",
          evidenceId: await this.captureEvidence(`hard_failure:${step.id}`),
        };
      }
    }

    const checkpointOk = await this.checkAssertion(artifact.checkpoint.assertion);
    if (!checkpointOk) {
      return {
        kind: "hard_failure",
        stepId: "checkpoint",
        expected: artifact.checkpoint.description,
        observed: `Checkpoint assertion did not hold after all steps completed: ${JSON.stringify(artifact.checkpoint.assertion)}`,
        evidenceId: await this.captureEvidence("checkpoint_failed"),
      };
    }

    return {
      kind: "success",
      outputs: this.buildOutputs(artifact, extracted),
      evidenceId: await this.captureEvidence("success"),
    };
  }

  // -------------------------------------------------------------------------
  // Guard rails around the run itself
  // -------------------------------------------------------------------------

  /**
   * "Required" is a *contract* check (did the caller supply this key at all?), not a value
   * check. An explicitly-supplied empty string is a legitimate, intentional input — e.g. testing
   * that a blank postal code produces the artifact's declared "validation_error" business
   * outcome — and must be allowed through to the surface rather than rejected here as if it were
   * never provided. Conflating "absent" with "empty" would silently convert exactly the kind of
   * runtime condition §3.3 asks us to surface into a caller-side error instead.
   */
  private validateParams(artifact: CapabilityArtifact, params: ReplayParams): void {
    for (const input of artifact.inputs) {
      const value = params[input.name];
      if (value === undefined) {
        if (input.required) {
          throw new ReplayInputValidationError(
            `Missing required input "${input.name}" (${input.description})`,
          );
        }
        continue;
      }
      if (typeof value !== input.type) {
        throw new ReplayInputValidationError(
          `Input "${input.name}" expected type "${input.type}" but received "${typeof value}"`,
        );
      }
    }
  }

  private enforceApprovalGate(artifact: CapabilityArtifact): void {
    if (artifact.policy.riskLevel === "risky" && artifact.policy.requiresApproval && artifact.status !== "approved") {
      throw new UnapprovedRiskyArtifactError(
        `Capability "${artifact.id}" v${artifact.version} is classified risky and requires ` +
          `approval before it can run unattended (status is "${artifact.status}").`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step execution
  // -------------------------------------------------------------------------

  private async executeStep(step: Step, params: ReplayParams): Promise<ActionResult> {
    switch (step.action) {
      case "navigate":
        return this.surface.act({ type: "navigate", url: this.resolveValue(step.value, params) });
      case "click":
        return this.surface.act({ type: "click", target: { kind: "locator", locator: this.requireTarget(step) } });
      case "type":
        return this.surface.act({
          type: "type",
          target: { kind: "locator", locator: this.requireTarget(step) },
          text: this.resolveValue(step.value, params),
        });
      case "select":
        return this.surface.act({
          type: "select",
          target: { kind: "locator", locator: this.requireTarget(step) },
          value: this.resolveValue(step.value, params),
        });
      case "extract":
        return this.surface.act({ type: "extract", target: { kind: "locator", locator: this.requireTarget(step) } });
      case "waitFor":
        return this.surface.act({
          type: "waitFor",
          target: step.target ? { kind: "locator", locator: step.target } : undefined,
          ms: step.timeoutMs,
        });
    }
  }

  private requireTarget(step: Step): LocatorSpec {
    if (!step.target) {
      throw new Error(`Malformed artifact: step "${step.id}" (${step.action}) has no target locator.`);
    }
    return step.target;
  }

  private resolveValue(value: ValueBinding | undefined, params: ReplayParams): string {
    if (!value) {
      throw new Error("Malformed artifact: step requires a value binding but none is set.");
    }
    if (value.kind === "literal") return value.value;
    const paramValue = params[value.param];
    if (paramValue === undefined) {
      throw new ReplayInputValidationError(`Missing required input "${value.param}"`);
    }
    return String(paramValue);
  }

  // -------------------------------------------------------------------------
  // Expected-condition matching + recovery
  // -------------------------------------------------------------------------

  private async matchExpectedCondition(step: Step): Promise<ExpectedCondition | undefined> {
    for (const condition of step.expected) {
      if (await this.checkAssertion(condition.detect)) {
        return condition;
      }
    }
    return undefined;
  }

  private async checkAssertion(assertion: StateAssertion): Promise<boolean> {
    switch (assertion.kind) {
      case "urlContains":
        return this.surface.currentUrl().includes(assertion.value);
      case "textVisible": {
        const result = await this.surface.act({
          type: "extract",
          target: { kind: "locator", locator: { text: assertion.value, fallbackOrder: ["text"] } },
        });
        return result.ok;
      }
      case "locatorVisible": {
        const result = await this.surface.act({
          type: "extract",
          target: { kind: "locator", locator: assertion.locator },
        });
        return result.ok;
      }
    }
  }

  /** Attempts the recovery declared on an `ExpectedCondition`. Returns whether the condition no
   *  longer holds afterward — a single bounded attempt, never open-ended retrying, per §3.3's
   *  requirement to respond deliberately rather than blindly proceeding. */
  private async recover(step: Step, condition: ExpectedCondition, params: ReplayParams): Promise<boolean> {
    switch (condition.recovery) {
      case "dismiss": {
        if (condition.recoveryTarget) {
          await this.surface.act({ type: "click", target: { kind: "locator", locator: condition.recoveryTarget } });
        }
        return !(await this.checkAssertion(condition.detect));
      }
      case "wait_and_continue": {
        await this.surface.act({ type: "waitFor", ms: 1000 });
        return !(await this.checkAssertion(condition.detect));
      }
      case "retry_step": {
        const retryResult = await this.executeStep(step, params);
        return retryResult.ok && !(await this.checkAssertion(condition.detect));
      }
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Outputs + evidence
  // -------------------------------------------------------------------------

  private buildOutputs(
    artifact: CapabilityArtifact,
    extracted: Record<string, string>,
  ): Record<string, string | number | boolean> {
    const outputs: Record<string, string | number | boolean> = {};
    for (const output of artifact.outputs) {
      const raw = extracted[output.fromStepId];
      if (raw === undefined) {
        throw new Error(
          `Malformed artifact: output "${output.name}" expects data from step "${output.fromStepId}", ` +
            "but that step never ran or wasn't an extract step.",
        );
      }
      outputs[output.name] = this.coerce(raw, output.type);
    }
    return outputs;
  }

  private coerce(raw: string, type: PrimitiveType): string | number | boolean {
    if (type === "string") return raw;
    if (type === "number") {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        throw new Error(`Expected a numeric output but extracted "${raw}"`);
      }
      return parsed;
    }
    return raw.trim().toLowerCase() === "true";
  }

  private async captureEvidence(reason: string): Promise<string> {
    const sink = this.options.evidenceSink ?? new NullEvidenceSink();
    return sink.capture(reason);
  }
}
