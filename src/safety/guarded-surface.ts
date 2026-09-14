import type { ActionResult, ActionTarget, Observation, Surface, SurfaceAction } from "../surface/types.js";
import type { AllowlistPolicy } from "../config/allowlist.js";

export class AllowlistViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistViolationError";
  }
}

/**
 * A click whose target matches an allowlist `riskyControls` rule (e.g. "Finish"/"Place order")
 * was attempted while risky actions are disallowed. Thrown rather than silently no-op'd so the
 * caller — the discovery loop, which converts any thrown error from `act()` into an ordinary
 * failed tool_result (see src/agent/loop.ts) — surfaces it to the model as an actionable reason
 * to call `escalate` instead of guessing its way past it.
 */
export class RiskyActionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskyActionBlockedError";
  }
}

export interface GuardedSurfaceOptions {
  /**
   * Default `false`: any click whose resolved target matches a risky-control rule is blocked
   * outright, never executed. This is the correct default for the discovery agent loop, which
   * runs autonomously with no prior human sign-off on what it's about to do — an irreversible
   * action (placing an order, deleting a record) must never happen just because a model decided
   * to click it.
   *
   * Set `true` only for a replay of an artifact whose risk was already adjudicated by a human
   * through the artifact's own approval workflow (`policy.riskLevel`/`status`, enforced by
   * `ReplayExecutor.enforceApprovalGate` before a single step runs — see src/replay/executor.ts).
   * `GuardedSurface` has no way to know an artifact was approved on its own; the caller
   * constructing this class for a replay run must say so explicitly, and only after that gate
   * has already passed.
   */
  allowRiskyActions?: boolean;
}

/**
 * Decorator around any `Surface` that enforces the allowlist boundary (§3.4) before delegating.
 * Both the discovery agent loop (Phase 4) and the replay executor (Phase 3) are constructed with
 * a `GuardedSurface`, never a raw `Surface` — so policy is enforced in exactly one place,
 * regardless of which path (LLM-driven or deterministic) is currently driving.
 *
 * Enforces two independent things, both centralized here rather than scattered across callers:
 *   1. The allowlist boundary — allowed domains and action types (Phase 1).
 *   2. Risky-action classification (this phase) — a click matching a configured risky-control
 *      rule is blocked unless the caller has explicitly opted in via `allowRiskyActions`.
 */
export class GuardedSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly policy: AllowlistPolicy,
    private readonly options: GuardedSurfaceOptions = {},
  ) {}

  async observe(): Promise<Observation> {
    return this.inner.observe();
  }

  async act(action: SurfaceAction): Promise<ActionResult> {
    if (!this.policy.isActionTypeAllowed(action.type)) {
      throw new AllowlistViolationError(`Action type "${action.type}" is not in the allowlist.`);
    }
    if (action.type === "navigate" && !this.policy.isDomainAllowed(action.url)) {
      throw new AllowlistViolationError(
        `Navigation target "${action.url}" is outside the allowed domains.`,
      );
    }
    if (action.type === "click" && !this.options.allowRiskyActions) {
      await this.enforceRiskyControlGate(action.target);
    }
    return this.inner.act(action);
  }

  async screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }

  currentUrl(): string {
    return this.inner.currentUrl();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * Classifying a `locator`-based target (replay) is free — a `LocatorSpec` already carries the
   * role/name it was built from, no extra round trip needed. Classifying a `ref`-based target
   * (discovery) costs one extra `observe()` call to resolve what that ephemeral ref currently
   * points to, since a bare ref carries no perception data of its own. That's an accepted,
   * deliberate cost: it only applies to clicks (the one action type risky controls are declared
   * against), not the hot path of every action, and correctness on a safety-critical check
   * matters more here than shaving a snapshot call.
   */
  private async enforceRiskyControlGate(target: ActionTarget): Promise<void> {
    const { role, name } =
      target.kind === "locator"
        ? { role: target.locator.role, name: target.locator.name }
        : await this.resolveRefRoleAndName(target.ref);

    const rule = this.policy.matchRiskyControl(role, name);
    if (rule) {
      throw new RiskyActionBlockedError(
        `Blocked a risky/irreversible action (target role="${role ?? "?"}" name="${name ?? "?"}"): ` +
          `${rule.description} This requires explicit human approval — either escalate to a human ` +
          "operator now, or (for a deterministic replay) run an artifact that has already been " +
          "reviewed and approved for this action.",
      );
    }
  }

  private async resolveRefRoleAndName(ref: string): Promise<{ role?: string; name?: string }> {
    const observation = await this.inner.observe();
    const node = observation.nodes.find((n) => n.ref === ref);
    return { role: node?.role, name: node?.name };
  }
}
