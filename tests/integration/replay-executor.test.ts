/**
 * Integration tests for the replay executor — run against the REAL live target (saucedemo.com),
 * not a mock DOM. This is deliberate: the brief's central concern is runtime UI behavior
 * (validation errors, locked-out accounts, transient timing), which a mocked DOM can't exercise
 * honestly. These are slower than a typical unit test; that's an accepted trade-off for testing
 * "where it counts" per the brief's code-quality criterion.
 *
 * These tests also wire in the REAL evidence pipeline (Phase 7) — `ScreenshotEvidenceSink`
 * against the live page, plus a `JsonlLogger` fed by `onStep` — rather than the default
 * `NullEvidenceSink`/no-op logging. Replay needs no LLM, so this is the cheapest way to prove
 * the evidence bundle machinery produces real files with real content end-to-end, ahead of an
 * actual `discover` run (which needs a live Anthropic key we don't have yet).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSurface } from "../../src/surface/web-surface.js";
import { GuardedSurface } from "../../src/safety/guarded-surface.js";
import { AllowlistPolicy, loadAllowlistConfig } from "../../src/config/allowlist.js";
import { ArtifactStore } from "../../src/artifact/store.js";
import { ReplayExecutor, type StepLogEvent } from "../../src/replay/executor.js";
import { ReplayInputValidationError, UnapprovedRiskyArtifactError } from "../../src/replay/outcomes.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { ScreenshotEvidenceSink } from "../../src/evidence/screenshot-sink.js";
import { JsonlLogger } from "../../src/evidence/jsonl-logger.js";

const FIXTURES_DIR = path.join(process.cwd(), "tests", "fixtures");
const TEST_TIMEOUT_MS = 45_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let webSurface: WebSurface;
let executor: ReplayExecutor;
let artifact: CapabilityArtifact;
let evidenceDir: string;
let jsonlLogger: JsonlLogger;
let stepEvents: StepLogEvent[];

beforeEach(async () => {
  const store = new ArtifactStore(FIXTURES_DIR);
  artifact = await store.loadLatest("saucedemo.add_item_and_checkout");
  webSurface = await WebSurface.launch({ headless: true });
  const guarded = new GuardedSurface(webSurface, new AllowlistPolicy(loadAllowlistConfig()));

  evidenceDir = await mkdtemp(path.join(tmpdir(), "replay-evidence-test-"));
  jsonlLogger = new JsonlLogger(path.join(evidenceDir, "log.jsonl"));
  stepEvents = [];

  executor = new ReplayExecutor(guarded, {
    evidenceSink: new ScreenshotEvidenceSink(guarded, evidenceDir),
    onStep: async (event) => {
      stepEvents.push(event);
      await jsonlLogger.log({ event: "step", ...event });
    },
  });
});

afterEach(async () => {
  await webSurface?.close();
  if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
});

describe("ReplayExecutor against the live saucedemo target", () => {
  it(
    "succeeds end-to-end and returns typed outputs on the happy path",
    async () => {
      const result = await executor.run(artifact, {
        username: "standard_user",
        password: "secret_sauce",
        firstName: "Ada",
        lastName: "Lovelace",
        postalCode: "94107",
      });

      expect(result.kind).toBe("success");
      if (result.kind !== "success") return; // narrows for TS below
      expect(result.outputs.itemTotalText).toBe("Item total: $29.99");
      expect(result.outputs.taxText).toBe("Tax: $2.40");
      expect(result.outputs.totalText).toBe("Total: $32.39");

      // Real evidence, produced by the actual pipeline (Phase 7) — not a mock. The screenshot
      // is a genuine PNG captured from the live page, and the JSONL log has one real line per
      // step of this exact run.
      const screenshotBytes = await readFile(result.evidenceId);
      expect(screenshotBytes.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
      expect(stepEvents.length).toBe(artifact.steps.length);
      expect(stepEvents.every((e) => e.ok)).toBe(true);

      const logLines = (await readFile(path.join(evidenceDir, "log.jsonl"), "utf-8")).trim().split("\n");
      expect(logLines.length).toBeGreaterThanOrEqual(artifact.steps.length);
      expect(JSON.parse(logLines[0]!)).toMatchObject({ event: "step", stepId: artifact.steps[0]!.id });

      const screenshotFiles = await readdir(path.join(evidenceDir, "screenshots"));
      expect(screenshotFiles).toContain(path.basename(result.evidenceId));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns a business_outcome (not a crash) when the account is locked out",
    async () => {
      const result = await executor.run(artifact, {
        username: "locked_out_user",
        password: "secret_sauce",
        firstName: "Ada",
        lastName: "Lovelace",
        postalCode: "94107",
      });

      expect(result.kind).toBe("business_outcome");
      if (result.kind !== "business_outcome") return;
      expect(result.outcomeCode).toBe("user_locked_out");
      expect(result.stepId).toBe("click-login");

      // A business outcome still captures real evidence — it's a legitimate result, not a
      // crash, and a reviewer should be able to see the locked-out screen exactly as it appeared.
      const screenshotBytes = await readFile(result.evidenceId);
      expect(screenshotBytes.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns a business_outcome (not a crash) when a required checkout field is invalid",
    async () => {
      const result = await executor.run(artifact, {
        username: "standard_user",
        password: "secret_sauce",
        firstName: "Ada",
        lastName: "Lovelace",
        postalCode: "", // deliberately invalid: required field left blank
      });

      expect(result.kind).toBe("business_outcome");
      if (result.kind !== "business_outcome") return;
      expect(result.outcomeCode).toBe("validation_error");
      expect(result.stepId).toBe("click-continue");
    },
    TEST_TIMEOUT_MS,
  );

  it("throws ReplayInputValidationError (not a ReplayResult) for a missing required input", async () => {
    await expect(
      executor.run(artifact, {
        username: "standard_user",
        // password omitted entirely
        firstName: "Ada",
        lastName: "Lovelace",
        postalCode: "94107",
      }),
    ).rejects.toThrow(ReplayInputValidationError);
  });

  it("refuses to run a risky, unapproved artifact unattended", async () => {
    const riskyDraft: CapabilityArtifact = {
      ...artifact,
      policy: { riskLevel: "risky", requiresApproval: true },
      status: "draft",
    };
    await expect(
      executor.run(riskyDraft, {
        username: "standard_user",
        password: "secret_sauce",
        firstName: "Ada",
        lastName: "Lovelace",
        postalCode: "94107",
      }),
    ).rejects.toThrow(UnapprovedRiskyArtifactError);
  });
});
