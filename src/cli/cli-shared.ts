import path from "node:path";
import { env } from "../config/env.js";
import { WebSurface } from "../surface/web-surface.js";
import type { Surface } from "../surface/types.js";
import { JsonlLogger } from "../evidence/jsonl-logger.js";
import { ScreenshotEvidenceSink } from "../evidence/screenshot-sink.js";

/**
 * Shared plumbing between `discover.ts` and `replay.ts`. Each CLI keeps its own option parsing,
 * console output, and control flow (they run genuinely different things) — this module only
 * factors out the handful of bits that were byte-for-byte identical between the two: `--param`
 * collection/parsing, `--redact` parsing, launching a `WebSurface` from the shared
 * `--headless`/`--slow-mo-ms` flags, and setting up an `evidence/<runId>/` bundle.
 */

/** commander's repeatable-option collector for `--param name=value` — appends each occurrence
 *  instead of overwriting it. */
export function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Splits one `--param name=value` flag into a `[name, value]` tuple. The one place "name=value"
 *  parsing and its error message live — `discover.ts` maps this over the raw flag array directly
 *  (preserving order and duplicates as distinct `ParamHint`s), `parseKeyValueParams` below folds
 *  it into a map instead (letting a later duplicate silently win, which is fine for `replay.ts`'s
 *  use — it wants "the value for this name" for `coerceParams`, not a flag-order-preserving log). */
export function splitParamFlag(raw: string): [name: string, value: string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`--param "${raw}" is not in the form name=value`);
  }
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

/** Splits `--param name=value` flags into a raw string map. Coercion into an artifact's declared
 *  input types happens separately (see `replay.ts`'s `coerceParams`), once the types are known. */
export function parseKeyValueParams(rawParams: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of rawParams) {
    const [name, value] = splitParamFlag(raw);
    result[name] = value;
  }
  return result;
}

/** Parses `--redact a,b,c` into the set of `--param` names it names as sensitive. */
export function parseRedactNames(redact: string): Set<string> {
  return new Set(
    redact
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface SurfaceLaunchOptions {
  headless?: boolean;
  /** Raw `--slow-mo-ms` flag value (a string, straight from commander); parsed here. */
  slowMoMs?: string;
  /** Only `discover.ts` ever sets this — see `WebSurfaceOptions.enableRemoteControl`'s doc
   *  comment in src/surface/web-surface.ts for why `replay.ts` never needs it. */
  enableRemoteControl?: boolean;
}

/** Resolves the `--headless`/`--slow-mo-ms` flags shared by both CLIs against `.env` defaults
 *  and launches a `WebSurface`. */
export async function launchWebSurface(options: SurfaceLaunchOptions): Promise<WebSurface> {
  return WebSurface.launch({
    headless: options.headless ?? env.PLAYWRIGHT_HEADLESS,
    enableRemoteControl: options.enableRemoteControl,
    slowMoMs: options.slowMoMs !== undefined ? Number(options.slowMoMs) : undefined,
  });
}

export interface EvidenceBundle {
  bundleDir: string;
  jsonlLogger: JsonlLogger;
  screenshotSink: ScreenshotEvidenceSink;
}

/** Sets up the `evidence/<runId>/` bundle (JSONL log + screenshot sink) both CLIs write to. */
export function createEvidenceBundle(evidenceDir: string, runId: string, surface: Surface): EvidenceBundle {
  const bundleDir = path.join(evidenceDir, runId);
  return {
    bundleDir,
    jsonlLogger: new JsonlLogger(path.join(bundleDir, "log.jsonl")),
    screenshotSink: new ScreenshotEvidenceSink(surface, bundleDir),
  };
}
