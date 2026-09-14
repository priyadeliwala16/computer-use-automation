import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityArtifact} from "./schema.js";
import { parseCapabilityArtifact } from "./schema.js";

/**
 * Filesystem-backed artifact store: one JSON file per (id, version). Deliberately not a
 * database — per §5 we shouldn't build infrastructure the problem doesn't need. Artifacts are
 * plain, diffable, git-reviewable JSON, which matches the brief's "reviewable" requirement
 * better than an opaque store would.
 */
export class ArtifactStore {
  constructor(private readonly dir: string) {}

  private fileName(id: string, version: number): string {
    return `${id}@v${version}.json`;
  }

  private filePath(id: string, version: number): string {
    return path.join(this.dir, this.fileName(id, version));
  }

  async save(artifact: CapabilityArtifact): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const filePath = this.filePath(artifact.id, artifact.version);
    await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
    return filePath;
  }

  async load(id: string, version: number): Promise<CapabilityArtifact> {
    const filePath = this.filePath(id, version);
    const raw = await readFile(filePath, "utf-8");
    return parseCapabilityArtifact(JSON.parse(raw));
  }

  /** Loads the highest version currently stored for `id`. This is what a replay caller invokes
   *  by default — "give me the current capability," not a specific historical recording. */
  async loadLatest(id: string): Promise<CapabilityArtifact> {
    const versions = await this.listVersions(id);
    if (versions.length === 0) {
      throw new Error(`No artifact found for capability "${id}" in ${this.dir}`);
    }
    return this.load(id, Math.max(...versions));
  }

  async listVersions(id: string): Promise<number[]> {
    const files = await this.safeReaddir();
    const prefix = `${id}@v`;
    return files
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => Number(f.slice(prefix.length, -".json".length)))
      .filter((v) => Number.isInteger(v));
  }

  async listCapabilityIds(): Promise<string[]> {
    const files = await this.safeReaddir();
    const ids = new Set<string>();
    for (const f of files) {
      const match = /^(.+)@v(\d+)\.json$/.exec(f);
      if (match) ids.add(match[1]!);
    }
    return [...ids];
  }

  /** Next version to record: 1 if the capability has never been recorded before. */
  async nextVersion(id: string): Promise<number> {
    const versions = await this.listVersions(id);
    return versions.length === 0 ? 1 : Math.max(...versions) + 1;
  }

  private async safeReaddir(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
