import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Surface } from "../surface/types.js";
import type { EvidenceSink } from "./types.js";

/** Turns an arbitrary reason tag (e.g. "business_outcome:user_locked_out") into a filesystem-safe
 *  fragment, truncated defensively in case a caller passes something unexpectedly long. */
function slugify(reason: string): string {
  return reason.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
}

/**
 * The real `EvidenceSink` (see src/evidence/types.ts for the seam this fulfills): captures a
 * screenshot — the system's designated evidence/fallback signal per the chosen perception
 * strategy (accessibility-tree snapshot drives decisions; a screenshot is only ever evidence,
 * never read back into a decision) — into `<evidenceDir>/screenshots/`.
 *
 * Depends only on `Surface#screenshot()`, never on Playwright directly, so it works unmodified
 * against any future `Surface` implementation (§3.7).
 */
export class ScreenshotEvidenceSink implements EvidenceSink {
  private sequence = 0;
  private readonly screenshotsDir: string;

  constructor(private readonly surface: Surface, evidenceDir: string) {
    this.screenshotsDir = path.join(evidenceDir, "screenshots");
  }

  async capture(reason: string): Promise<string> {
    await mkdir(this.screenshotsDir, { recursive: true });
    this.sequence += 1;
    const fileName = `${String(this.sequence).padStart(3, "0")}-${slugify(reason)}.png`;
    const filePath = path.join(this.screenshotsDir, fileName);
    await writeFile(filePath, await this.surface.screenshot());
    return filePath;
  }
}
