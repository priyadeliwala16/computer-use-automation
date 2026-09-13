import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ActionResult, Observation, Surface, SurfaceAction, SnapshotNode } from "./types.js";
import { collectSnapshotNodes, type RawSnapshotNode } from "./browser-snapshot-script.js";

const MAX_SNAPSHOT_NODES = 150;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Grace window to detect a navigation caused by an action. See `settleAfterAction` for why
 *  this can't just be a `waitForLoadState` check performed after the fact. */
const NAVIGATION_GRACE_MS = 800;
/** Some routes on the target app render via client-side transitions (URL changes via a
 *  history-API push, followed by an animated drawer/panel mount) rather than a full document
 *  load — `domcontentloaded`/`load` fire instantly for these and don't capture the animation.
 *  A small fixed settle buffer after every action is a deliberate, documented trade-off: it's
 *  simpler than polling for transition/animation-end events per element, at the cost of a fixed
 *  per-action latency. See REPORT.md's determinism section for the fuller discussion. */
const SETTLE_BUFFER_MS = 300;

export interface WebSurfaceOptions {
  headless?: boolean;
  /** If set, navigates here immediately after launch. */
  startUrl?: string;
}

function refSelector(ref: string): string {
  return `[data-cua-ref="${ref}"]`;
}

/**
 * Our dev-time TS runner (tsx/esbuild) instruments compiled functions with calls to a
 * `__name(fn, "name")` helper (name-preservation for stack traces). That helper only exists in
 * the Node process — when `collectSnapshotNodes` is serialized and shipped into the page via
 * `page.evaluate`, those calls would throw a ReferenceError in the browser. This init script
 * defines a harmless identity-function shim for `__name` in every page/frame before our own
 * scripts ever run, so the browser-side snapshot script above works unmodified.
 */
function installNameHelperShim(): Promise<void> | void {
  (globalThis as unknown as Record<string, unknown>).__name =
    (globalThis as unknown as Record<string, unknown>).__name ??
    ((target: unknown) => target);
}

/**
 * Playwright-backed implementation of `Surface`. See src/surface/types.ts for the contract this
 * fulfills and why it exists as an abstraction rather than being used directly by callers.
 */
export class WebSurface implements Surface {
  private snapshotCounter = 0;

  private constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly browser: Browser,
  ) {}

  static async launch(options: WebSurfaceOptions = {}): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(installNameHelperShim);
    const surface = new WebSurface(page, context, browser);
    if (options.startUrl) {
      await surface.act({ type: "navigate", url: options.startUrl });
    }
    return surface;
  }

  /**
   * Escape hatch exposing the raw Playwright page. Only two things in this codebase are allowed
   * to use it: evidence capture (screenshots/DOM dumps, which need Playwright's native APIs) and
   * the HITL operator handoff (which must drive the literal same session a human can also see).
   * Everything else — the agent loop, the replay executor — depends only on `Surface`.
   */
  get rawPage(): Page {
    return this.page;
  }

  async observe(): Promise<Observation> {
    // NOTE: deliberately no waitForLoadState *state check* here. Checking current load state is
    // a snapshot-in-time read — if a navigation triggered by the immediately-preceding act()
    // hasn't started yet, this would resolve instantly against the *old*, already-settled page,
    // and evaluate() below could then race the new navigation and read a half-torn-down or
    // stale DOM. `settleAfterAction` (called from `act()`, immediately after triggering the
    // action) is what actually closes that race, by registering a navigation *listener* before
    // the action fires rather than checking state after. By the time control reaches observe(),
    // any navigation caused by the prior action has either completed or was never going to
    // happen — so it's safe to just read current state here.
    const raw = (await this.page.evaluate(collectSnapshotNodes, MAX_SNAPSHOT_NODES)) as RawSnapshotNode[];
    const nodes: SnapshotNode[] = raw.map((n) => ({ ...n }));
    this.snapshotCounter += 1;
    return {
      snapshotId: `snap-${this.snapshotCounter}`,
      url: this.page.url(),
      title: await this.page.title(),
      nodes,
    };
  }

  async act(action: SurfaceAction): Promise<ActionResult> {
    try {
      switch (action.type) {
        case "navigate":
          await this.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
          return { ok: true };

        case "click": {
          const locator = this.page.locator(refSelector(action.ref));
          await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
          await this.actAndSettle(() => locator.click({ timeout: DEFAULT_TIMEOUT_MS }));
          return { ok: true };
        }

        case "type": {
          const locator = this.page.locator(refSelector(action.ref));
          await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
          if (action.clear ?? true) await locator.fill("");
          await this.actAndSettle(() => locator.fill(action.text));
          return { ok: true };
        }

        case "select": {
          const locator = this.page.locator(refSelector(action.ref));
          await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
          await this.actAndSettle(async () => {
            await locator.selectOption(action.value);
          });
          return { ok: true };
        }

        case "extract": {
          const locator = this.page.locator(refSelector(action.ref));
          await locator.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
          const value = (await locator.textContent())?.trim() ?? "";
          return { ok: true, extractedValue: value };
        }

        case "waitFor": {
          if (action.ref) {
            await this.page
              .locator(refSelector(action.ref))
              .waitFor({ state: "visible", timeout: action.ms ?? DEFAULT_TIMEOUT_MS });
          } else {
            await this.page.waitForTimeout(action.ms ?? 1000);
          }
          return { ok: true };
        }

        default: {
          const _exhaustive: never = action;
          return _exhaustive;
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  /**
   * Runs a mutating action while correctly handling the "might-or-might-not navigate" ambiguity
   * inherent to generic UI automation: we don't know ahead of time whether a given click submits
   * a form, follows a link, or just toggles some in-page state.
   *
   * The listener for `framenavigated` is registered *before* the action executes, so it reacts to
   * the actual navigation event rather than checking already-settled page state afterward (which
   * is the race that produced a stale snapshot in early testing — see the comment on `observe`).
   * If no navigation happens within the grace window, we proceed immediately without it — this
   * intentionally does not attempt to distinguish "definitely no navigation" from "navigation
   * that happens to be slower than the grace window"; a capability author who needs the latter
   * should follow up with an explicit `waitFor` step, which every recorded artifact can express.
   */
  private async actAndSettle(action: () => Promise<void>): Promise<void> {
    const navigated = this.page
      .waitForEvent("framenavigated", { timeout: NAVIGATION_GRACE_MS })
      .then(() => true)
      .catch(() => false);
    await action();
    await navigated;
    await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await this.page.waitForTimeout(SETTLE_BUFFER_MS);
  }
}
