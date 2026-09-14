/**
 * Ad-hoc manual verification for Phase 1 — not a unit test, not part of the public CLI. Confirms
 * WebSurface + GuardedSurface actually work against the real target before Phase 2 builds on
 * top of them. Run with: `npx tsx scripts/smoke-surface.ts`
 */
import { WebSurface } from "../src/surface/web-surface.js";
import { GuardedSurface } from "../src/safety/guarded-surface.js";
import { AllowlistPolicy, loadAllowlistConfig } from "../src/config/allowlist.js";
import { env } from "../src/config/env.js";

async function main() {
  const policy = new AllowlistPolicy(loadAllowlistConfig());
  const rawSurface = await WebSurface.launch({ headless: true, startUrl: env.TARGET_BASE_URL });
  const surface = new GuardedSurface(rawSurface, policy);

  try {
    const obs1 = await surface.observe();
    console.log(`\n[observe #1] url=${obs1.url} title="${obs1.title}" nodes=${obs1.nodes.length}`);
    for (const n of obs1.nodes.slice(0, 12)) {
      console.log(
        `  [${n.ref}] role=${n.role} name=${JSON.stringify(n.name)} testId=${n.testId ?? "-"} css=${n.cssPath}`,
      );
    }

    const usernameField = obs1.nodes.find((n) => n.testId === "username");
    const passwordField = obs1.nodes.find((n) => n.testId === "password");
    const loginButton = obs1.nodes.find((n) => n.testId === "login-button");
    if (!usernameField || !passwordField || !loginButton) {
      throw new Error(
        `Could not find expected saucedemo login fields in observation. Found testIds: ${obs1.nodes
          .map((n) => n.testId)
          .filter(Boolean)
          .join(", ")}`,
      );
    }

    console.log(`\n[act] type username -> ref=${usernameField.ref}`);
    const r1 = await surface.act({
      type: "type",
      target: { kind: "ref", ref: usernameField.ref },
      text: "standard_user",
    });
    console.log("  result:", r1);

    console.log(`[act] type password -> ref=${passwordField.ref}`);
    const r2 = await surface.act({
      type: "type",
      target: { kind: "ref", ref: passwordField.ref },
      text: "secret_sauce",
    });
    console.log("  result:", r2);

    console.log(`[act] click login -> ref=${loginButton.ref}`);
    const r3 = await surface.act({ type: "click", target: { kind: "ref", ref: loginButton.ref } });
    console.log("  result:", r3);

    const obs2 = await surface.observe();
    console.log(`\n[observe #2] url=${obs2.url} title="${obs2.title}" nodes=${obs2.nodes.length}`);
    const inventoryHeading = obs2.nodes.find((n) => n.role === "heading");
    console.log("  heading node:", inventoryHeading);

    if (!obs2.url.includes("inventory.html")) {
      throw new Error(`Expected to land on inventory.html after login, got: ${obs2.url}`);
    }

    console.log("\n✅ Smoke test passed: observe -> act -> observe round-trip works against saucedemo.");

    console.log("\n[allowlist] testing a disallowed navigation is blocked...");
    try {
      await surface.act({ type: "navigate", url: "https://example.com" });
      console.log("❌ Expected navigation to example.com to be blocked, but it was not.");
      process.exitCode = 1;
    } catch (err) {
      console.log("  blocked as expected:", (err as Error).message);
    }
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error("\n❌ Smoke test failed:", err);
  process.exitCode = 1;
});
