#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { GuardedSurface } from "../safety/guarded-surface.js";
import { redactSensitiveValues, type RedactableValue } from "../safety/redaction.js";
import { ArtifactStore } from "../artifact/store.js";
import { loadAllowlistConfig, AllowlistPolicy } from "../config/allowlist.js";
import type { CapabilityArtifact, PrimitiveType } from "../artifact/schema.js";
import { ReplayExecutor, type ReplayParams, type StepLogEvent } from "../replay/executor.js";
import { ReplayInputValidationError, UnapprovedRiskyArtifactError } from "../replay/outcomes.js";
import type { ReplayResult } from "../replay/outcomes.js";
import { collect, createEvidenceBundle, launchWebSurface, parseKeyValueParams, parseRedactNames } from "./cli-shared.js";

/**
 * `replay`: the production execution path (§3.3) — re-runs a saved `CapabilityArtifact` with no
 * LLM in the loop, given a set of typed input parameters. This is deliberately the mirror image
 * of `discover.ts`: same evidence bundling (JSONL log + screenshots under evidence/<runId>/),
 * same redaction discipline for sensitive params, but no agent, no messages, no model calls —
 * just `ArtifactStore.load` -> `ReplayExecutor.run` -> a structured `ReplayResult`.
 *
 * Exit codes are deliberately distinguishable for scripting (this is the path an AI agent would
 * invoke in production, and a caller needs to tell these apart programmatically):
 *   0 success            — checkpoint held, declared outputs returned.
 *   1 hard_failure        — an unanticipated runtime condition; needs a human/engineer to look.
 *   2 caller/input error — bad --param, unknown capability, or an unapproved risky artifact.
 *   3 business_outcome    — a legitimate, anticipated non-happy-path result (not a bug).
 */

/** Splits `--param name=value` flags into a raw string map — coercion into the artifact's
 *  declared input types happens separately in `coerceParams`, once we know what those types
 *  are. A thin, name-preserving re-export of `cli-shared.ts`'s `parseKeyValueParams` (exported
 *  under this name for unit testing — tests/unit/replay-cli.test.ts imports it as
 *  `parseRawParams`). */
export const parseRawParams = parseKeyValueParams;

function coercePrimitive(value: string, type: PrimitiveType): string | number | boolean {
  if (type === "number") {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`--param value "${value}" is not a valid number`);
    }
    return parsed;
  }
  if (type === "boolean") return value.trim().toLowerCase() === "true";
  return value;
}

/** CLI params always arrive as strings; the artifact's `inputs[].type` is the one source of
 *  truth for what each should actually be — `ReplayExecutor.run`'s own param validation checks
 *  `typeof value !== input.type`, so a numeric/boolean input passed as a raw string would
 *  otherwise fail that check for a reason that has nothing to do with the value being wrong. A
 *  name the artifact doesn't declare is passed through as a string unchanged: `ReplayExecutor`
 *  only rejects *missing* required inputs, never *extra* ones, so rejecting it here would be an
 *  inconsistency, not a safety improvement. */
export function coerceParams(raw: Record<string, string>, artifact: CapabilityArtifact): ReplayParams {
  const coerced: ReplayParams = {};
  for (const [name, value] of Object.entries(raw)) {
    const input = artifact.inputs.find((i) => i.name === name);
    coerced[name] = input ? coercePrimitive(value, input.type) : value;
  }
  return coerced;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("replay")
    .description("Deterministically replay a saved CapabilityArtifact against the live target — no LLM in the loop.")
    .requiredOption("--capability-id <id>", "Capability id to replay, e.g. saucedemo.add_item_and_checkout")
    .option("--version <n>", "Specific version to replay (defaults to the latest saved version).")
    .option("--artifacts-dir <dir>", "Directory to load capability artifacts from.", "artifacts")
    .option("--param <name=value>", "Input value for the artifact. Repeatable.", collect, [] as string[])
    .option("--redact <names>", "Comma-separated subset of --param names to treat as sensitive in logs.", "")
    .option("--headless", "Run the browser headless (default: PLAYWRIGHT_HEADLESS from .env).")
    .option(
      "--slow-mo-ms <n>",
      "Pause this many ms after every browser operation, purely so a headed run is easy to " +
        "watch. No effect on correctness — omit for normal/unattended speed.",
    )
    .option("--evidence-dir <dir>", "Root directory evidence bundles (screenshots + log.jsonl) are saved into.", "evidence")
    .option(
      "--run-id <id>",
      "Evidence bundle folder name under --evidence-dir (default: a random UUID). Useful for " +
        "producing a deliberately-named, reproducible evidence bundle (e.g. for a demo or a " +
        "regression fixture) instead of a fresh UUID on every invocation.",
    );

  program.parse();
  const options = program.opts<{
    capabilityId: string;
    version?: string;
    artifactsDir: string;
    param: string[];
    redact: string;
    headless?: boolean;
    slowMoMs?: string;
    evidenceDir: string;
    runId?: string;
  }>();

  const store = new ArtifactStore(options.artifactsDir);
  const artifact = options.version
    ? await store.load(options.capabilityId, Number(options.version))
    : await store.loadLatest(options.capabilityId);

  const rawParams = parseRawParams(options.param);
  const redactNames = parseRedactNames(options.redact);
  const params = coerceParams(rawParams, artifact);
  // Shared with logTurn-equivalent logging below, exactly like discover.ts's paramHints: every
  // console/JSONL line derived from a step result is passed through this before being written.
  const redactableValues: RedactableValue[] = Object.entries(rawParams).map(([name, value]) => ({
    name,
    value,
    redact: redactNames.has(name),
  }));

  console.log(`[replay] capability: ${artifact.id} v${artifact.version} — ${artifact.name}`);
  console.log(`[replay] status: ${artifact.status}, risk: ${artifact.policy.riskLevel}`);
  console.log(
    `[replay] params: ${
      Object.entries(rawParams)
        .map(([name, value]) => `${name}=${redactNames.has(name) ? "[REDACTED]" : value}`)
        .join(", ") || "(none)"
    }`,
  );

  const allowlistConfig = loadAllowlistConfig();
  const policy = new AllowlistPolicy(allowlistConfig);
  const rawSurface = await launchWebSurface({ headless: options.headless, slowMoMs: options.slowMoMs });
  // An approved artifact is trusted to perform whatever it recorded, including a step that
  // happens to match a risky-control heuristic (e.g. clicking "Finish") — that trust decision
  // was made once, by a human, at approval time (see artifact.status and §8's confidence/approval
  // stretch goal). A non-approved artifact still gets GuardedSurface's protective default here,
  // as defense in depth alongside ReplayExecutor's own approval gate (which already refuses to
  // even start a risky, unapproved artifact — see enforceApprovalGate in src/replay/executor.ts).
  const surface = new GuardedSurface(rawSurface, policy, { allowRiskyActions: artifact.status === "approved" });

  const runId = options.runId ?? randomUUID();
  const { bundleDir, jsonlLogger, screenshotSink } = createEvidenceBundle(options.evidenceDir, runId, surface);
  console.log(`[replay] run id: ${runId} (evidence -> ${bundleDir})`);

  const onStep = async (event: StepLogEvent): Promise<void> => {
    const redactedError = event.error ? redactSensitiveValues(event.error, redactableValues) : undefined;
    const matched = event.matchedExpected
      ? ` matched ${event.matchedExpected.classification}${event.matchedExpected.outcomeCode ? `:${event.matchedExpected.outcomeCode}` : ""}`
      : "";
    console.log(`[replay] step ${event.stepId} (${event.action}): ${event.ok ? "ok" : `FAILED: ${redactedError}`}${matched}`);
    await jsonlLogger.log({ ...event, event: "step", error: redactedError });
  };

  const executor = new ReplayExecutor(surface, { evidenceSink: screenshotSink, onStep });

  let result: ReplayResult | undefined;
  let thrown: unknown;
  try {
    result = await executor.run(artifact, params);
  } catch (err) {
    thrown = err;
  } finally {
    await rawSurface.close();
  }

  if (thrown) {
    if (thrown instanceof ReplayInputValidationError || thrown instanceof UnapprovedRiskyArtifactError) {
      console.error(`[replay] ${thrown.name}: ${thrown.message}`);
      await jsonlLogger.log({ event: "run_rejected", error: thrown.name, message: thrown.message });
      process.exitCode = 2;
      return;
    }
    throw thrown;
  }

  // `result` is always assigned once we get here (either `thrown` is set and we already
  // returned above, or executor.run() resolved) — this narrows it for TypeScript.
  const finalResult = result!;
  await jsonlLogger.log({ event: "run_finished", ...finalResult });

  switch (finalResult.kind) {
    case "success":
      console.log(`[replay] SUCCESS. outputs: ${JSON.stringify(finalResult.outputs)}`);
      console.log(`[replay] evidence: ${finalResult.evidenceId}`);
      process.exitCode = 0;
      return;
    case "business_outcome":
      console.log(
        `[replay] BUSINESS OUTCOME "${finalResult.outcomeCode}" at step "${finalResult.stepId}": ${finalResult.description}`,
      );
      console.log(`[replay] evidence: ${finalResult.evidenceId}`);
      process.exitCode = 3;
      return;
    case "hard_failure":
      console.error(
        `[replay] HARD FAILURE at step "${finalResult.stepId}".\n  expected: ${finalResult.expected}\n  observed: ${finalResult.observed}`,
      );
      console.error(`[replay] evidence: ${finalResult.evidenceId}`);
      process.exitCode = 1;
      return;
  }
}

// Only run the CLI when this file is executed directly (`tsx src/cli/replay.ts` / `npm run
// replay`) — NOT when something merely imports `coerceParams`/`parseRawParams` from it (as
// tests/unit/replay-cli.test.ts does). Without this guard, importing this module for its pure
// helpers would call `main()` as a side effect and run `program.parse()` against whatever
// `process.argv` the importer happens to have (e.g. the test runner's own args) — Commander then
// fails the missing --capability-id check and calls `process.exit(1)` for real, taking the
// importing process down with it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[replay] fatal error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
