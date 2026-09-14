#!/usr/bin/env tsx
/**
 * The human side of the HITL handoff (§3.6). Run this in a second terminal while a `discover`
 * run is escalated and waiting. It:
 *
 *   1. Reads the `InterventionRequest` a paused `discover` run wrote to disk (the ControlLock's
 *      `GET /intervention` serves the identical JSON, for anything that would rather poll over
 *      HTTP than read a file — e.g. a remote operator, or just `curl`).
 *   2. Attaches to the SAME live browser via `chromium.connectOverCDP(cdpEndpoint)` — not a new,
 *      disconnected browser. Because the browser is headed (PLAYWRIGHT_HEADLESS=false), this
 *      window is already visible on screen; the operator can just reach for the mouse. (Plain
 *      Playwright `connect()` was tried first and doesn't work for this — each connection gets
 *      an isolated view of contexts/pages; only the CDP-level attach shares live state across
 *      independent connections. See tests/integration/hitl-handoff.test.ts.)
 *   3. Also offers a few scripted convenience commands (`goto`, `click`, `screenshot`) driven
 *      through the same Playwright connection, for when direct mouse/keyboard interaction with
 *      the visible window isn't practical (e.g. the target machine is headless/remote).
 *   4. On `resume`, POSTs back to the ControlLock so the paused agent loop continues; on
 *      `abort`, POSTs the alternate signal so the run gives up now rather than timing out.
 */
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InterventionRequest } from "./types.js";

interface OperatorArgs {
  requestPath?: string;
  host: string;
}

function parseArgs(argv: string[]): OperatorArgs {
  const args: OperatorArgs = { host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--request") args.requestPath = argv[++i];
    else if (argv[i] === "--host") args.host = argv[++i]!;
  }
  return args;
}

async function loadIntervention(requestPath: string): Promise<InterventionRequest> {
  const raw = await readFile(requestPath, "utf-8");
  return JSON.parse(raw) as InterventionRequest;
}

async function postSignal(host: string, port: number, endpoint: "resume" | "abort", notes?: string): Promise<void> {
  const res = await fetch(`http://${host}:${port}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) {
    throw new Error(`${endpoint} signal rejected: HTTP ${res.status}`);
  }
}

function printBanner(intervention: InterventionRequest): void {
  console.log("\n=== HITL escalation ===");
  console.log(`run id:     ${intervention.runId}`);
  console.log(`goal:       ${intervention.goal}`);
  console.log(`escalated:  ${intervention.explicit ? "by the agent (explicit escalate call)" : "automatically (stuck / dead end)"}`);
  console.log(`reason:     ${intervention.reason}`);
  console.log(`current url: ${intervention.currentUrl}`);
  if (intervention.recentSteps.length > 0) {
    console.log("recent steps:");
    for (const step of intervention.recentSteps) console.log(`  - ${step}`);
  }
  if (intervention.evidenceDir) console.log(`evidence:   ${intervention.evidenceDir}`);
  console.log("========================\n");
}

function printHelp(): void {
  console.log(
    [
      "Commands:",
      "  url                  print the live page's current URL/title",
      "  screenshot [path]    save a screenshot of the live page (default: ./operator-<n>.png)",
      "  goto <url>           navigate the live page",
      "  click <text>         click the first element containing this visible text",
      "  resume [notes...]    signal the discovery run to resume, then exit",
      "  abort [notes...]     signal the discovery run to give up now, then exit",
      "  help                 show this message",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.requestPath) {
    console.error("Usage: operator --request <path-to-intervention.json> [--host <host>]");
    process.exitCode = 1;
    return;
  }

  const intervention = await loadIntervention(args.requestPath);
  printBanner(intervention);

  console.log(`Attaching to the live browser session (${intervention.cdpEndpoint})...`);
  const browser = await chromium.connectOverCDP(intervention.cdpEndpoint);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) {
    console.error("Could not find the live page on the attached browser — was it closed already?");
    await browser.close();
    process.exitCode = 1;
    return;
  }
  console.log(`Attached. The browser window is visible on this machine — you can interact with it directly`);
  console.log(`with your mouse/keyboard, and/or use the commands below. Type "help" for the command list.\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let screenshotCount = 0;
  let exitSignal: "resume" | "abort" | undefined;
  let notes: string | undefined;

  try {
    while (!exitSignal) {
      const line = (await rl.question("operator> ")).trim();
      if (!line) continue;
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");

      try {
        switch (cmd) {
          case "help":
            printHelp();
            break;
          case "url":
            console.log(`${page.url()} — "${await page.title()}"`);
            break;
          case "screenshot": {
            screenshotCount += 1;
            const outPath = path.resolve(arg || `operator-${screenshotCount}.png`);
            await writeFile(outPath, await page.screenshot({ fullPage: false }));
            console.log(`saved -> ${outPath}`);
            break;
          }
          case "goto":
            if (!arg) {
              console.log('usage: goto <url>');
              break;
            }
            await page.goto(arg, { waitUntil: "domcontentloaded" });
            console.log(`navigated -> ${page.url()}`);
            break;
          case "click":
            if (!arg) {
              console.log('usage: click <text>');
              break;
            }
            await page.getByText(arg, { exact: false }).first().click({ timeout: 5000 });
            console.log(`clicked "${arg}"`);
            break;
          case "resume":
            notes = arg || undefined;
            exitSignal = "resume";
            break;
          case "abort":
            notes = arg || undefined;
            exitSignal = "abort";
            break;
          default:
            console.log(`Unknown command "${cmd}". Type "help" for the command list.`);
        }
      } catch (err) {
        console.error(`command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    rl.close();
    // Disconnect ONLY — this browser was obtained via connectOverCDP(), so close() detaches
    // this client without touching the live session (verified in
    // tests/integration/hitl-handoff.test.ts). The discovery run's own WebSurface still owns
    // the real teardown.
    await browser.close();
  }

  console.log(`Signaling "${exitSignal}" to the discovery run...`);
  await postSignal(args.host, intervention.controlPort, exitSignal, notes);
  console.log("Done — the discovery run should pick this up now.");
}

main().catch((err) => {
  console.error("[operator] fatal error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
