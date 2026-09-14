import { describe, expect, it } from "vitest";
import { ControlLock } from "../../src/hitl/control-lock.js";
import type { InterventionRequest } from "../../src/hitl/types.js";

function baseRequest(): Omit<InterventionRequest, "controlPort"> {
  return {
    runId: "run-1",
    reason: "unexpected modal blocking the flow",
    explicit: true,
    goal: "Check out with one item",
    currentUrl: "https://example.test/cart",
    recentSteps: ["click \"Checkout\" (ok)"],
    cdpEndpoint: "http://127.0.0.1:9999",
    evidenceDir: "evidence/run-1",
    createdAt: new Date().toISOString(),
  };
}

async function getIntervention(port: number): Promise<InterventionRequest> {
  const res = await fetch(`http://127.0.0.1:${port}/intervention`);
  return (await res.json()) as InterventionRequest;
}

describe("ControlLock", () => {
  it("binds a real port and serves the InterventionRequest over GET /intervention", async () => {
    const lock = await ControlLock.open(baseRequest());
    try {
      expect(lock.intervention.controlPort).toBeGreaterThan(0);
      const served = await getIntervention(lock.intervention.controlPort);
      expect(served).toEqual(lock.intervention);
    } finally {
      await lock.close();
    }
  });

  it("resolves waitForOperator with 'resumed' and any notes when POST /resume is called", async () => {
    const lock = await ControlLock.open(baseRequest());
    try {
      const waiting = lock.waitForOperator(5000);
      const res = await fetch(`http://127.0.0.1:${lock.intervention.controlPort}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: "dismissed the modal manually" }),
      });
      expect(res.status).toBe(200);

      const outcome = await waiting;
      expect(outcome).toEqual({ outcome: "resumed", notes: "dismissed the modal manually" });
    } finally {
      await lock.close();
    }
  });

  it("resolves waitForOperator with 'aborted' when POST /abort is called", async () => {
    const lock = await ControlLock.open(baseRequest());
    try {
      const waiting = lock.waitForOperator(5000);
      await fetch(`http://127.0.0.1:${lock.intervention.controlPort}/abort`, { method: "POST" });

      const outcome = await waiting;
      expect(outcome).toEqual({ outcome: "aborted", notes: undefined });
    } finally {
      await lock.close();
    }
  });

  it("resolves waitForOperator with 'timeout' if nobody responds in time", async () => {
    const lock = await ControlLock.open(baseRequest());
    try {
      const outcome = await lock.waitForOperator(50);
      expect(outcome).toEqual({ outcome: "timeout" });
    } finally {
      await lock.close();
    }
  });

  it("returns 404 for unrecognized routes", async () => {
    const lock = await ControlLock.open(baseRequest());
    try {
      const res = await fetch(`http://127.0.0.1:${lock.intervention.controlPort}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await lock.close();
    }
  });
});
