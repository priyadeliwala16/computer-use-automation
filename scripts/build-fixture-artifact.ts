/**
 * Produces a hand-authored fixture artifact for `saucedemo.add_item_and_checkout`, used to build
 * and test the replay executor (Phase 3) *before* the discovery agent (Phase 4/5) exists.
 *
 * This is deliberately NOT written to /artifacts — that directory is reserved for artifacts
 * produced by a genuine discovery run (see README.md's provenance note). This fixture lives
 * under tests/fixtures/ and is used only by the replay engine's own tests, and by this dev
 * script's smoke run. Every locator below was captured by directly observing the live app with
 * WebSurface (see scripts/smoke-surface.ts history) — nothing here is guessed.
 */
import path from "node:path";
import type { LocatorSpec } from "../src/surface/locator.js";
import { ArtifactStore } from "../src/artifact/store.js";
import { parseCapabilityArtifact, type CapabilityArtifactInput } from "../src/artifact/schema.js";

const role = (
  roleName: string,
  name: string | undefined,
  testId: string | undefined,
  fallbackOrder: LocatorSpec["fallbackOrder"],
  text?: string,
): LocatorSpec => ({ role: roleName, name, testId, text, fallbackOrder });

const artifact: CapabilityArtifactInput = {
  id: "saucedemo.add_item_and_checkout",
  version: 1,
  schemaVersion: "1.0",
  name: "Add Sauce Labs Backpack to cart and reach checkout overview",
  description:
    "Logs in, adds the 'Sauce Labs Backpack' item to the cart, fills the checkout information " +
    "form, and reaches the order review (checkout overview) page — stopping short of placing " +
    "the order, which is a separate, risk-gated action. Returns the displayed order totals.",
  target: {
    app: "saucedemo",
    baseUrl: "https://www.saucedemo.com",
    surfaceType: "web",
  },
  provenance: {
    discoveryRunId: "hand-authored-fixture-for-replay-engine-development",
    recordedAt: new Date(0).toISOString(),
    model: "n/a — see README.md provenance note",
  },
  inputs: [
    {
      name: "username",
      type: "string",
      required: true,
      redact: true,
      description: "Login username for the target account.",
      example: "standard_user",
    },
    {
      name: "password",
      type: "string",
      required: true,
      redact: true,
      description: "Login password for the target account.",
      example: "secret_sauce",
    },
    {
      name: "firstName",
      type: "string",
      required: true,
      redact: false,
      description: "Checkout billing first name.",
      example: "Ada",
    },
    {
      name: "lastName",
      type: "string",
      required: true,
      redact: false,
      description: "Checkout billing last name.",
      example: "Lovelace",
    },
    {
      name: "postalCode",
      type: "string",
      required: true,
      redact: false,
      description:
        "Checkout billing postal/zip code. An empty or invalid value surfaces a " +
        "'validation_error' business outcome rather than a crash.",
      example: "94107",
    },
  ],
  outputs: [
    {
      name: "itemTotalText",
      type: "string",
      fromStepId: "extract-item-total",
      description: "The 'Item total' line as displayed on the checkout overview page.",
    },
    {
      name: "taxText",
      type: "string",
      fromStepId: "extract-tax",
      description: "The 'Tax' line as displayed on the checkout overview page.",
    },
    {
      name: "totalText",
      type: "string",
      fromStepId: "extract-total",
      description: "The 'Total' line as displayed on the checkout overview page.",
    },
  ],
  steps: [
    {
      id: "type-username",
      action: "type",
      target: role("textbox", "Username", "username", ["role", "testId"]),
      value: { kind: "param", param: "username" },
      locatorReasoning:
        "Accessible name 'Username' comes from the field's placeholder and is stable; role+name " +
        "preferred, testId as a strong fallback.",
    },
    {
      id: "type-password",
      action: "type",
      target: role("textbox", "Password", "password", ["role", "testId"]),
      value: { kind: "param", param: "password" },
      locatorReasoning: "Same rationale as username: stable placeholder-derived accessible name.",
    },
    {
      id: "click-login",
      action: "click",
      target: role("button", "Login", "login-button", ["role", "testId"]),
      locatorReasoning:
        "Accessible name 'Login' is derived from the submit input's `value` attribute (not text " +
        "content, since <input> elements are self-closing) — stable across reloads.",
      expected: [
        {
          description: "Login rejected because the account has been locked out by the site admin.",
          detect: { kind: "textVisible", value: "Sorry, this user has been locked out" },
          classification: "business_outcome",
          outcomeCode: "user_locked_out",
        },
      ],
    },
    {
      id: "click-add-to-cart-backpack",
      action: "click",
      target: role("button", "Add to cart", "add-to-cart-sauce-labs-backpack", [
        "testId",
        "role",
      ]),
      locatorReasoning:
        "IMPORTANT: every product tile exposes an 'Add to cart' button with the identical role " +
        "and accessible name — role+name alone resolves to 7 elements on this page, confirmed " +
        "directly against the live app. testId is unique per product and is therefore preferred " +
        "over the usual role-first default.",
    },
    {
      id: "click-cart-icon",
      action: "click",
      target: role("button", "Cart, 1 items", "shopping-cart-link", ["testId", "role"]),
      locatorReasoning:
        "Accessible name encodes the live cart count ('Cart, N items') and is therefore " +
        "state-dependent — confirmed it reads 'Cart, empty' before any item is added. testId is " +
        "stable regardless of cart contents and is preferred.",
    },
    {
      id: "click-checkout",
      action: "click",
      target: role("button", "Checkout", "checkout", ["role", "testId"]),
      locatorReasoning: "Unique, stable accessible name on the cart page.",
    },
    {
      id: "type-first-name",
      action: "type",
      target: role("textbox", "First Name", "firstName", ["role", "testId"]),
      value: { kind: "param", param: "firstName" },
    },
    {
      id: "type-last-name",
      action: "type",
      target: role("textbox", "Last Name", "lastName", ["role", "testId"]),
      value: { kind: "param", param: "lastName" },
    },
    {
      id: "type-postal-code",
      action: "type",
      target: role("textbox", "Zip/Postal Code", "postalCode", ["role", "testId"]),
      value: { kind: "param", param: "postalCode" },
    },
    {
      id: "click-continue",
      action: "click",
      target: { testId: "continue", fallbackOrder: ["testId"] },
      locatorReasoning:
        "No usable accessible name was observed for this control (neither a computed accessible " +
        "name nor text content) — this app doesn't consistently expose one here, which is exactly " +
        "the kind of gap the brief calls out for legacy/uncooperative surfaces. testId is the only " +
        "reliable signal for this element; documented rather than silently worked around.",
      expected: [
        {
          description: "Checkout info form rejected due to a missing/invalid required field.",
          detect: { kind: "textVisible", value: "Postal Code is required" },
          classification: "business_outcome",
          outcomeCode: "validation_error",
        },
      ],
    },
    {
      id: "extract-item-total",
      action: "extract",
      target: { testId: "subtotal-label", fallbackOrder: ["testId", "text"] },
    },
    {
      id: "extract-tax",
      action: "extract",
      target: { testId: "tax-label", fallbackOrder: ["testId", "text"] },
    },
    {
      id: "extract-total",
      action: "extract",
      target: { testId: "total-label", fallbackOrder: ["testId", "text"] },
    },
  ],
  checkpoint: {
    description: "Reached the checkout overview / order review page.",
    assertion: { kind: "urlContains", value: "checkout-step-two.html" },
  },
  policy: {
    riskLevel: "safe",
    requiresApproval: false,
  },
  status: "approved",
};

async function main() {
  const parsed = parseCapabilityArtifact(artifact); // throws with a clear message if the shape is wrong
  const store = new ArtifactStore(path.join(process.cwd(), "tests", "fixtures"));
  const filePath = await store.save(parsed);
  console.log(`Saved fixture artifact to ${filePath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
