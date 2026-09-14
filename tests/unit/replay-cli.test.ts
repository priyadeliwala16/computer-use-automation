import { describe, expect, it } from "vitest";
import { coerceParams, parseRawParams } from "../../src/cli/replay.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";

function fakeArtifact(inputs: CapabilityArtifact["inputs"]): CapabilityArtifact {
  return {
    id: "test.capability",
    version: 1,
    schemaVersion: "1.0",
    name: "Test",
    description: "Test capability",
    target: { app: "test-app", baseUrl: "https://example.test", surfaceType: "web" },
    provenance: { discoveryRunId: "run-1", recordedAt: new Date().toISOString(), model: "test-model" },
    inputs,
    outputs: [],
    steps: [{ id: "step-1", action: "navigate", value: { kind: "literal", value: "https://example.test" }, expected: [] }],
    checkpoint: { description: "n/a", assertion: { kind: "urlContains", value: "example.test" } },
    policy: { riskLevel: "safe", requiresApproval: false },
    status: "approved",
  };
}

describe("replay CLI: parseRawParams", () => {
  it("splits name=value pairs into a map", () => {
    expect(parseRawParams(["username=standard_user", "password=secret_sauce"])).toEqual({
      username: "standard_user",
      password: "secret_sauce",
    });
  });

  it("supports '=' characters inside the value itself", () => {
    expect(parseRawParams(["query=a=b=c"])).toEqual({ query: "a=b=c" });
  });

  it("throws for a flag with no '=' or an empty name", () => {
    expect(() => parseRawParams(["justavalue"])).toThrow(/not in the form name=value/);
    expect(() => parseRawParams(["=novalue"])).toThrow(/not in the form name=value/);
  });
});

describe("replay CLI: coerceParams", () => {
  it("coerces a numeric input's string value into an actual number", () => {
    const artifact = fakeArtifact([{ name: "memberId", type: "number", required: true, redact: false, description: "" }]);
    expect(coerceParams({ memberId: "12345" }, artifact)).toEqual({ memberId: 12345 });
  });

  it("coerces a boolean input's string value into an actual boolean, case-insensitively", () => {
    const artifact = fakeArtifact([{ name: "expedite", type: "boolean", required: false, redact: false, description: "" }]);
    expect(coerceParams({ expedite: "TRUE" }, artifact)).toEqual({ expedite: true });
    expect(coerceParams({ expedite: "false" }, artifact)).toEqual({ expedite: false });
    expect(coerceParams({ expedite: "nope" }, artifact)).toEqual({ expedite: false });
  });

  it("leaves a string input's value untouched", () => {
    const artifact = fakeArtifact([{ name: "username", type: "string", required: true, redact: false, description: "" }]);
    expect(coerceParams({ username: "standard_user" }, artifact)).toEqual({ username: "standard_user" });
  });

  it("throws a clear error when a numeric input's value isn't actually numeric", () => {
    const artifact = fakeArtifact([{ name: "memberId", type: "number", required: true, redact: false, description: "" }]);
    expect(() => coerceParams({ memberId: "not-a-number" }, artifact)).toThrow(/not a valid number/);
  });

  it("passes through a param the artifact doesn't declare as a plain string, rather than rejecting it", () => {
    const artifact = fakeArtifact([]);
    expect(coerceParams({ extra: "value" }, artifact)).toEqual({ extra: "value" });
  });
});
