import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * One tool per action, rather than a single polymorphic "act" tool. Two deliberate benefits:
 *  1. Each tool's JSON schema can require exactly the fields that action needs (Anthropic
 *     enforces required fields per-tool), instead of a big optional-everything blob.
 *  2. Every tool — including the two terminal ones, `finish` and `escalate` — carries a
 *     `reasoning`/`reason` field. That single design choice is what gives us the structured
 *     "what did it do and why" log (§3.5) directly off the tool-call payload, with no separate
 *     rationale-extraction step.
 */
export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click an interactive element identified by its [ref] from the most recently shown observation.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The [ref] of the element to click, e.g. 'e3'." },
        reasoning: { type: "string", description: "Why this click moves toward the goal." },
      },
      required: ["ref", "reasoning"],
    },
  },
  {
    name: "type",
    description: "Type text into a text input identified by its [ref]. The field is cleared first.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: {
          type: "string",
          description: "Exact text to type. Use the example values given in your task context verbatim when the field calls for one of them.",
        },
        reasoning: { type: "string" },
      },
      required: ["ref", "text", "reasoning"],
    },
  },
  {
    name: "select",
    description: "Choose an option in a dropdown/select control identified by its [ref].",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        value: { type: "string", description: "The option's value or visible label." },
        reasoning: { type: "string" },
      },
      required: ["ref", "value", "reasoning"],
    },
  },
  {
    name: "navigate",
    description: "Navigate directly to a URL. Prefer clicking an in-page control; only use this when there genuinely is none.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["url", "reasoning"],
    },
  },
  {
    name: "extract",
    description: "Read the text content of an element identified by its [ref] — use this to capture data the goal asks you to read back.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        label: { type: "string", description: "A short, machine-friendly name for this piece of data, e.g. 'order_total'." },
        reasoning: { type: "string" },
      },
      required: ["ref", "label", "reasoning"],
    },
  },
  {
    name: "finish",
    description: "Call this once, when the goal has been fully accomplished and the current page reflects that. Ends the run.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What was accomplished and what the final page shows." },
      },
      required: ["summary"],
    },
  },
  {
    name: "escalate",
    description:
      "Call this if you are stuck and cannot safely continue autonomously — an unexpected state, a dead end after retrying, or an action that seems to need a human decision. Ends the run and requests human help.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What is blocking progress and what you tried." },
      },
      required: ["reason"],
    },
  },
];

const ClickInput = z.object({ ref: z.string(), reasoning: z.string() });
const TypeInput = z.object({ ref: z.string(), text: z.string(), reasoning: z.string() });
const SelectInput = z.object({ ref: z.string(), value: z.string(), reasoning: z.string() });
const NavigateInput = z.object({ url: z.string(), reasoning: z.string() });
const ExtractInput = z.object({ ref: z.string(), label: z.string(), reasoning: z.string() });
const FinishInput = z.object({ summary: z.string() });
const EscalateInput = z.object({ reason: z.string() });

export type AgentToolCall =
  | ({ name: "click" } & z.infer<typeof ClickInput>)
  | ({ name: "type" } & z.infer<typeof TypeInput>)
  | ({ name: "select" } & z.infer<typeof SelectInput>)
  | ({ name: "navigate" } & z.infer<typeof NavigateInput>)
  | ({ name: "extract" } & z.infer<typeof ExtractInput>)
  | ({ name: "finish" } & z.infer<typeof FinishInput>)
  | ({ name: "escalate" } & z.infer<typeof EscalateInput>);

export class UnknownToolCallError extends Error {}

/** Validates a raw tool_use block's `input` against the matching schema — the model's output is
 *  untrusted input from our program's point of view, same as any other external API response. */
export function parseToolCall(block: Anthropic.ToolUseBlock): AgentToolCall {
  switch (block.name) {
    case "click":
      return { name: "click", ...ClickInput.parse(block.input) };
    case "type":
      return { name: "type", ...TypeInput.parse(block.input) };
    case "select":
      return { name: "select", ...SelectInput.parse(block.input) };
    case "navigate":
      return { name: "navigate", ...NavigateInput.parse(block.input) };
    case "extract":
      return { name: "extract", ...ExtractInput.parse(block.input) };
    case "finish":
      return { name: "finish", ...FinishInput.parse(block.input) };
    case "escalate":
      return { name: "escalate", ...EscalateInput.parse(block.input) };
    default:
      throw new UnknownToolCallError(`Model called an unknown tool "${block.name}"`);
  }
}
