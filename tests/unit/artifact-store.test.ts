import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ArtifactStore } from "../../src/artifact/store.js";
import { parseCapabilityArtifact, type CapabilityArtifactInput } from "../../src/artifact/schema.js";

function makeArtifact(overrides: Partial<CapabilityArtifactInput> = {}) {
  const input: CapabilityArtifactInput = {
    id: "test.capability",
    version: 1,
    schemaVersion: "1.0",
    name: "Test capability",
    description: "A minimal artifact for store tests.",
    target: { app: "test", baseUrl: "https://example.com", surfaceType: "web" },
    provenance: { discoveryRunId: "run-1", recordedAt: new Date().toISOString(), model: "test" },
    inputs: [],
    outputs: [],
    steps: [{ id: "s1", action: "navigate", value: { kind: "literal", value: "https://example.com" } }],
    checkpoint: { description: "loaded", assertion: { kind: "urlContains", value: "example.com" } },
    policy: { riskLevel: "safe", requiresApproval: false },
    status: "draft",
    ...overrides,
  };
  return parseCapabilityArtifact(input);
}

describe("ArtifactStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("saves and loads an artifact by exact version", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "artifact-store-test-"));
    const store = new ArtifactStore(dir);
    const artifact = makeArtifact();
    await store.save(artifact);
    const loaded = await store.load(artifact.id, artifact.version);
    expect(loaded).toEqual(artifact);
  });

  it("computes nextVersion as 1 when nothing is recorded yet, then increments", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "artifact-store-test-"));
    const store = new ArtifactStore(dir);
    expect(await store.nextVersion("test.capability")).toBe(1);
    await store.save(makeArtifact({ version: 1 }));
    expect(await store.nextVersion("test.capability")).toBe(2);
    await store.save(makeArtifact({ version: 2 }));
    expect(await store.nextVersion("test.capability")).toBe(3);
  });

  it("loadLatest returns the highest version", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "artifact-store-test-"));
    const store = new ArtifactStore(dir);
    await store.save(makeArtifact({ version: 1, name: "v1" }));
    await store.save(makeArtifact({ version: 3, name: "v3" }));
    await store.save(makeArtifact({ version: 2, name: "v2" }));
    const latest = await store.loadLatest("test.capability");
    expect(latest.version).toBe(3);
    expect(latest.name).toBe("v3");
  });

  it("throws a clear error when no artifact exists for a capability id", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "artifact-store-test-"));
    const store = new ArtifactStore(dir);
    await expect(store.loadLatest("nonexistent")).rejects.toThrow(/No artifact found/);
  });

  it("keeps multiple capability ids independent", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "artifact-store-test-"));
    const store = new ArtifactStore(dir);
    await store.save(makeArtifact({ id: "a", version: 1 }));
    await store.save(makeArtifact({ id: "b", version: 1 }));
    const ids = await store.listCapabilityIds();
    expect(new Set(ids)).toEqual(new Set(["a", "b"]));
  });
});
