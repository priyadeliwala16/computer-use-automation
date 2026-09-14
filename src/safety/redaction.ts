function placeholder(name: string): string {
  return `[REDACTED:${name}]`;
}

/**
 * The minimal shape this module needs. Both `ParamHint` (discovery-time example values, see
 * src/agent/prompt.ts) and a `CapabilityArtifact` input paired with its replay-time value (see
 * src/evidence — a future `replay` CLI's structured logging) satisfy this structurally with no
 * adapter needed; nothing in this file should ever import from `agent/` or `artifact/` to avoid
 * a needless dependency in the other direction.
 */
export interface RedactableValue {
  name: string;
  value: string;
  redact: boolean;
}

/**
 * Replaces every exact occurrence of a sensitive value with a placeholder. This is the single
 * source of truth backing the "never logged or persisted in raw form anywhere (RunTrace,
 * artifact examples, evidence)" guarantee documented on `ParamSpec.redact` in
 * src/artifact/schema.ts — anything that prints or persists discovery- or replay-time text
 * (console logs, structured JSONL evidence logs) must run it through this function first.
 *
 * Deliberately simple exact-substring matching rather than a general PII scrubber: at the point
 * this is called we already know precisely which literal values are sensitive — declared as
 * such by whoever kicked off the run (`--redact` at discovery time; an artifact's own
 * `inputs[].redact` at replay time) — so there's nothing to infer or guess.
 *
 * Note this only protects values that flow through the given list verbatim. It is NOT a
 * substitute for reviewing what a capability artifact captures before treating it as safe to
 * share — it's the one deliberate, narrow guarantee the brief's "sensitive data redaction"
 * (§3.4) asks for.
 */
export function redactSensitiveValues(text: string, values: RedactableValue[]): string {
  let result = text;
  for (const v of values) {
    if (!v.redact || !v.value) continue;
    result = result.split(v.value).join(placeholder(v.name));
  }
  return result;
}
