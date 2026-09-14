import { describe, expect, it } from "vitest";
import { AllowlistPolicy } from "../../src/config/allowlist.js";
import { AllowlistViolationError, GuardedSurface, RiskyActionBlockedError } from "../../src/safety/guarded-surface.js";
import type { ActionResult, Observation, Surface, SurfaceAction } from "../../src/surface/types.js";

class FakeSurface implements Surface {
  readonly actions: SurfaceAction[] = [];
  constructor(private readonly nodes: Observation["nodes"] = []) {}

  async observe(): Promise<Observation> {
    return { snapshotId: "snap-1", url: "https://example.test/", title: "Test", nodes: this.nodes };
  }

  async act(action: SurfaceAction): Promise<ActionResult> {
    this.actions.push(action);
    return { ok: true };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("");
  }

  currentUrl(): string {
    return "https://example.test/";
  }

  async close(): Promise<void> {}
}

const POLICY = new AllowlistPolicy({
  app: "test-app",
  allowedDomains: ["example.test"],
  allowedActionTypes: ["click", "type", "navigate", "extract"],
  riskyControls: [{ description: "Finalizing an order is irreversible.", role: "button", namePattern: "^Finish Order$" }],
});

describe("GuardedSurface", () => {
  it("delegates observe/screenshot/currentUrl/close unchanged", async () => {
    const inner = new FakeSurface([{ ref: "e1", role: "button", name: "OK", cssPath: "body > button" }]);
    const guarded = new GuardedSurface(inner, POLICY);

    expect(await guarded.observe()).toEqual(await inner.observe());
    expect(guarded.currentUrl()).toBe(inner.currentUrl());
    await guarded.close();
  });

  it("blocks an action type that isn't in the allowlist", async () => {
    const guarded = new GuardedSurface(new FakeSurface(), POLICY);
    await expect(guarded.act({ type: "select", target: { kind: "ref", ref: "e1" }, value: "x" })).rejects.toThrow(
      AllowlistViolationError,
    );
  });

  it("blocks navigation outside the allowed domains", async () => {
    const guarded = new GuardedSurface(new FakeSurface(), POLICY);
    await expect(guarded.act({ type: "navigate", url: "https://evil.test/" })).rejects.toThrow(AllowlistViolationError);
  });

  it("allows navigation to an allowed domain and a subdomain of it", async () => {
    const inner = new FakeSurface();
    const guarded = new GuardedSurface(inner, POLICY);
    await guarded.act({ type: "navigate", url: "https://example.test/page" });
    await guarded.act({ type: "navigate", url: "https://www.example.test/page" });
    expect(inner.actions).toHaveLength(2);
  });

  it("blocks a ref-addressed click whose resolved node matches a risky-control rule", async () => {
    const inner = new FakeSurface([{ ref: "e1", role: "button", name: "Finish Order", cssPath: "body > button" }]);
    const guarded = new GuardedSurface(inner, POLICY);

    await expect(guarded.act({ type: "click", target: { kind: "ref", ref: "e1" } })).rejects.toThrow(
      RiskyActionBlockedError,
    );
    expect(inner.actions).toHaveLength(0); // never delegated to the inner surface
  });

  it("blocks a locator-addressed click matching a risky-control rule, with no extra observe() needed", async () => {
    const inner = new FakeSurface();
    const guarded = new GuardedSurface(inner, POLICY);

    await expect(
      guarded.act({
        type: "click",
        target: { kind: "locator", locator: { role: "button", name: "Finish Order", fallbackOrder: ["role"] } },
      }),
    ).rejects.toThrow(RiskyActionBlockedError);
  });

  it("allows a click that does not match any risky-control rule", async () => {
    const inner = new FakeSurface([{ ref: "e1", role: "button", name: "Continue", cssPath: "body > button" }]);
    const guarded = new GuardedSurface(inner, POLICY);

    await guarded.act({ type: "click", target: { kind: "ref", ref: "e1" } });
    expect(inner.actions).toEqual([{ type: "click", target: { kind: "ref", ref: "e1" } }]);
  });

  it("allows a risky click through when allowRiskyActions is set (approved-artifact replay)", async () => {
    const inner = new FakeSurface();
    const guarded = new GuardedSurface(inner, POLICY, { allowRiskyActions: true });

    await guarded.act({
      type: "click",
      target: { kind: "locator", locator: { role: "button", name: "Finish Order", fallbackOrder: ["role"] } },
    });
    expect(inner.actions).toHaveLength(1);
  });

  it("does not risk-check non-click actions even against a matching name", async () => {
    const inner = new FakeSurface([{ ref: "e1", role: "button", name: "Finish Order", cssPath: "body > button" }]);
    const guarded = new GuardedSurface(inner, POLICY);

    // "extract" reading a risky-looking button's text should never be blocked — only clicking it.
    await guarded.act({ type: "extract", target: { kind: "ref", ref: "e1" } });
    expect(inner.actions).toHaveLength(1);
  });
});
