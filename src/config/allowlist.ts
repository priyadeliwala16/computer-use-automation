import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { SurfaceActionType } from "../surface/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The allowlist is the explicit, configurable boundary required by §3.4. It is deliberately
 * plain, reviewable JSON — a policy artifact a security reviewer can read without reading code —
 * separate from the .env file that holds secrets.
 */
export const RiskyControlRuleSchema = z.object({
  description: z.string(),
  role: z.string().optional(),
  namePattern: z.string().optional(),
});

export const AllowlistConfigSchema = z.object({
  app: z.string(),
  allowedDomains: z.array(z.string()).min(1),
  allowedActionTypes: z.array(z.string()).min(1),
  riskyControls: z.array(RiskyControlRuleSchema).default([]),
});

export type RiskyControlRule = z.infer<typeof RiskyControlRuleSchema>;
export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;

export function loadAllowlistConfig(configPath?: string): AllowlistConfig {
  const resolvedPath = configPath ?? path.join(__dirname, "allowlist.json");
  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = AllowlistConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Invalid allowlist config at ${resolvedPath}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export class AllowlistPolicy {
  constructor(private readonly config: AllowlistConfig) {}

  isDomainAllowed(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return this.config.allowedDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
  }

  isActionTypeAllowed(actionType: SurfaceActionType): boolean {
    return this.config.allowedActionTypes.includes(actionType);
  }

  /** Matches a target control (by role/accessible name) against the risky-control rules. */
  matchRiskyControl(role: string | undefined, name: string | undefined): RiskyControlRule | undefined {
    return this.config.riskyControls.find((rule) => {
      if (rule.role && rule.role !== role) return false;
      if (rule.namePattern && !new RegExp(rule.namePattern).test(name ?? "")) return false;
      return Boolean(rule.role || rule.namePattern);
    });
  }
}
