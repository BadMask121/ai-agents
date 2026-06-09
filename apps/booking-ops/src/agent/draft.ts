import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";
import type { ThreadMessage } from "../crm/model.js";
import { DraftResultSchema, type DraftResult } from "./schema.js";
import { buildSystemPrompt, buildUserMessage } from "./prompts.js";

const log = logger("draft");

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: loadConfig().ANTHROPIC_API_KEY });
  return client;
}

export type DraftInput = {
  /** Distilled context.md — static, cached. */
  context: string;
  /** packages.yml contents — static, cached. */
  packages: string;
  clientName: string | null;
  clientEmail: string;
  threadHistory: ThreadMessage[];
  newEmailSubject: string;
  newEmailBody: string;
  /** Human-readable availability the flow computed from the calendar. */
  availability: string;
  timezone: string;
};

/**
 * Classify an inbound email and draft a reply.
 *
 * Caching: the system prompt (role + context.md + packages.yml) is marked
 * `cache_control: ephemeral` so a burst of inquiries reuses the static prefix
 * (5-min TTL). The volatile per-email content sits in the user turn, uncached.
 * Structured output via messages.parse() + zodOutputFormat guarantees a valid
 * DraftResult (the model is constrained to the schema). Haiku-friendly: no
 * thinking/effort params (they 400 on Haiku).
 */
export async function draftReply(input: DraftInput): Promise<DraftResult> {
  const cfg = loadConfig();

  const response = await getClient().messages.parse({
    model: cfg.BOOKING_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: buildSystemPrompt({ context: input.context, packages: input.packages }),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildUserMessage(input) }],
    output_config: { format: zodOutputFormat(DraftResultSchema) },
  });

  if (response.usage) {
    log.info("draft complete", {
      model: response.model,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    });
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `draft produced no structured output (stop_reason=${response.stop_reason})`,
    );
  }
  return parsed;
}
