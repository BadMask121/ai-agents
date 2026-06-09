import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadConfig } from "../config.js";
import { BookingFactsSchema, toModelFacts } from "./schema.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: loadConfig().ANTHROPIC_API_KEY });
  return client;
}

/**
 * Parse a free-text Telegram reply ("Aug 14, 2pm, 4 hours") into structured
 * booking facts, so the payment flow can fill gaps and create the event.
 * Returns CRM-ready facts (nulls dropped).
 */
export async function extractBookingFacts(
  text: string,
  timezone: string,
): Promise<Record<string, string | number>> {
  const cfg = loadConfig();
  const response = await getClient().messages.parse({
    model: cfg.BOOKING_MODEL,
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: `Extract booking event details from the user's message. Use null for anything not stated. Dates as ISO YYYY-MM-DD, times as 24h HH:mm. Default timezone is ${timezone}. durationMinutes is an integer count of minutes.`,
      },
    ],
    messages: [{ role: "user", content: text }],
    output_config: { format: zodOutputFormat(BookingFactsSchema) },
  });
  const parsed = response.parsed_output;
  return parsed ? toModelFacts(parsed) : {};
}
