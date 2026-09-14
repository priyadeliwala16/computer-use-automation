/**
 * Seam between the replay executor / agent loop and the evidence-capture mechanism (§3.5),
 * introduced now so the replay executor (Phase 3) doesn't have to hard-depend on a fully built
 * evidence pipeline before one exists. `NullEvidenceSink` is a real, valid implementation (not a
 * stub-that-throws) — running the executor without a configured sink is a legitimate mode (e.g.
 * a unit test that doesn't care about screenshots), it just means no richer artifact is captured.
 * Phase 7 adds a real implementation that writes a screenshot + DOM snapshot into
 * /evidence/<runId>/ and returns a reference to it.
 */
export interface EvidenceSink {
  /** Captures whatever richer signal this sink provides (e.g. a screenshot) and returns an
   *  identifier/path the caller can use to look it up later. `reason` is a short, stable tag
   *  (e.g. "business_outcome:user_locked_out", "hard_failure:click-continue") — not free text. */
  capture(reason: string): Promise<string>;
}

export class NullEvidenceSink implements EvidenceSink {
  async capture(reason: string): Promise<string> {
    return `no-evidence-sink-configured (${reason})`;
  }
}
