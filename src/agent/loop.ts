import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ActionResult, Observation, SnapshotNode, Surface } from "../surface/types.js";
import type { AgentDecisionClient } from "./claude-client.js";
import { AGENT_TOOLS, parseToolCall, type AgentToolCall } from "./tools.js";
import { buildSystemPrompt, serializeObservation, type DiscoveryTarget, type ParamHint } from "./prompt.js";
import type { RunStatus, RunTrace, RunTraceTurn } from "./run-trace.js";

/** What the loop hands to whoever decides how to respond to a stuck run (§3.6). Carries
 *  everything a human-in-the-loop handoff needs to make sense of the situation without the
 *  decider needing to reach back into the loop's internals. */
export interface EscalationContext {
  /** Why this escalation is happening — either the model's own `escalate` reasoning, or a
   *  description of the consecutive-failure dead end that triggered it automatically. */
  reason: string;
  /** True for the model's own explicit `escalate` call; false for the automatic dead-end
   *  trigger (repeated action failures with no explicit call). Both are routed through the same
   *  decision point — see the module doc comment — but a decider may reasonably treat them
   *  differently (e.g. always abort on a dead end, but always offer a human on an explicit ask). */
  explicit: boolean;
  observation: Observation;
  turnsSoFar: readonly RunTraceTurn[];
}

/** "resume": the loop proceeds with its next normal turn (re-observe, ask the model again) as
 *  if nothing happened, after resetting the consecutive-failure counter — the decider is
 *  asserting whatever was stuck no longer is. "abort": the loop stops now, same as if no
 *  decider were configured at all. */
export type EscalationDecision = { action: "resume"; notes?: string } | { action: "abort" };

export interface DiscoveryLoopOptions {
  maxSteps?: number;
  timeoutMs?: number;
  /** Consecutive failed actions before we treat this as a dead end and route it through
   *  `onEscalate` (or stop, if unset) rather than let the model keep guessing — the concrete
   *  "dead-end" stopping condition required by §3.1. */
  maxConsecutiveFailures?: number;
  /**
   * Awaited before the loop proceeds to its next turn — deliberately not fire-and-forget. A
   * caller that captures a screenshot here (the `discover` CLI does) needs it to reflect the
   * page exactly as it was at this turn boundary; if the loop moved on to the next action
   * before that finished, the screenshot could race the next mutation and end up evidencing
   * the wrong moment.
   */
  onTurn?: (turn: RunTraceTurn) => void | Promise<void>;
  /**
   * The loop's one escalation decision point (§3.6). Called for BOTH an explicit model
   * `escalate` call and an automatic dead-end trigger — see `EscalationContext.explicit`. If
   * unset, or if it resolves to `{action:"abort"}`, the run stops with status `"escalated"` or
   * `"dead_end"` exactly as it did before this hook existed. The `discover` CLI's real
   * implementation opens a `ControlLock` here and waits for a human operator to attach to the
   * live browser session and signal resume (see src/hitl/) — this loop has no idea any of that
   * exists, on purpose: it only knows "someone gets a chance to unstick this before I give up."
   */
  onEscalate?: (context: EscalationContext) => Promise<EscalationDecision>;
  /**
   * Override for the generated run id (default: a fresh `randomUUID()`). Exists so a caller
   * that needs to know the run id BEFORE the run starts — e.g. the `discover` CLI, which names
   * the evidence bundle directory after it — can generate it once and have the same id come
   * back on the resulting `RunTrace`, rather than needing some separate correlation key.
   */
  runId?: string;
}

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** Looks up the node a ref-addressed tool call pointed to, from the observation it was shown
 *  alongside. Returns undefined for `navigate` (no ref) and for a `ref` that (surprisingly)
 *  doesn't match any node in that observation — the recorder falls back to a css-only locator
 *  in that case rather than failing the whole recording. */
function findTargetNode(observation: Observation, toolCall: AgentToolCall): SnapshotNode | undefined {
  if (!("ref" in toolCall)) return undefined;
  return observation.nodes.find((n) => n.ref === toolCall.ref);
}

/**
 * The observe -> decide -> act loop (§3.1). Owns exactly one thing: turning a goal into a
 * `RunTrace` by repeatedly perceiving the live surface, asking the model for the next action, and
 * executing it — plus the stopping conditions (finish, escalate, max steps, timeout, dead end)
 * that decide when to stop. It does not know how to turn that trace into an artifact (Phase 5's
 * recorder) and does not know how to enforce policy (the `Surface` it's given is expected to
 * already be a `GuardedSurface` — this loop enforces no policy of its own, by design, so there is
 * exactly one place in the codebase that allowlist/risk checks live).
 *
 * Escalation (§3.6) is a resumable pause, not necessarily a terminal state: both an explicit
 * model `escalate` call and an automatic dead-end trigger flow through the single
 * `options.onEscalate` decision point below, and either can come back with "resume" — at which
 * point this loop just keeps going, exactly as if the stuck moment had never happened. Whatever
 * unstuck it (a human operator, in the `discover` CLI's case) is this loop's business to neither
 * know nor care about.
 */
export class DiscoveryAgentLoop {
  constructor(
    private readonly surface: Surface,
    private readonly client: AgentDecisionClient,
    private readonly options: DiscoveryLoopOptions = {},
  ) {}

  async run(goal: string, target: DiscoveryTarget, paramHints: ParamHint[]): Promise<RunTrace> {
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxConsecutiveFailures = this.options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

    const runId = this.options.runId ?? randomUUID();
    const startedAt = Date.now();
    const systemPrompt = buildSystemPrompt(goal, target, paramHints);
    const messages: Anthropic.MessageParam[] = [];
    const turns: RunTraceTurn[] = [];

    await this.surface.act({ type: "navigate", url: target.baseUrl });

    let consecutiveFailures = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() - startedAt > timeoutMs) {
        return this.finalize(runId, goal, target, paramHints, turns, startedAt, "timeout");
      }

      const observation = await this.surface.observe();
      messages.push({ role: "user", content: serializeObservation(observation) });

      const response = await this.client.decide(systemPrompt, messages, AGENT_TOOLS);
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!toolUseBlock) {
        // Forced tool_choice should make this unreachable, but a model that still returns
        // text-only is exactly the kind of "can't proceed" state escalation exists for.
        const resumed = await this.escalate("Model returned a text-only response instead of a tool call.", false, observation, turns);
        if (resumed) {
          consecutiveFailures = 0;
          continue;
        }
        return this.finalize(runId, goal, target, paramHints, turns, startedAt, "dead_end");
      }

      // The model's output is untrusted input from our program's point of view — a malformed
      // tool call (e.g. a field that doesn't satisfy the schema we declared) is treated the same
      // as any other "can't proceed" condition rather than crashing the whole run.
      let toolCall: AgentToolCall;
      try {
        toolCall = parseToolCall(toolUseBlock);
      } catch (err) {
        const reason = `Model returned a malformed tool call: ${err instanceof Error ? err.message : String(err)}`;
        const resumed = await this.escalate(reason, false, observation, turns);
        if (resumed) {
          // The API requires a tool_result for every tool_use block in the immediately
          // preceding assistant turn — it has no idea OUR schema rejected this one, so without
          // this, the next messages.create() call would 400. Only needed on the resume path:
          // if we're aborting instead, `messages` is discarded and never sent again.
          messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: `Error: ${reason}`, is_error: true }],
          });
          consecutiveFailures = 0;
          continue;
        }
        return this.finalize(runId, goal, target, paramHints, turns, startedAt, "dead_end", reason);
      }

      if (toolCall.name === "finish") {
        turns.push(this.makeTurn(step, observation.url, toolCall, { ok: true }));
        await this.options.onTurn?.(turns[turns.length - 1]!);
        return this.finalize(runId, goal, target, paramHints, turns, startedAt, "completed");
      }

      if (toolCall.name === "escalate") {
        turns.push(this.makeTurn(step, observation.url, toolCall, { ok: true }));
        await this.options.onTurn?.(turns[turns.length - 1]!);
        const resumed = await this.escalate(toolCall.reason, true, observation, turns);
        if (resumed) {
          // Same requirement as the malformed-tool-call path above: the `escalate` tool_use
          // block still needs an answering tool_result before we can call the model again.
          // The model gets told a human intervened, not just "OK" — that's real signal it
          // should factor into its next decision (e.g. re-observe rather than repeat itself).
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseBlock.id,
                content: "A human operator intervened and resumed the run. Re-observe the current page before deciding your next action.",
              },
            ],
          });
          consecutiveFailures = 0;
          continue;
        }
        return this.finalize(runId, goal, target, paramHints, turns, startedAt, "escalated", toolCall.reason);
      }

      const actionResult = await this.executeToolCall(toolCall);
      const turn = this.makeTurn(step, observation.url, toolCall, actionResult, findTargetNode(observation, toolCall));
      turns.push(turn);
      await this.options.onTurn?.(turn);

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: actionResult.ok
              ? `OK.${actionResult.extractedValue !== undefined ? ` Extracted: ${JSON.stringify(actionResult.extractedValue)}` : ""}`
              : `Error: ${actionResult.error}`,
            is_error: !actionResult.ok,
          },
        ],
      });

      consecutiveFailures = actionResult.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        const reason = `${consecutiveFailures} consecutive failed actions (last error: ${actionResult.error})`;
        const freshObservation = await this.surface.observe();
        const resumed = await this.escalate(reason, false, freshObservation, turns);
        if (resumed) {
          consecutiveFailures = 0;
          continue;
        }
        return this.finalize(runId, goal, target, paramHints, turns, startedAt, "dead_end", reason);
      }
    }

    return this.finalize(runId, goal, target, paramHints, turns, startedAt, "max_steps_exceeded");
  }

  /**
   * The single call site for `options.onEscalate`. Returns `true` when the decider chose to
   * resume (caller should reset its failure counter and keep looping), `false` when it chose to
   * abort or no decider is configured at all — in which case the caller is responsible for
   * finalizing with whatever terminal status fits the situation it was called from.
   */
  private async escalate(
    reason: string,
    explicit: boolean,
    observation: Observation,
    turnsSoFar: readonly RunTraceTurn[],
  ): Promise<boolean> {
    if (!this.options.onEscalate) return false;
    // Snapshotted, not passed by reference: `turnsSoFar` here is the loop's own live `turns`
    // array, which keeps growing after this call returns (if resumed) — a decider that holds
    // onto the context past this call (as the discover CLI's ControlLock/InterventionRequest
    // does) must see the turns *as of the escalation*, not whatever the array grows into later.
    const decision = await this.options.onEscalate({ reason, explicit, observation, turnsSoFar: [...turnsSoFar] });
    return decision.action === "resume";
  }

  /**
   * `GuardedSurface.act` *throws* `AllowlistViolationError`/`RiskyActionBlockedError` rather than
   * returning a failed `ActionResult` (see src/safety/guarded-surface.ts) — a deliberate choice
   * on that class's part so a policy breach during a deterministic replay is loud and unmissable.
   * During discovery, though, the model is exploring freely and an out-of-policy or risky-action
   * attempt (e.g. trying to navigate off-domain, or clicking a "Finish"/"Place order" control) is
   * an expected, recoverable event, not a program bug: we catch it here and feed it back as an
   * ordinary failed tool_result, whose error message explicitly suggests calling `escalate`, so
   * the model hands off to a human rather than being silently stuck. Repeated blocked attempts
   * still trip the same consecutive-failure dead-end check as any other failure — so a model
   * that just keeps ramming the boundary instead of escalating still gets stopped (or handed to
   * a human via `onEscalate`, per the dead-end path above).
   */
  private async executeToolCall(toolCall: AgentToolCall): Promise<ActionResult> {
    try {
      switch (toolCall.name) {
        case "click":
          return await this.surface.act({ type: "click", target: { kind: "ref", ref: toolCall.ref } });
        case "type":
          return await this.surface.act({ type: "type", target: { kind: "ref", ref: toolCall.ref }, text: toolCall.text });
        case "select":
          return await this.surface.act({ type: "select", target: { kind: "ref", ref: toolCall.ref }, value: toolCall.value });
        case "navigate":
          return await this.surface.act({ type: "navigate", url: toolCall.url });
        case "extract":
          return await this.surface.act({ type: "extract", target: { kind: "ref", ref: toolCall.ref } });
        case "finish":
        case "escalate":
          throw new Error(`executeToolCall should never be called with the terminal tool "${toolCall.name}"`);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private makeTurn(
    index: number,
    observationUrl: string,
    toolCall: AgentToolCall,
    actionResult: ActionResult,
    targetNode?: SnapshotNode,
  ): RunTraceTurn {
    return { index, observationUrl, toolCall, actionResult, timestamp: new Date().toISOString(), targetNode };
  }

  private async finalize(
    runId: string,
    goal: string,
    target: DiscoveryTarget,
    paramHints: ParamHint[],
    turns: RunTraceTurn[],
    startedAt: number,
    status: RunStatus,
    escalationReason?: string,
  ): Promise<RunTrace> {
    const finalObservation = await this.surface.observe();
    return {
      runId,
      goal,
      target,
      paramHints,
      model: this.client.model,
      status,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      turns,
      finalUrl: finalObservation.url,
      finalObservationText: serializeObservation(finalObservation),
      escalationReason,
    };
  }
}
