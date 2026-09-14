import Anthropic from "@anthropic-ai/sdk";

const MAX_TOKENS = 1024;

/**
 * What `DiscoveryAgentLoop` actually depends on: "something that decides the next tool call
 * given a prompt and history." Same seam-pattern as `Surface` elsewhere in this codebase — the
 * loop is unit-testable with a fake implementation of this interface, with no network calls and
 * no Anthropic credentials required, and swapping models/providers later touches only this file.
 */
export interface AgentDecisionClient {
  readonly model: string;
  decide(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
  ): Promise<Anthropic.Message>;
}

/** Thin wrapper around the Anthropic SDK implementing `AgentDecisionClient`. */
export class ClaudeAgentClient implements AgentDecisionClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async decide(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
  ): Promise<Anthropic.Message> {
    return this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools,
      // "any": the model must call some tool — a discovery turn is never a plain-text response.
      // disable_parallel_tool_use: exactly one action per turn, matching the artifact's own
      // one-step-at-a-time model and keeping the run trace a clean linear sequence.
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
  }
}
