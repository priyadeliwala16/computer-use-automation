/**
 * A escalated discovery run's "ticket" for a human operator (§3.6). This is the one artifact
 * that crosses the process boundary between the `discover` CLI (which owns the live browser and
 * the paused agent loop) and `operator-cli.ts` (a separate process a human runs). It is
 * deliberately just data — everything the operator needs to decide whether/how to help, plus
 * the one thing (`cdpEndpoint`) that lets their process attach to the exact same live session
 * rather than a disconnected one.
 */
export interface InterventionRequest {
  /** Correlates back to the RunTrace this escalation belongs to. */
  runId: string;
  /** Why the run stopped and asked for help — the model's own `escalate` reasoning, or a
   *  description of the automatic dead-end trigger. See `EscalationContext.explicit` in
   *  src/agent/loop.ts for which. */
  reason: string;
  /** True if the model explicitly called `escalate`; false if a run of consecutive action
   *  failures triggered this automatically without the model asking for help. */
  explicit: boolean;
  /** The natural-language goal the discovery run as a whole is trying to accomplish. */
  goal: string;
  /** Where the live page is right now, so an operator can decide whether to even bother
   *  attaching before doing so. */
  currentUrl: string;
  /** Human-readable summaries of the last few turns before this escalation, redacted the same
   *  way console/JSONL logging is — enough context to orient without needing to open the full
   *  evidence bundle. */
  recentSteps: string[];
  /** The CDP HTTP endpoint to `chromium.connectOverCDP()` to, to attach to the exact live
   *  browser instance this run is paused on. Requires WebSurface's `enableRemoteControl`. */
  cdpEndpoint: string;
  /** Loopback port the `ControlLock`'s tiny HTTP server is listening on — see control-lock.ts. */
  controlPort: number;
  /** Where this run's evidence bundle (screenshots + log.jsonl) lives, for an operator who wants
   *  more context than `recentSteps` before deciding what to do. */
  evidenceDir?: string;
  createdAt: string;
}
