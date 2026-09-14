import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScreenshotEvidenceSink } from "../../src/evidence/screenshot-sink.js";
import type { ActionResult, Observation, Surface, SurfaceAction } from "../../src/surface/types.js";

// A 1x1 PNG's magic bytes — enough to prove real bytes made it to disk unmodified.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeSurface implements Surface {
  async observe(): Promise<Observation> {
    return { snapshotId: "s", url: "https://example.test/", title: "t", nodes: [] };
  }
  async act(_action: SurfaceAction): Promise<ActionResult> {
    return { ok: true };
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.concat([PNG_MAGIC, Buffer.from("fake-png-body")]);
  }
  currentUrl(): string {
    return "https://example.test/";
  }
  async close(): Promise<void> {}
}

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("ScreenshotEvidenceSink", () => {
  it("writes a real screenshot file per capture, numbered and slugged from the reason", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "screenshot-sink-test-"));
    const sink = new ScreenshotEvidenceSink(new FakeSurface(), tmpDir);

    const path1 = await sink.capture("business_outcome:user_locked_out");
    const path2 = await sink.capture("hard_failure:click-continue");

    expect(path.basename(path1)).toBe("001-business_outcome-user_locked_out.png");
    expect(path.basename(path2)).toBe("002-hard_failure-click-continue.png");

    const bytes1 = await readFile(path1);
    expect(bytes1.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);

    const files = await readdir(path.join(tmpDir, "screenshots"));
    expect(files.sort()).toEqual(["001-business_outcome-user_locked_out.png", "002-hard_failure-click-continue.png"]);
  });

  it("returns a distinct evidenceId path for each capture even with the same reason", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "screenshot-sink-test-"));
    const sink = new ScreenshotEvidenceSink(new FakeSurface(), tmpDir);

    const first = await sink.capture("success");
    const second = await sink.capture("success");

    expect(first).not.toBe(second);
  });
});
