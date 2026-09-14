import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlLogger } from "../../src/evidence/jsonl-logger.js";

let tmpDir: string | undefined;

async function makeTmpDir(): Promise<string> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "jsonl-logger-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("JsonlLogger", () => {
  it("creates the parent directory and writes one JSON object per line, each stamped with a timestamp", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "nested", "log.jsonl");
    const logger = new JsonlLogger(filePath);

    await logger.log({ event: "turn", index: 0, ok: true });
    await logger.log({ event: "turn", index: 1, ok: false, error: "boom" });

    const raw = await readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "turn", index: 0, ok: true });
    expect(lines[1]).toMatchObject({ event: "turn", index: 1, ok: false, error: "boom" });
    for (const line of lines) {
      expect(typeof line.timestamp).toBe("string");
      expect(new Date(line.timestamp).toString()).not.toBe("Invalid Date");
    }
  });

  it("appends across multiple logger instances pointed at the same file", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "log.jsonl");

    await new JsonlLogger(filePath).log({ n: 1 });
    await new JsonlLogger(filePath).log({ n: 2 });

    const raw = await readFile(filePath, "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });
});
