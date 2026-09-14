import type { Observation } from "../surface/types.js";

export interface ParamHint {
  name: string;
  value: string;
  redact: boolean;
  description?: string;
}

export interface DiscoveryTarget {
  app: string;
  baseUrl: string;
}

/**
 * The discovery-time system prompt. Two things worth calling out:
 *  1. `paramHints` are concrete example values the human kicking off discovery supplies up
 *     front (e.g. a real-looking username/password/zip). The agent is told to use these
 *     verbatim — it isn't asked to invent realistic-looking data, and it isn't asked to reason
 *     about "which parts of this should be a parameter later." That's a deliberate simplification
 *     (documented in REPORT.md): parameterization is a deterministic post-processing step the
 *     recorder performs by matching these exact known values in the trace, not something we ask
 *     an LLM to get right through prompting alone.
 *  2. The prompt explicitly allows `finish` on a non-happy-path state if THAT state is what the
 *     goal was asking for (e.g. "confirm a locked-out account can't log in") — discovery isn't
 *     assumed to always be the happy path.
 */
export function buildSystemPrompt(goal: string, target: DiscoveryTarget, paramHints: ParamHint[]): string {
  const paramLines = paramHints
    .map((p) => `  - ${p.name}: "${p.value}"${p.redact ? " (sensitive — will be redacted from any saved artifact/log)" : ""}`)
    .join("\n");

  return `You are a computer-use automation agent operating a real web application on behalf of a banking-software company. Your job right now is DISCOVERY: figure out, by directly observing and acting on the live page, how to accomplish a goal. A successful run will be turned into a deterministic, reusable automation that a different system replays later without any model in the loop — so act deliberately, one clear step at a time, using controls the way a careful human operator would.

Goal: ${goal}

Target application: ${target.app} (starting at ${target.baseUrl})

Known example values for this run — use these verbatim wherever the goal calls for a value of that kind, rather than inventing your own:
${paramLines || "  (none provided)"}

Rules:
- Each turn you will be shown the current page as a list of elements, each with a [ref] you must use to act on it. Refs are only valid for the observation they came from — always act on refs from the observation you were just shown, never one from an earlier turn.
- Call exactly one tool per turn. Do not produce a text-only response.
- Prefer clicking/typing/selecting over navigating directly by URL — you are modeling what a human operator using this UI would actually do, and that's what gets recorded.
- If a click or type fails, look at the resulting error and the next observation before retrying — don't repeat the identical action blindly.
- Some non-happy-path states (a validation error, a locked-out account, a "not found" result) may themselves BE the goal — read the goal carefully. Call "finish" once the current page genuinely reflects the goal being accomplished, whatever that state is.
- Call "escalate" if you cannot safely or successfully proceed — a dead end after a reasonable retry, an action that looks irreversible and wasn't asked for, or a state you don't understand. Don't guess your way through it.
- Never invent data that wasn't given to you above or read directly from the page.`;
}

/**
 * Renders an `Observation` as plain text for the model. Deliberately terse — role, accessible
 * name, and current value/disabled state only. `cssPath` is intentionally omitted here: it's
 * only ever consumed downstream (by the recorder, when building a `LocatorSpec`), never by the
 * model, both to keep the prompt small and because a CSS path is meaningless to reason about at
 * the "what should I click" level.
 */
export function serializeObservation(observation: Observation): string {
  const lines = observation.nodes.map((n) => {
    const parts = [`[${n.ref}] ${n.role}`];
    if (n.name) parts.push(JSON.stringify(n.name));
    if (n.value) parts.push(`value=${JSON.stringify(n.value)}`);
    if (n.disabled) parts.push("(disabled)");
    return parts.join(" ");
  });
  return `URL: ${observation.url}\nTitle: ${observation.title}\nElements:\n${lines.join("\n")}`;
}
