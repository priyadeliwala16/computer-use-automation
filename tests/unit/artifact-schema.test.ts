import { describe, expect, it } from "vitest";
import { parseCapabilityArtifact, CapabilityArtifactSchema } from "../../src/artifact/schema.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const FIXTURE_PATH = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "saucedemo.add_item_and_checkout@v1.json",
);

describe("CapabilityArtifact schema", () => {
  it("parses the hand-authored fixture artifact without error", async () => {
    const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf-8"));
    const artifact = parseCapabilityArtifact(raw);
    expect(artifact.id).toBe("saucedemo.add_item_and_checkout");
    expect(artifact.steps.length).toBeGreaterThan(0);
    expect(artifact.outputs.map((o) => o.name)).toEqual(["itemTotalText", "taxText", "totalText"]);
  });

  it("round-trips through JSON without loss", async () => {
    const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf-8"));
    const parsed = parseCapabilityArtifact(raw);
    const roundTripped = parseCapabilityArtifact(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects an artifact missing required fields", () => {
    const result = CapabilityArtifactSchema.safeParse({ id: "incomplete" });
    expect(result.success).toBe(false);
  });

  it("rejects a step with an unknown action type", () => {
    const raw = JSON.parse(
      JSON.stringify({
        id: "x",
        version: 1,
        schemaVersion: "1.0",
        name: "x",
        description: "x",
        target: { app: "x", baseUrl: "https://example.com", surfaceType: "web" },
        provenance: { discoveryRunId: "x", recordedAt: "now", model: "x" },
        inputs: [],
        outputs: [],
        steps: [{ id: "s1", action: "teleport" }],
        checkpoint: { description: "x", assertion: { kind: "urlContains", value: "x" } },
        policy: { riskLevel: "safe", requiresApproval: false },
        status: "draft",
      }),
    );
    expect(CapabilityArtifactSchema.safeParse(raw).success).toBe(false);
  });

  it("requires every business_outcome expected-condition to carry an outcomeCode by convention", async () => {
    const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf-8"));
    const artifact = parseCapabilityArtifact(raw);
    const businessOutcomes = artifact.steps.flatMap((s) => s.expected).filter((e) => e.classification === "business_outcome");
    expect(businessOutcomes.length).toBeGreaterThan(0);
    for (const outcome of businessOutcomes) {
      expect(outcome.outcomeCode).toBeTruthy();
    }
  });
});
