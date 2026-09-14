#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { env, requireAnthropicApiKey } from "../config/env.js";
import { loadAllowlistConfig, AllowlistPolicy } from "../config/allowlist.js";
import { WebSurface } from "../surface/web-surface.js";
import { GuardedSurface } from "../safety/guarded-surface.js";
import { redactSensitiveValues } from "../safety/redaction.js";
import { ClaudeAgentClient } from "../agent/claude-client.js";
import { DiscoveryAgentLoop, type EscalationContext, type EscalationDecision } from "../agent/loop.js";
import type { ParamHint } from "../agent/prompt.js";
import type { RunTraceTurn } from "../agent/run-trace.js";
import { ArtifactStore } from "../artifact/store.js";
import { recordArtifact } from "../artifact/recorder.js";
import { JsonlLogger } from "../evidence/jsonl-logger.js";
import { ScreenshotEvidenceSink } from "../evidence/screenshot-sink.js";
import { ControlLock } from "../hitl/control-lock.js";

const DEFAULT_ESCALATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Redacted, human-readable label for a turn's tool call — e.g. `type "text" — reasoning`.
 *  Shared by the live step log's `detail` field and `InterventionRequest.recentSteps`. */
function describeTurn(turn: RunTraceTurn, paramHints: ParamHint[]): string {
  const call = turn.toolCall;
  const detail = "reasoning" in call ? call.reasoning : "reason" in call ? call.reason : "summary" in call ? call.summary : "";
  const payload = "text" in call ? ` "${call.text}"` : "value" in call ? ` "${call.value}"` : "";
  return redactSensitiveValues(`${call.name}${payload} — ${detail}`, paramHints);
}

/** `describeTurn` plus its ok/error outcome, redacted — the one-liner shown in the console and
 *  offered to a HITL operator as `recentSteps`; the JSONL log keeps `ok`/`error` as separate
 *  structured fields instead (see `logTurn`) so this suffix is deliberately NOT baked into the
 *  `detail` field written there. */
function describeTurnWithOutcome(turn: RunTraceTurn, paramHints: ParamHint[]): string {
  const label = describeTurn(turn, paramHints);
  if (turn.actionResult.ok) return `${label} (ok)`;
  return `${label} (FAILED: ${redactSensitiveValues(turn.actionResult.error ?? "", paramHints)})`;
}

/**
 * `discover`: runs the Claude-driven discovery loop (Phase 4) against a live target, then — only
 * if the run genuinely completes — records the result as a `CapabilityArtifact` (Phase 5's
 * recorder) and saves it via `ArtifactStore`.
 *
 * A run that escalates, times out, hits max-steps, or dead-ends is reported but deliberately NOT
 * recorded: an artifact is a claim that "this flow works," and only a run that called `finish`
 * substantiates that claim. See src/artifact/recorder.ts's module doc comment for what recording
 * does and does not do automatically.
 */

function parseParams(rawParams: string[], redactNames: Set<string>): ParamHint[] {
  return rawParams.map((raw) => {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--param "${raw}" is not in the form name=value`);
    }
    const name = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    return { name, value, redact: redactNames.has(name) };
  });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("discover")
    .description("Run the Claude-driven discovery agent against a live target and record a CapabilityArtifact.")
    .requiredOption("--goal <goal>", "Natural-language goal for the discovery agent to accomplish.")
    .requiredOption(
      "--capability-id <id>",
      "Stable id to save the recorded capability under, e.g. saucedemo.add_item_and_checkout",
    )
    .option("--name <name>", "Human-readable capability name (defaults to the capability id).")
    .option("--description <description>", "Capability description (defaults to the goal).")
    .option("--app <app>", "Target application name (defaults to the allowlist config's app).")
    .option("--param <name=value>", "Example value the agent should use verbatim. Repeatable.", collect, [] as string[])
    .option("--redact <names>", "Comma-separated subset of --param names to treat as sensitive.", "")
    .option("--max-steps <n>", "Stop the run after this many turns.", "25")
    .option("--timeout-ms <n>", "Stop the run after this many milliseconds.", String(3 * 60 * 1000))
    .option("--headless", "Run the browser headless (default: PLAYWRIGHT_HEADLESS from .env).")
    .option(
      "--slow-mo-ms <n>",
      "Pause this many ms after every browser operation, purely so a headed run is easy to " +
        "watch. No effect on correctness — omit for normal speed.",
    )
    .option("--artifacts-dir <dir>", "Directory recorded capability artifacts are saved into.", "artifacts")
    .option("--evidence-dir <dir>", "Root directory evidence bundles (screenshots + log.jsonl) are saved into.", "evidence")
    .option("--dry-run", "Run discovery but never save an artifact, even on success.", false)
    .option("--no-hitl", "Disable the human-in-the-loop handoff — an escalation aborts the run immediately instead of waiting for an operator.")
    .option(
      "--escalation-timeout-ms <n>",
      "How long to wait for a human operator before giving up on an escalated run.",
      String(DEFAULT_ESCALATION_TIMEOUT_MS),
    );

  program.parse();
  const options = program.opts<{
    goal: string;
    capabilityId: string;
    name?: string;
    description?: string;
    app?: string;
    param: string[];
    redact: string;
    maxSteps: string;
    timeoutMs: string;
    headless?: boolean;
    slowMoMs?: string;
    artifactsDir: string;
    evidenceDir: string;
    dryRun: boolean;
    hitl: boolean;
    escalationTimeoutMs: string;
  }>();

  const apiKey = requireAnthropicApiKey();
  const allowlistConfig = loadAllowlistConfig();
  const policy = new AllowlistPolicy(allowlistConfig);

  const redactNames = new Set(options.redact.split(",").map((s) => s.trim()).filter(Boolean));
  const paramHints = parseParams(options.param, redactNames);

  const target = { app: options.app ?? allowlistConfig.app, baseUrl: env.TARGET_BASE_URL };

  console.log(`[discover] goal: ${options.goal}`);
  console.log(`[discover] target: ${target.app} @ ${target.baseUrl}`);
  console.log(
    `[discover] params: ${paramHints.map((p) => `${p.name}=${p.redact ? "[REDACTED]" : p.value}`).join(", ") || "(none)"}`,
  );

  // enableRemoteControl is tied 1:1 to --hitl: it's the only reason a second process would ever
  // need to attach to this exact browser (see WebSurface's doc comment on the option).
  const rawSurface = await WebSurface.launch({
    headless: options.headless ?? env.PLAYWRIGHT_HEADLESS,
    enableRemoteControl: options.hitl,
    slowMoMs: options.slowMoMs !== undefined ? Number(options.slowMoMs) : undefined,
  });
  // allowRiskyActions is deliberately omitted (defaults to false): an autonomous discovery run
  // has no prior human sign-off, so a click matching a risky-control rule (e.g. "Finish Order")
  // must be blocked and surfaced to the model as a reason to escalate, never executed live.
  const surface = new GuardedSurface(rawSurface, policy);
  const client = new ClaudeAgentClient(apiKey, env.ANTHROPIC_MODEL);

  // Generated up front (rather than letting the loop assign one) so the evidence bundle's
  // directory name and the RunTrace's own runId are the same value — one correlation key, not
  // two — see DiscoveryLoopOptions.runId's doc comment in src/agent/loop.ts.
  const runId = randomUUID();
  const bundleDir = path.join(options.evidenceDir, runId);
  const jsonlLogger = new JsonlLogger(path.join(bundleDir, "log.jsonl"));
  const screenshotSink = new ScreenshotEvidenceSink(surface, bundleDir);
  console.log(`[discover] run id: ${runId} (evidence -> ${bundleDir})`);

  // Every field logged below — to the console AND to log.jsonl — flows through
  // redactSensitiveValues first. "text"/"value" carry whatever the model typed/selected, which
  // is exactly where a --redact'd param's raw value would otherwise leak into a terminal, a
  // persisted log file, or a screen share.
  const logTurn = async (turn: RunTraceTurn): Promise<void> => {
    const call = turn.toolCall;
    console.log(`[discover] step ${turn.index}: ${describeTurnWithOutcome(turn, paramHints)}`);

    // Awaited (not fire-and-forget): the screenshot must be taken before the loop's next turn
    // starts mutating the page, or it stops being trustworthy evidence of THIS turn.
    const evidenceId = await screenshotSink.capture(`turn-${turn.index}-${call.name}`);
    const redactedError = turn.actionResult.error ? redactSensitiveValues(turn.actionResult.error, paramHints) : undefined;
    await jsonlLogger.log({
      event: "turn",
      index: turn.index,
      tool: call.name,
      detail: describeTurn(turn, paramHints),
      ok: turn.actionResult.ok,
      error: redactedError,
      observationUrl: turn.observationUrl,
      evidenceId,
    });
  };

  // The HITL escalation decision point (§3.6). Opens a ControlLock — a tiny local HTTP server
  // exposing this run's live cdpEndpoint — writes the InterventionRequest to the evidence bundle
  // for an operator to read, and blocks (up to --escalation-timeout-ms) until one shows up and
  // signals resume/abort. If --no-hitl was passed, this is never even wired in, and the loop
  // falls back to its no-handler default of aborting immediately — see DiscoveryLoopOptions in
  // src/agent/loop.ts.
  const onEscalate = options.hitl
    ? async (context: EscalationContext): Promise<EscalationDecision> => {
        const reason = redactSensitiveValues(context.reason, paramHints);
        console.log(`[discover] ESCALATED (${context.explicit ? "agent-requested" : "automatic dead-end"}): ${reason}`);
        await jsonlLogger.log({ event: "escalated", reason, explicit: context.explicit });

        const recentSteps = context.turnsSoFar.slice(-5).map((t) => describeTurnWithOutcome(t, paramHints));
        const lock = await ControlLock.open({
          runId,
          reason,
          explicit: context.explicit,
          goal: options.goal,
          currentUrl: context.observation.url,
          recentSteps,
          // rawSurface.cdpEndpoint is guaranteed set here: enableRemoteControl was passed
          // above precisely because options.hitl (this branch's guard) is true.
          cdpEndpoint: rawSurface.cdpEndpoint!,
          evidenceDir: bundleDir,
          createdAt: new Date().toISOString(),
        });
        const interventionPath = path.join(bundleDir, "intervention.json");
        await writeFile(interventionPath, `${JSON.stringify(lock.intervention, null, 2)}\n`, "utf-8");

        const timeoutMs = Number(options.escalationTimeoutMs);
        console.log(`[discover] waiting for a human operator (up to ${Math.round(timeoutMs / 1000)}s). In another terminal:`);
        console.log(`  npm run operator -- --request ${interventionPath}`);

        const result = await lock.waitForOperator(timeoutMs);
        await lock.close();

        if (result.outcome === "resumed") {
          console.log(`[discover] operator resumed the run.${result.notes ? ` notes: "${result.notes}"` : ""}`);
          await jsonlLogger.log({ event: "operator_resumed", notes: result.notes });
          return { action: "resume", notes: result.notes };
        }
        if (result.outcome === "aborted") {
          console.log(`[discover] operator aborted the run.${result.notes ? ` notes: "${result.notes}"` : ""}`);
          await jsonlLogger.log({ event: "operator_aborted", notes: result.notes });
        } else {
          console.log("[discover] no operator responded in time — giving up.");
          await jsonlLogger.log({ event: "operator_timeout" });
        }
        return { action: "abort" };
      }
    : undefined;

  const loop = new DiscoveryAgentLoop(surface, client, {
    maxSteps: Number(options.maxSteps),
    timeoutMs: Number(options.timeoutMs),
    runId,
    onTurn: logTurn,
    onEscalate,
  });

  let runTrace;
  try {
    runTrace = await loop.run(options.goal, target, paramHints);
  } finally {
    await rawSurface.close();
  }

  console.log(`[discover] run ${runTrace.runId} finished with status: ${runTrace.status}`);
  console.log(`[discover] final URL: ${runTrace.finalUrl}`);
  console.log(`[discover] evidence bundle: ${bundleDir} (${runTrace.turns.length} screenshot(s) + log.jsonl)`);
  const redactedEscalationReason = runTrace.escalationReason
    ? redactSensitiveValues(runTrace.escalationReason, paramHints)
    : undefined;
  if (redactedEscalationReason) {
    console.log(`[discover] reason: ${redactedEscalationReason}`);
  }
  await jsonlLogger.log({
    event: "run_finished",
    status: runTrace.status,
    finalUrl: runTrace.finalUrl,
    escalationReason: redactedEscalationReason,
  });

  if (runTrace.status !== "completed") {
    console.error(
      `[discover] run did not complete (status: ${runTrace.status}) — no CapabilityArtifact will be recorded. ` +
        "Re-run with a narrower goal, or investigate the transcript above.",
    );
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    console.log("[discover] --dry-run set: run completed successfully but no artifact was saved.");
    return;
  }

  const store = new ArtifactStore(options.artifactsDir);
  const version = await store.nextVersion(options.capabilityId);
  const artifact = recordArtifact(runTrace, policy, {
    capabilityId: options.capabilityId,
    version,
    name: options.name ?? options.capabilityId,
    description: options.description ?? options.goal,
    surfaceType: "web",
  });
  const filePath = await store.save(artifact);

  console.log(
    `[discover] recorded "${artifact.id}" v${artifact.version} (${artifact.steps.length} step(s), ` +
      `risk: ${artifact.policy.riskLevel}, status: ${artifact.status}) -> ${filePath}`,
  );
  console.log("[discover] review the artifact before approving it for unattended replay.");
}

// See the matching guard in src/cli/replay.ts for why this check exists: it keeps `main()` from
// running as an import-time side effect if something ever imports this module for its helpers
// (e.g. `describeTurn`) rather than executing it as the CLI entrypoint.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[discover] fatal error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
