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

export type SurfaceActionType = "click" | "type" | "select" | "navigate" | "extract" | "waitFor";

export type SurfaceAction =
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; clear?: boolean }
  | { type: "select"; ref: string; value: string }
  | { type: "navigate"; url: string }
  | { type: "extract"; ref: string }
  | { type: "waitFor"; ref?: string; ms?: number };

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
