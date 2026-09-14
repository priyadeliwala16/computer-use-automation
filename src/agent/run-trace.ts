import type { ActionResult, SnapshotNode } from "../surface/types.js";
import type { AgentToolCall } from "./tools.js";
import type { DiscoveryTarget, ParamHint } from "./prompt.js";

export const RUN_STATUSES = ["completed", "escalated", "timeout", "max_steps_exceeded", "dead_end"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunTraceTurn {
  index: number;
  observationUrl: string;
  toolCall: AgentToolCall;
  actionResult: ActionResult;
  timestamp: string;
  /**
   * The perceived node the tool call's `ref` pointed to, captured from the observation shown to
   * the model for THIS turn (undefined for `navigate`/`finish`/`escalate`, which don't address a
   * ref). This is the one piece of information a `ref` alone can't reconstruct later — refs are
   * ephemeral and only meaningful against the observation they came from (see
   * src/surface/types.ts on `ActionTarget`) — so it's captured here, at the moment of decision,
   * specifically so the recorder (Phase 5) can turn it into a durable `LocatorSpec` via
   * `buildLocatorSpec` without needing to replay anything against a live page.
   */
  targetNode?: SnapshotNode;
}

/**
 * The record of a discovery run — structured enough for the recorder (Phase 5) to mechanically
 * derive a `CapabilityArtifact` from, and rich enough to stand as evidence on its own (§3.5).
 *
 * Deliberately NOT the artifact, and deliberately NOT the raw Anthropic message transcript
 * either (per §3.2's "decoupled from the raw model transcript"): a `RunTraceTurn` captures the
 * *parsed, typed* tool call and its result — not the wire-format request/response blobs. Keeping
 * those out here is what keeps this struct small enough to serialize as evidence and stable
 * enough for the recorder to depend on even if the underlying model/SDK changes.
 */
export interface RunTrace {
  runId: string;
  goal: string;
  target: DiscoveryTarget;
  paramHints: ParamHint[];
  model: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  turns: RunTraceTurn[];
  finalUrl: string;
  finalObservationText: string;
  escalationReason?: string;
}
