/**
 * Integration tests for the HITL handoff (§3.6) against a REAL live browser — the one thing a
 * unit test with a `FakeSurface` (see tests/unit/discovery-loop.test.ts and
 * tests/unit/control-lock.test.ts) structurally cannot prove: that a *second, independent*
 * Playwright connection — standing in for the separate `operator-cli.ts` process a human would
 * actually run — really does attach to the SAME live browser instance and see/affect the SAME
 * page, rather than a disconnected copy. That's the "real mechanism" half of the assignment's
 * chosen design ("mocked but real mechanism: pause signal + a tiny CLI/HTTP operator that
 * attaches to the SAME live Playwright browser context").
 *
 * No Anthropic key needed: the discovery loop here uses the same scripted `AgentDecisionClient`
 * test double as the unit tests, so only the browser and HTTP pieces are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { WebSurface } from "../../src/surface/web-surface.js";
import { GuardedSurface } from "../../src/safety/guarded-surface.js";
import { AllowlistPolicy, loadAllowlistConfig } from "../../src/config/allowlist.js";
import { DiscoveryAgentLoop, type EscalationContext, type EscalationDecision } from "../../src/agent/loop.js";
import type { AgentDecisionClient } from "../../src/agent/claude-client.js";
import { ControlLock } from "../../src/hitl/control-lock.js";

const TEST_TIMEOUT_MS = 30_000;
const TARGET = { app: loadAllowlistConfig().app, baseUrl: "https://www.saucedemo.com" };

function toolUseMessage(name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    id: `msg_${name}`,
    content: [{ type: "tool_use", id: `toolu_${name}_${Math.random()}`, name, input }],
    model: "test-model",
    role: "assistant",
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

class ScriptedClient implements AgentDecisionClient {
  readonly model = "test-model";
  private index = 0;
  constructor(private readonly responses: Anthropic.Message[]) {}

  async decide(): Promise<Anthropic.Message> {
    const response = this.responses[this.index];
    if (!response) throw new Error("ScriptedClient exhausted");
    this.index += 1;
    return response;
  }
}

let webSurface: WebSurface | undefined;

afterEach(async () => {
  await webSurface?.close();
  webSurface = undefined;
});

describe("HITL handoff against a live browser", () => {
  it(
    "lets a second, independent Playwright connection attach to the SAME live page a WebSurface owns",
    async () => {
      webSurface = await WebSurface.launch({ headless: true, enableRemoteControl: true, startUrl: TARGET.baseUrl });
      const cdpEndpoint = webSurface.cdpEndpoint;
      expect(cdpEndpoint).toBeTruthy();

      // Stands in for the separate `operator-cli.ts` process: its own connectOverCDP() call,
      // not something obtained from `webSurface` in-process.
      const operatorBrowser = await chromium.connectOverCDP(cdpEndpoint!);
      try {
        const operatorPage = operatorBrowser.contexts()[0]?.pages()[0];
        expect(operatorPage).toBeDefined();
        expect(operatorPage!.url()).toBe(webSurface.currentUrl());

        // Prove it's genuinely shared live state, not just a coincidentally-matching URL: an
        // action taken through the OPERATOR's connection is visible back through the ORIGINAL
        // WebSurface's own observe(). (Deliberately navigating within the public root page via
        // a query param, not to e.g. /inventory.html — saucedemo's own client-side JS redirects
        // unauthenticated visitors straight back out of protected pages, which would make this
        // assertion flaky for reasons that have nothing to do with the CDP mechanism.)
        await operatorPage!.goto(`${TARGET.baseUrl}/?operator=attached`, { waitUntil: "domcontentloaded" });
      } finally {
        // Disconnect only — must NOT tear down the real browser the discovery run still owns.
        await operatorBrowser.close();
      }

      expect(webSurface.currentUrl()).toContain("operator=attached");
      // And the original surface is still fully alive/usable after the operator disconnected.
      const observation = await webSurface.observe();
      expect(observation.url).toContain("operator=attached");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs the full escalate -> ControlLock -> operator attaches & resumes -> completes pipeline",
    async () => {
      webSurface = await WebSurface.launch({ headless: true, enableRemoteControl: true });
      const surface = new GuardedSurface(webSurface, new AllowlistPolicy(loadAllowlistConfig()));
      const client = new ScriptedClient([
        toolUseMessage("escalate", { reason: "integration-test escalation" }),
        toolUseMessage("finish", { summary: "done after the operator verified the live session" }),
      ]);

      let resolvePort!: (port: number) => void;
      const portReady = new Promise<number>((resolve) => {
        resolvePort = resolve;
      });

      // The loop's half of the contract — this mirrors exactly what `discover.ts`'s onEscalate
      // does: open a ControlLock (real HTTP server), publish it (here: via a promise; the real
      // CLI writes intervention.json to disk instead), and block until an operator responds.
      const onEscalate = async (context: EscalationContext): Promise<EscalationDecision> => {
        const lock = await ControlLock.open({
          runId: "hitl-integration-test",
          reason: context.reason,
          explicit: context.explicit,
          goal: "integration test goal",
          currentUrl: context.observation.url,
          recentSteps: [],
          cdpEndpoint: webSurface!.cdpEndpoint!,
          createdAt: new Date().toISOString(),
        });
        resolvePort(lock.intervention.controlPort);
        const outcome = await lock.waitForOperator(TEST_TIMEOUT_MS);
        await lock.close();
        return outcome.outcome === "resumed" ? { action: "resume", notes: outcome.notes } : { action: "abort" };
      };

      const loop = new DiscoveryAgentLoop(surface, client, { onEscalate });

      // The operator side: a fully independent async flow that only talks to the ControlLock
      // over HTTP and to the browser over its own chromium.connect() — exactly the two things
      // operator-cli.ts is allowed to know about a running discover process.
      const operatorWork = (async () => {
        const port = await portReady;

        const interventionRes = await fetch(`http://127.0.0.1:${port}/intervention`);
        expect(interventionRes.status).toBe(200);
        const intervention = (await interventionRes.json()) as { reason: string; cdpEndpoint: string };
        expect(intervention.reason).toBe("integration-test escalation");

        const operatorBrowser = await chromium.connectOverCDP(intervention.cdpEndpoint);
        try {
          const operatorPage = operatorBrowser.contexts()[0]?.pages()[0];
          expect(operatorPage?.url()).toBe(TARGET.baseUrl + "/");
        } finally {
          await operatorBrowser.close();
        }

        const resumeRes = await fetch(`http://127.0.0.1:${port}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notes: "verified the live session, all clear" }),
        });
        expect(resumeRes.status).toBe(200);
      })();

      const [trace] = await Promise.all([loop.run("integration test goal", TARGET, []), operatorWork]);

      expect(trace.status).toBe("completed");
      expect(trace.turns.map((t) => t.toolCall.name)).toEqual(["escalate", "finish"]);
    },
    TEST_TIMEOUT_MS,
  );
});
