/**
 * The `Surface` interface is the seam between "how we perceive and act on a UI" and everything
 * built on top of it (the discovery agent, the recorder, the replay executor).
 *
 * Today `WebSurface` implements this over Playwright/DOM + accessibility metadata. A legacy
 * server-rendered app or a native desktop app would get its own implementation (e.g. reading a
 * frameset/table layout, or an OS accessibility API) — the discovery loop, artifact schema, and
 * replay executor would not change, because they only ever depend on this interface, never on
 * Playwright directly. See REPORT.md §4 for how this extends to those surfaces.
 */

import type { LocatorSpec } from "./locator.js";

export const SURFACE_ACTION_TYPES = ["click", "type", "select", "navigate", "extract", "waitFor"] as const;
export type SurfaceActionType = (typeof SURFACE_ACTION_TYPES)[number];

/**
 * Two addressing modes onto the same surface, used by two different callers:
 *  - `ref`: an ephemeral id assigned by the most recent `observe()` snapshot. Cheap for an LLM to
 *    reason about; only ever valid against the live page it was captured from. Used exclusively
 *    by the discovery agent loop (Phase 4), which always observes immediately before acting.
 *  - `locator`: a durable `LocatorSpec` (role+name/testId/text/css fallback chain) that doesn't
 *    depend on any prior observation. Used exclusively by the replay executor (Phase 3), which
 *    has no live snapshot to draw a `ref` from — only the artifact's recorded target.
 * Both resolve, inside a given `Surface` implementation, to the same underlying element-action
 * primitives — this union is what lets discovery and replay share one `act()` method (and, on a
 * future surface, one implementation of "how do I find and touch a control").
 */
export type ActionTarget = { kind: "ref"; ref: string } | { kind: "locator"; locator: LocatorSpec };

export type SurfaceAction =
  | { type: "click"; target: ActionTarget }
  | { type: "type"; target: ActionTarget; text: string; clear?: boolean }
  | { type: "select"; target: ActionTarget; value: string }
  | { type: "navigate"; url: string }
  | { type: "extract"; target: ActionTarget }
  | { type: "waitFor"; target?: ActionTarget; ms?: number };

/** A single perceived node — an interactive control or a short, potentially meaningful text node. */
export interface SnapshotNode {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  /** Internal-only: structural fallback locator. Never shown to the LLM (kept out of the prompt
   *  serialization) — it exists purely so the recorder can build a robust LocatorSpec later. */
  cssPath: string;
  disabled?: boolean;
}

export interface Observation {
  snapshotId: string;
  url: string;
  title: string;
  nodes: SnapshotNode[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Populated for `extract` actions. */
  extractedValue?: string;
}

export interface Surface {
  /** Perceives the current state of the surface. Must be called before acting on any `ref`. */
  observe(): Promise<Observation>;
  act(action: SurfaceAction): Promise<ActionResult>;
  screenshot(): Promise<Buffer>;
  currentUrl(): string;
  close(): Promise<void>;
}
