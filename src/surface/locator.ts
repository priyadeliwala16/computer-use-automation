import { z } from "zod";
import type { Page, Locator } from "playwright";
import type { SnapshotNode } from "./types.js";

/**
 * Robustness ordering, most to least resistant to incidental markup churn:
 *   role   — accessible role + name. What a human/screen-reader perceives; survives DOM
 *            refactors, class renames, and framework migrations.
 *   testId — a `data-testid`/`data-test`/`data-qa` attribute. Extremely stable when present,
 *            but per the brief, legacy enterprise apps essentially never have them.
 *   text   — visible text content. Usually stable for labels/buttons, but can break under
 *            i18n or dynamic/templated content.
 *   css    — a structural nth-child path from <body>. Always available as a last resort, but
 *            brittle: breaks on any layout reshuffle.
 *
 * We deliberately do NOT always prefer testId even when present — see buildLocatorSpec.
 */
export const LocatorStrategySchema = z.enum(["role", "testId", "text", "css"]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorSpecSchema = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  testId: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
  /** Ordered strategies to attempt at replay time; first one that resolves to exactly one
   *  visible, enabled element wins. */
  fallbackOrder: z.array(LocatorStrategySchema).min(1),
});
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;

const DEFAULT_PREFERENCE: LocatorStrategy[] = ["role", "testId", "text", "css"];

/**
 * Builds the full candidate locator for a perceived node. Called once, at the moment an action
 * is executed during discovery — never reconstructed later from a possibly-stale page.
 */
/** Accessible names that embed a mutable count/state token (e.g. "Cart, 1 items") are common on
 *  modern web apps (badge counts, "N results", timestamps) and will silently stop matching once
 *  that state differs from what was recorded — a role+name match that "sometimes" fails is worse
 *  than one that predictably falls back. We deprioritize (never discard) `role` for these,
 *  observed directly against the target app's cart icon, whose name changes between "Cart,
 *  empty" and "Cart, N items". */
function looksStateDependent(name: string | undefined): boolean {
  return Boolean(name && /\d/.test(name));
}

export function buildLocatorSpec(
  node: Pick<SnapshotNode, "role" | "name" | "testId" | "text" | "cssPath">,
  preference: LocatorStrategy[] = DEFAULT_PREFERENCE,
): LocatorSpec {
  const available: LocatorStrategy[] = [];
  if (node.role && node.name) available.push("role");
  if (node.testId) available.push("testId");
  if (node.text && node.text.length <= 80) available.push("text");
  available.push("css"); // always available

  const effectivePreference =
    looksStateDependent(node.name) && available.includes("testId")
      ? [...preference.filter((s) => s !== "role"), "role" as LocatorStrategy]
      : preference;

  const fallbackOrder = [
    ...effectivePreference.filter((s) => available.includes(s)),
    ...available.filter((s) => !effectivePreference.includes(s)),
  ];

  return {
    role: node.role,
    name: node.name,
    testId: node.testId,
    text: node.text && node.text.length <= 80 ? node.text : undefined,
    css: node.cssPath,
    fallbackOrder,
  };
}

export interface ResolvedLocator {
  locator: Locator;
  strategyUsed: LocatorStrategy;
}

/**
 * Resolves a LocatorSpec against a *live* page using the fallback chain, trying each declared
 * strategy in order until exactly one visible element matches. This is the "stable
 * element/control targeting" the replay path depends on (§3.3) — it never depends on the
 * ephemeral `ref`s used during discovery.
 */
export async function resolveLocator(page: Page, spec: LocatorSpec): Promise<ResolvedLocator> {
  for (const strategy of spec.fallbackOrder) {
    const locator = tryStrategy(page, spec, strategy);
    if (!locator) continue;
    const count = await locator.count();
    if (count === 1) {
      return { locator, strategyUsed: strategy };
    }
    // count === 0 -> fall through to next strategy.
    // count > 1 -> ambiguous with this strategy; a later, more specific strategy may disambiguate,
    // but css is always unique by construction, so this loop always terminates successfully or
    // exhausts all strategies.
  }
  throw new LocatorResolutionError(spec);
}

function tryStrategy(page: Page, spec: LocatorSpec, strategy: LocatorStrategy): Locator | undefined {
  switch (strategy) {
    case "role":
      return spec.role && spec.name
        ? page.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name })
        : undefined;
    case "testId":
      // Deliberately not page.getByTestId(), which only matches Playwright's single configured
      // attribute (default: data-testid). Our perception layer (browser-snapshot-script.ts)
      // recognizes data-testid/data-test/data-qa as equally valid conventions — matching all
      // three here keeps that consistent, rather than silently only working for one of them.
      return spec.testId
        ? page.locator(
            `[data-testid="${spec.testId}"], [data-test="${spec.testId}"], [data-qa="${spec.testId}"]`,
          )
        : undefined;
    case "text":
      return spec.text ? page.getByText(spec.text, { exact: false }) : undefined;
    case "css":
      return spec.css ? page.locator(spec.css) : undefined;
    default:
      return undefined;
  }
}

export class LocatorResolutionError extends Error {
  constructor(public readonly spec: LocatorSpec) {
    super(
      `Could not resolve a unique element for locator (tried: ${spec.fallbackOrder.join(", ")}) ` +
        `role=${spec.role ?? "-"} name=${spec.name ?? "-"} testId=${spec.testId ?? "-"} text=${spec.text ?? "-"}`,
    );
    this.name = "LocatorResolutionError";
  }
}
