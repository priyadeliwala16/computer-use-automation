import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { DiscoveryAgentLoop, type EscalationContext } from "../../src/agent/loop.js";
import type { AgentDecisionClient } from "../../src/agent/claude-client.js";
import type { ActionResult, Observation, Surface, SurfaceAction } from "../../src/surface/types.js";

// ---------------------------------------------------------------------------
// Test doubles. `DiscoveryAgentLoop` depends only on `Surface` and
// `AgentDecisionClient` — both are seams introduced specifically so this loop
// (the most behaviorally complex piece of the system: stopping conditions,
// error handling, message bookkeeping) is unit-testable with zero network
// calls, zero Anthropic credentials, and zero real browser.
// ---------------------------------------------------------------------------

function toolUseMessage(name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    id: `msg_${name}_${Math.random()}`,
    content: [{ type: "tool_use", id: `toolu_${name}_${Math.random()}`, name, input }],
    model: "test-model",
    role: "assistant",
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function textOnlyMessage(text: string): Anthropic.Message {
  return {
    id: "msg_text",
    content: [{ type: "text", text }],
    model: "test-model",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

class ScriptedClient implements AgentDecisionClient {
  readonly model = "test-model";
  readonly calls: Array<{ systemPrompt: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[] }> = [];
  private index = 0;

  constructor(private readonly responses: Anthropic.Message[]) {}

  async decide(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
  ): Promise<Anthropic.Message> {
    this.calls.push({ systemPrompt, messages, tools });
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`ScriptedClient exhausted after ${this.index} call(s) — test provided too few responses`);
    }
    this.index += 1;
    return response;
  }
}

class FakeSurface implements Surface {
  readonly actions: SurfaceAction[] = [];
  private url = "https://example.test/";

  constructor(private readonly actResult: (action: SurfaceAction) => ActionResult = () => ({ ok: true })) {}

  async observe(): Promise<Observation> {
    return { snapshotId: "snap-1", url: this.url, title: "Test Page", nodes: [] };
  }

  async act(action: SurfaceAction): Promise<ActionResult> {
    this.actions.push(action);
    if (action.type === "navigate") this.url = action.url;
    return this.actResult(action);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from("");
  }

  currentUrl(): string {
    return this.url;
  }

  async close(): Promise<void> {}
}

const TARGET = { app: "test-app", baseUrl: "https://example.test" };

describe("DiscoveryAgentLoop", () => {
  it("navigates to the target, then follows click -> type -> finish to a completed trace", async () => {
    const client = new ScriptedClient([
      toolUseMessage("click", { ref: "e1", reasoning: "open the form" }),
      toolUseMessage("type", { ref: "e2", text: "hello", reasoning: "fill the field" }),
      toolUseMessage("finish", { summary: "Form submitted" }),
    ]);
    const surface = new FakeSurface();
    const loop = new DiscoveryAgentLoop(surface, client);

    const trace = await loop.run("Fill out the form", TARGET, []);

    expect(trace.status).toBe("completed");
    expect(trace.turns).toHaveLength(3);
    expect(trace.turns[0]!.toolCall).toMatchObject({ name: "click", ref: "e1" });
    expect(trace.turns[1]!.toolCall).toMatchObject({ name: "type", ref: "e2", text: "hello" });
    expect(trace.turns[2]!.toolCall).toMatchObject({ name: "finish", summary: "Form submitted" });
    expect(trace.finalUrl).toBe(TARGET.baseUrl);

    // First action is always the discovery-run's own navigate to the target base URL.
    expect(surface.actions[0]).toMatchObject({ type: "navigate", url: TARGET.baseUrl });
    expect(surface.actions[1]).toMatchObject({ type: "click", target: { kind: "ref", ref: "e1" } });
    expect(surface.actions[2]).toMatchObject({ type: "type", target: { kind: "ref", ref: "e2" }, text: "hello" });
  });

  it("stops immediately and records the reason when the model escalates", async () => {
    const client = new ScriptedClient([toolUseMessage("escalate", { reason: "unexpected modal blocking the flow" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client);

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("escalated");
    expect(trace.escalationReason).toBe("unexpected modal blocking the flow");
    expect(trace.turns).toHaveLength(1);
  });

  it("treats repeated failed actions as a dead end once the consecutive-failure limit is hit", async () => {
    const client = new ScriptedClient([
      toolUseMessage("click", { ref: "e1", reasoning: "try" }),
      toolUseMessage("click", { ref: "e1", reasoning: "try again" }),
      toolUseMessage("click", { ref: "e1", reasoning: "should not be reached" }),
    ]);
    const surface = new FakeSurface(() => ({ ok: false, error: "element not found" }));
    const loop = new DiscoveryAgentLoop(surface, client, { maxConsecutiveFailures: 2 });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("dead_end");
    expect(trace.turns).toHaveLength(2);
    expect(trace.escalationReason).toMatch(/2 consecutive failed actions/);
  });

  it("stops at maxSteps if the model never calls finish or escalate", async () => {
    const responses = Array.from({ length: 5 }, (_, i) => toolUseMessage("click", { ref: `e${i}`, reasoning: "keep going" }));
    const client = new ScriptedClient(responses);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, { maxSteps: 3 });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("max_steps_exceeded");
    expect(trace.turns).toHaveLength(3);
  });

  it("stops as a timeout if the deadline has already elapsed before the first turn", async () => {
    const client = new ScriptedClient([toolUseMessage("click", { ref: "e1", reasoning: "n/a" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, { timeoutMs: -1 });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("timeout");
    expect(trace.turns).toHaveLength(0);
  });

  it("treats a text-only model response as a dead end rather than crashing", async () => {
    // Defensive path: tool_choice:"any" should make this unreachable in practice, but the loop
    // must not assume the model always honors it.
    const client = new ScriptedClient([textOnlyMessage("I'm not sure what to do next.")]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client);

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("dead_end");
    expect(trace.turns).toHaveLength(0);
  });

  it("treats a malformed tool call (fails our own schema) as a dead end rather than crashing", async () => {
    // Missing the required "reasoning" field.
    const client = new ScriptedClient([toolUseMessage("click", { ref: "e1" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client);

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("dead_end");
    expect(trace.escalationReason).toMatch(/malformed tool call/);
  });

  it("converts a thrown error from the surface (e.g. a policy violation) into a failed turn instead of crashing", async () => {
    const client = new ScriptedClient([
      toolUseMessage("navigate", { url: "https://evil.test", reasoning: "leave the site" }),
      toolUseMessage("escalate", { reason: "navigation was blocked by policy" }),
    ]);
    const surface = new FakeSurface((action) => {
      if (action.type === "navigate" && action.url === "https://evil.test") {
        throw new Error("Navigation target is outside the allowed domains.");
      }
      return { ok: true };
    });
    const loop = new DiscoveryAgentLoop(surface, client);

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.turns[0]!.actionResult).toEqual({
      ok: false,
      error: "Navigation target is outside the allowed domains.",
    });
    expect(trace.status).toBe("escalated");
  });

  it("builds the system prompt from the goal, target, and param hints, and offers every tool", async () => {
    const client = new ScriptedClient([toolUseMessage("finish", { summary: "done" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client);

    await loop.run("Log in and check out", { app: "saucedemo", baseUrl: "https://www.saucedemo.com" }, [
      { name: "username", value: "standard_user", redact: false },
      { name: "password", value: "secret_sauce", redact: true },
    ]);

    expect(client.calls).toHaveLength(1);
    const { systemPrompt, tools } = client.calls[0]!;
    expect(systemPrompt).toContain("Log in and check out");
    expect(systemPrompt).toContain("standard_user");
    expect(systemPrompt).toContain("secret_sauce");
    expect(systemPrompt).toContain("sensitive");
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["click", "escalate", "extract", "finish", "navigate", "select", "type"].sort(),
    );
  });

  it("uses a caller-supplied runId instead of generating one, so an evidence bundle path can be known upfront", async () => {
    const client = new ScriptedClient([toolUseMessage("finish", { summary: "done" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, { runId: "fixed-run-id-123" });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.runId).toBe("fixed-run-id-123");
  });

  // ---------------------------------------------------------------------------------------
  // §3.6 HITL: escalation is a resumable pause, not necessarily terminal. These tests cover
  // the loop's half of the contract (the `onEscalate` decision point) in isolation from the
  // real ControlLock/operator-cli mechanism, which lives in src/hitl/ and is exercised by
  // tests/unit/control-lock.test.ts instead.
  // ---------------------------------------------------------------------------------------

  it("resumes after an explicit escalate when onEscalate returns resume, and continues to completion", async () => {
    const client = new ScriptedClient([
      toolUseMessage("escalate", { reason: "unexpected modal blocking the flow" }),
      toolUseMessage("finish", { summary: "done after human help" }),
    ]);
    const contexts: EscalationContext[] = [];
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, {
      onEscalate: async (context) => {
        contexts.push(context);
        return { action: "resume" };
      },
    });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("completed");
    expect(trace.turns.map((t) => t.toolCall.name)).toEqual(["escalate", "finish"]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ reason: "unexpected modal blocking the flow", explicit: true });
    expect(contexts[0]!.turnsSoFar).toHaveLength(1); // the escalate turn itself, already recorded
  });

  it("still aborts (status escalated) when onEscalate explicitly returns abort", async () => {
    const client = new ScriptedClient([toolUseMessage("escalate", { reason: "give up" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, {
      onEscalate: async () => ({ action: "abort" }),
    });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("escalated");
    expect(trace.escalationReason).toBe("give up");
  });

  it("routes an automatic dead-end (consecutive failures) through onEscalate too, and can resume past it", async () => {
    const client = new ScriptedClient([
      toolUseMessage("click", { ref: "e1", reasoning: "try" }),
      toolUseMessage("click", { ref: "e1", reasoning: "try again" }),
      toolUseMessage("click", { ref: "e1", reasoning: "works now that a human fixed it" }),
      toolUseMessage("finish", { summary: "done" }),
    ]);
    let clickAttempts = 0;
    const surface = new FakeSurface((action) => {
      if (action.type !== "click") return { ok: true };
      clickAttempts += 1;
      return clickAttempts <= 2 ? { ok: false, error: "element not found" } : { ok: true };
    });
    const explicitFlags: boolean[] = [];
    const loop = new DiscoveryAgentLoop(surface, client, {
      maxConsecutiveFailures: 2,
      onEscalate: async (context) => {
        explicitFlags.push(context.explicit);
        return { action: "resume" };
      },
    });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("completed");
    expect(explicitFlags).toEqual([false]); // automatic trigger, not the model's own escalate call
    expect(trace.turns.map((t) => t.toolCall.name)).toEqual(["click", "click", "click", "finish"]);
    expect(trace.turns.slice(0, 2).every((t) => !t.actionResult.ok)).toBe(true);
    expect(trace.turns[2]!.actionResult.ok).toBe(true);
  });

  it("still dead-ends when onEscalate is unset, exactly as before this hook existed", async () => {
    const client = new ScriptedClient([
      toolUseMessage("click", { ref: "e1", reasoning: "try" }),
      toolUseMessage("click", { ref: "e1", reasoning: "try again" }),
    ]);
    const surface = new FakeSurface(() => ({ ok: false, error: "element not found" }));
    const loop = new DiscoveryAgentLoop(surface, client, { maxConsecutiveFailures: 2 });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("dead_end");
  });

  it("resumes after a malformed tool call when onEscalate returns resume", async () => {
    const client = new ScriptedClient([
      toolUseMessage("click", { ref: "e1" }), // missing the required "reasoning" field
      toolUseMessage("finish", { summary: "done" }),
    ]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, {
      onEscalate: async () => ({ action: "resume" }),
    });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("completed");
    // The malformed call itself never produces a turn (it never reached executeToolCall) — only
    // the finish call that followed the resume does.
    expect(trace.turns.map((t) => t.toolCall.name)).toEqual(["finish"]);
  });

  it("resumes after a text-only model response when onEscalate returns resume", async () => {
    const client = new ScriptedClient([textOnlyMessage("I'm not sure what to do next."), toolUseMessage("finish", { summary: "done" })]);
    const loop = new DiscoveryAgentLoop(new FakeSurface(), client, {
      onEscalate: async () => ({ action: "resume" }),
    });

    const trace = await loop.run("Do the thing", TARGET, []);

    expect(trace.status).toBe("completed");
    expect(trace.turns.map((t) => t.toolCall.name)).toEqual(["finish"]);
  });

  it("records extracted values on successful extract turns", async () => {
    const client = new ScriptedClient([
      toolUseMessage("extract", { ref: "e1", label: "order_total", reasoning: "capture the total" }),
      toolUseMessage("finish", { summary: "done" }),
    ]);
    const surface = new FakeSurface((action) => (action.type === "extract" ? { ok: true, extractedValue: "$29.99" } : { ok: true }));
    const loop = new DiscoveryAgentLoop(surface, client);

    const trace = await loop.run("Read the order total", TARGET, []);

    expect(trace.turns[0]!.toolCall).toMatchObject({ name: "extract", label: "order_total" });
    expect(trace.turns[0]!.actionResult).toEqual({ ok: true, extractedValue: "$29.99" });
  });
});
