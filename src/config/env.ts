import "dotenv/config";
import { z } from "zod";

/**
 * All process configuration is validated once, at startup, so failures are loud and immediate
 * rather than surfacing as a confusing error three steps into a live browser run.
 *
 * ANTHROPIC_API_KEY is intentionally optional here: `replay` never calls the model and must be
 * runnable with no LLM credentials at all. Commands that need it (`discover`) assert on it
 * explicitly (see src/cli/discover.ts) so the error message is scoped to what actually needs it.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
  PLAYWRIGHT_HEADLESS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  TARGET_BASE_URL: z.string().url().default("https://www.saucedemo.com"),
  LOG_LEVEL: z.enum(["minimal", "debug"]).default("minimal"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Check your .env against .env.example:\n${issues}`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();

/** Throws a clear, specific error if the discovery loop's model credentials are missing. */
export function requireAnthropicApiKey(): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The discovery agent loop requires it (replay does not). " +
        "Copy .env.example to .env and add your key.",
    );
  }
  return env.ANTHROPIC_API_KEY;
}
