import { z } from "zod";

/**
 * Structured output for the drafting agent. All fields are nullable rather than
 * optional — structured outputs require every property present, and `null`
 * cleanly signals "not found" (mergeBookingFacts skips null/empty values).
 */
export const BookingFactsSchema = z.object({
  eventType: z.string().nullable(),
  eventDate: z.string().nullable(),
  startTime: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  endTime: z.string().nullable(),
  timezone: z.string().nullable(),
  package: z.string().nullable(),
  budget: z.string().nullable(),
  location: z.string().nullable(),
  depositAmount: z.string().nullable(),
  balanceDue: z.string().nullable(),
  notes: z.string().nullable(),
});

export const DraftResultSchema = z.object({
  /** What kind of message this is. */
  classification: z.enum(["new_inquiry", "follow_up", "payment", "other"]),
  /** Whether this is a genuine booking lead worth alerting on. */
  isBookingLead: z.boolean(),
  /** 0–1 confidence in the lead classification. */
  confidence: z.number(),
  /** The suggested reply, in the user's voice. */
  draftReply: z.string(),
  /** Specific date/time slots offered in the draft (echo for the record). */
  proposedSlots: z.array(z.string()),
  /** Booking details extracted from the conversation so far. */
  extractedFacts: BookingFactsSchema,
});

export type DraftResult = z.infer<typeof DraftResultSchema>;
export type SchemaBookingFacts = z.infer<typeof BookingFactsSchema>;

/**
 * Convert the schema's nullable facts into the CRM's optional-field shape
 * (drops nulls), so they can be merged into a ClientRecord.
 */
export function toModelFacts(
  facts: SchemaBookingFacts,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value !== null && value !== undefined && value !== "") {
      out[key] = value as string | number;
    }
  }
  return out;
}
