import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Structured, append-only, one-JSON-object-per-line log (§3.5). Deliberately a flat sequence of
 * small, independently-parseable lines rather than one big JSON document being built up in
 * memory and written once at the end: a run that crashes or gets killed partway still leaves a
 * valid, readable partial log on disk, and a human can `tail -f`/`jq` it live while a run is in
 * progress — both properties a single JSON blob written at close time would lose.
 *
 * Every field passed to `log()` is caller-provided plain data (numbers, strings, booleans) —
 * this class has no opinion on redaction; callers (the `discover` CLI today) are responsible
 * for running any sensitive text through `redactSensitiveValues` before calling `log()`. Keeping
 * that concern out of this class is what lets it stay generic enough for a future `replay` CLI
 * to reuse unmodified.
 */
export class JsonlLogger {
  private readonly dirReady: Promise<unknown>;

  constructor(private readonly filePath: string) {
    this.dirReady = mkdir(path.dirname(filePath), { recursive: true });
  }

  async log(event: Record<string, unknown>): Promise<void> {
    await this.dirReady;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    await appendFile(this.filePath, `${line}\n`, "utf-8");
  }
}
