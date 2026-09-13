import type { ActionResult, Observation, Surface, SurfaceAction } from "../surface/types.js";
import { AllowlistPolicy } from "../config/allowlist.js";

export class AllowlistViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistViolationError";
  }
}

/**
 * Decorator around any `Surface` that enforces the allowlist boundary (§3.4) before delegating.
 * Both the discovery agent loop (Phase 4) and the replay executor (Phase 3) are constructed with
 * a `GuardedSurface`, never a raw `Surface` — so the policy is enforced in exactly one place,
 * regardless of which path (LLM-driven or deterministic) is currently driving.
 *
 * Risk classification (safe/reversible vs. risky/irreversible) is layered on top of this same
 * choke point in Phase 6 — this class currently enforces the allowlist (domain + action type)
 * boundary; `act()` is the single method every caller must go through, so adding the risk check
 * later does not require touching any caller.
 */
export class GuardedSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly policy: AllowlistPolicy,
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
}
