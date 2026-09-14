import { describe, expect, it } from "vitest";
import { AllowlistPolicy } from "../../src/config/allowlist.js";
import { recordArtifact, RecorderError } from "../../src/artifact/recorder.js";
import type { RunTrace, RunTraceTurn } from "../../src/agent/run-trace.js";
import type { AgentToolCall } from "../../src/agent/tools.js";
import type { SnapshotNode } from "../../src/surface/types.js";

const POLICY = new AllowlistPolicy({
  app: "test-app",
  allowedDomains: ["example.test"],
  allowedActionTypes: ["click", "type", "select", "navigate", "extract", "waitFor"],
  riskyControls: [{ description: "Finalizing an order is irreversible.", role: "button", namePattern: "^Finish Order$" }],
});

function node(overrides: Partial<SnapshotNode>): SnapshotNode {
  return { ref: "e0", role: "generic", cssPath: "body > div", ...overrides };
}

let turnCounter = 0;
function turn(toolCall: AgentToolCall, targetNode?: SnapshotNode): RunTraceTurn {
  turnCounter += 1;
  return {
    index: turnCounter,
    observationUrl: "https://example.test/",
    toolCall,
    actionResult: { ok: true },
    timestamp: new Date().toISOString(),
    targetNode,
  };
}

function baseTrace(overrides: Partial<RunTrace>): RunTrace {
  return {
    runId: "run-123",
    goal: "Log in and check the order total",
    target: { app: "test-app", baseUrl: "https://example.test" },
    paramHints: [
      { name: "username", value: "standard_user", redact: false },
      { name: "password", value: "secret_sauce", redact: true },
    ],
    model: "test-model",
    status: "completed",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    turns: [],
    finalUrl: "https://example.test/cart.html",
    finalObservationText: "URL: https://example.test/cart.html\nElements:\n",
    ...overrides,
  };
}

const RECORD_OPTIONS = {
  capabilityId: "test.capability",
  version: 1,
  name: "Test capability",
  description: "A capability recorded from a synthetic run.",
  surfaceType: "web" as const,
};

describe("recordArtifact", () => {
  it("turns a completed run's action turns into steps, binds matching literals to params, and captures extract outputs", () => {
    const usernameField = node({ ref: "e1", role: "textbox", name: "Username" });
    const passwordField = node({ ref: "e2", role: "textbox", name: "Password" });
    const loginButton = node({ ref: "e3", role: "button", name: "Login" });
    const totalLabel = node({ ref: "e4", role: "text", text: "Total: $29.99" });

    const trace = baseTrace({
      turns: [
        turn({ name: "type", ref: "e1", text: "standard_user", reasoning: "enter username" }, usernameField),
        turn({ name: "type", ref: "e2", text: "secret_sauce", reasoning: "enter password" }, passwordField),
        turn({ name: "click", ref: "e3", reasoning: "submit login" }, loginButton),
        turn({ name: "extract", ref: "e4", label: "order_total", reasoning: "read the total" }, totalLabel),
        turn({ name: "finish", summary: "Logged in and read the total" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.id).toBe("test.capability");
    expect(artifact.status).toBe("draft");
    expect(artifact.provenance).toEqual({
      discoveryRunId: "run-123",
      recordedAt: expect.any(String),
      model: "test-model",
    });

    // finish/escalate never become steps.
    expect(artifact.steps).toHaveLength(4);

    expect(artifact.steps[0]).toMatchObject({
      action: "type",
      value: { kind: "param", param: "username" },
      locatorReasoning: "enter username",
    });
    expect(artifact.steps[0]!.target).toMatchObject({ role: "textbox", name: "Username" });

    expect(artifact.steps[1]).toMatchObject({ action: "type", value: { kind: "param", param: "password" } });
    expect(artifact.steps[2]!.action).toBe("click");
    expect(artifact.steps[2]!.value).toBeUndefined();
    expect(artifact.steps[3]).toMatchObject({ action: "extract" });

    expect(artifact.outputs).toEqual([
      { name: "order_total", type: "string", fromStepId: artifact.steps[3]!.id, description: "read the total" },
    ]);

    // Both hints were used, so both become declared inputs.
    expect(artifact.inputs.map((i) => i.name).sort()).toEqual(["password", "username"]);
    const passwordInput = artifact.inputs.find((i) => i.name === "password")!;
    expect(passwordInput.redact).toBe(true);
    // Redacted params never get an example value — the raw secret must not appear anywhere in
    // the recorded (reviewable, shareable) artifact.
    expect(passwordInput.example).toBeUndefined();
    expect(JSON.stringify(artifact)).not.toContain("secret_sauce");

    const usernameInput = artifact.inputs.find((i) => i.name === "username")!;
    expect(usernameInput.redact).toBe(false);
    expect(usernameInput.example).toBe("standard_user");
  });

  it("keeps a typed value literal when it does not match any declared param hint", () => {
    const searchBox = node({ ref: "e1", role: "textbox", name: "Search" });
    const trace = baseTrace({
      paramHints: [],
      turns: [
        turn({ name: "type", ref: "e1", text: "backpack", reasoning: "search for the item" }, searchBox),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.steps[0]).toMatchObject({ value: { kind: "literal", value: "backpack" } });
    expect(artifact.inputs).toEqual([]);
  });

  it("only declares inputs for param hints that were actually bound to a step", () => {
    const usernameField = node({ ref: "e1", role: "textbox", name: "Username" });
    const trace = baseTrace({
      paramHints: [
        { name: "username", value: "standard_user", redact: false },
        { name: "unused_hint", value: "never_typed", redact: false },
      ],
      turns: [
        turn({ name: "type", ref: "e1", text: "standard_user", reasoning: "enter username" }, usernameField),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.inputs.map((i) => i.name)).toEqual(["username"]);
  });

  it("records an explicit navigate turn as a literal-valued navigate step", () => {
    const trace = baseTrace({
      turns: [
        turn({ name: "navigate", url: "https://example.test/cart.html", reasoning: "go to cart" }),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.steps[0]).toMatchObject({
      action: "navigate",
      value: { kind: "literal", value: "https://example.test/cart.html" },
    });
    expect(artifact.steps[0]!.target).toBeUndefined();
  });

  it("classifies the artifact as risky when a step's target matches an allowlist risky-control rule", () => {
    const finishButton = node({ ref: "e1", role: "button", name: "Finish Order" });
    const trace = baseTrace({
      turns: [
        turn({ name: "click", ref: "e1", reasoning: "finalize the order" }, finishButton),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.policy).toEqual({ riskLevel: "risky", requiresApproval: true });
  });

  it("classifies the artifact as safe when no step matches a risky-control rule", () => {
    const okButton = node({ ref: "e1", role: "button", name: "Continue" });
    const trace = baseTrace({
      turns: [
        turn({ name: "click", ref: "e1", reasoning: "continue" }, okButton),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.policy).toEqual({ riskLevel: "safe", requiresApproval: false });
  });

  it("derives a checkpoint from the final URL's path, falling back to the full URL when the path is just '/'", () => {
    const button = node({ ref: "e1", role: "button", name: "Continue" });
    const trace1 = baseTrace({
      finalUrl: "https://example.test/checkout-complete.html",
      turns: [turn({ name: "click", ref: "e1", reasoning: "continue" }, button), turn({ name: "finish", summary: "done" })],
    });
    expect(recordArtifact(trace1, POLICY, RECORD_OPTIONS).checkpoint.assertion).toEqual({
      kind: "urlContains",
      value: "/checkout-complete.html",
    });

    const trace2 = baseTrace({
      finalUrl: "https://example.test/",
      turns: [turn({ name: "click", ref: "e1", reasoning: "continue" }, button), turn({ name: "finish", summary: "done" })],
    });
    expect(recordArtifact(trace2, POLICY, RECORD_OPTIONS).checkpoint.assertion).toEqual({
      kind: "urlContains",
      value: "https://example.test/",
    });
  });

  it("refuses to record a run that did not complete", () => {
    const trace = baseTrace({ status: "escalated", escalationReason: "stuck", turns: [] });
    expect(() => recordArtifact(trace, POLICY, RECORD_OPTIONS)).toThrow(RecorderError);
  });

  it("refuses to record if a redact-flagged secret leaks into the artifact via a near-miss literal", () => {
    // The model typed something merely CONTAINING the sensitive value rather than exactly
    // matching it, so bindValue's exact-match parameterization doesn't catch it — this is
    // exactly the defense-in-depth case assertNoLeakedSecrets exists for.
    const field = node({ ref: "e1", role: "textbox", name: "Notes" });
    const trace = baseTrace({
      paramHints: [{ name: "password", value: "secret_sauce", redact: true }],
      turns: [
        turn({ name: "type", ref: "e1", text: "password is secret_sauce today", reasoning: "note it down" }, field),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    expect(() => recordArtifact(trace, POLICY, RECORD_OPTIONS)).toThrow(/appears verbatim/);
  });

  it("redacts a secret the model's own reasoning echoed verbatim, rather than leaking it or refusing to record", () => {
    // Observed against a real live Claude discovery run: the model's free-text `reasoning` on
    // the `type` call for the password field read `Now I need to enter the password
    // "secret_sauce" into the password field...` — it echoed the exact param value it was given,
    // inside an otherwise-harmless explanatory sentence. Unlike the near-miss-literal case above
    // (where there is no safe way to partially redact a step's actual DATA), free-text reasoning
    // has no data-fidelity requirement — it exists purely for human review — so the correct fix
    // is to redact it, not to refuse recording every run whose model happens to narrate a
    // param's value back.
    const passwordField = node({ ref: "e1", role: "textbox", name: "Password" });
    const trace = baseTrace({
      paramHints: [{ name: "password", value: "secret_sauce", redact: true }],
      turns: [
        turn(
          {
            name: "type",
            ref: "e1",
            text: "secret_sauce",
            reasoning: 'Now I need to enter the password "secret_sauce" into the password field.',
          },
          passwordField,
        ),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.steps[0]!.locatorReasoning).toBe('Now I need to enter the password "[REDACTED:password]" into the password field.');
    expect(JSON.stringify(artifact)).not.toContain("secret_sauce");
  });

  it("redacts a secret echoed in an extract step's reasoning before it becomes an output's description", () => {
    const field = node({ ref: "e1", role: "text", text: "Balance" });
    const trace = baseTrace({
      paramHints: [{ name: "password", value: "secret_sauce", redact: true }],
      turns: [
        turn(
          {
            name: "extract",
            ref: "e1",
            label: "balance",
            reasoning: 'Reading the balance now that we logged in with "secret_sauce".',
          },
          field,
        ),
        turn({ name: "finish", summary: "done" }),
      ],
    });

    const artifact = recordArtifact(trace, POLICY, RECORD_OPTIONS);

    expect(artifact.outputs[0]!.description).toBe('Reading the balance now that we logged in with "[REDACTED:password]".');
    expect(JSON.stringify(artifact)).not.toContain("secret_sauce");
  });

  it("refuses to record a completed run with no action turns", () => {
    const trace = baseTrace({ turns: [turn({ name: "finish", summary: "nothing happened" })] });
    expect(() => recordArtifact(trace, POLICY, RECORD_OPTIONS)).toThrow(/nothing to record/);
  });
});
