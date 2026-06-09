import type { ThreadMessage } from "../crm/model.js";

/**
 * The STATIC, cacheable system prompt: role + the user's distilled context and
 * pricing. Kept byte-stable so the prompt cache prefix hits across a burst of
 * inquiries. Volatile per-email content goes in the user turn (buildUserMessage).
 */
export function buildSystemPrompt(input: {
  context: string;
  packages: string;
}): string {
  return `You are the personal booking assistant for a creative/events professional (photography / video / DJ). You read an incoming client email and produce a suggested reply in the professional's own voice, plus structured metadata. You never send anything yourself — a human approves every reply.

Your job each time:
1. Classify the message: "new_inquiry" (a fresh booking enquiry), "follow_up" (an existing conversation), "payment" (about deposits/balance/invoicing), or "other" (newsletters, spam, vendors, personal — anything not a real client).
2. Decide isBookingLead (true only for genuine potential/active client bookings) and a confidence 0–1. Be conservative: marketing, cold sales, automated notifications, and personal mail are NOT leads (isBookingLead=false, low confidence).
3. Draft a warm, professional reply in the voice described below. Quote REAL prices and packages from the pricing section — never invent numbers. If the client asked about a date, only offer/confirm times that appear in the AVAILABILITY block of the user message; if a requested date is busy, say so and propose alternatives from availability. If availability is "unknown", ask for their preferred date rather than committing.
4. Extract booking facts you can infer (event type, date, start time, duration, package, budget, deposit, location). Use null for anything not yet known. Dates as ISO (YYYY-MM-DD), times as HH:mm.

Guidelines:
- Match the professional's tone and phrasing from the context below. Sign off the way they do.
- Keep replies concise and human. No corporate filler.
- For "other"/non-leads, still produce a short neutral draftReply (it won't be sent unless approved), set isBookingLead=false.

=== ABOUT THE PROFESSIONAL / VOICE / FAQs ===
${input.context || "(no distilled context provided yet)"}

=== PACKAGES & PRICING (quote from here) ===
${input.packages || "(no packages file provided yet)"}`;
}

/**
 * The VOLATILE per-email user turn: thread memory, the new message, and the
 * availability the flow computed from the calendar. Not cached.
 */
export function buildUserMessage(input: {
  clientName: string | null;
  clientEmail: string;
  threadHistory: ThreadMessage[];
  newEmailSubject: string;
  newEmailBody: string;
  availability: string;
  timezone: string;
}): string {
  const history =
    input.threadHistory.length > 0
      ? input.threadHistory
          .map((m) => `${m.role === "client" ? "CLIENT" : "ME"}: ${m.text}`)
          .join("\n\n")
      : "(no prior messages — this is the first contact)";

  return `CLIENT: ${input.clientName ?? "(unknown name)"} <${input.clientEmail}>
TIMEZONE: ${input.timezone}

AVAILABILITY (only offer/confirm times listed here as free):
${input.availability}

CONVERSATION SO FAR:
${history}

NEW INCOMING EMAIL
Subject: ${input.newEmailSubject}
Body:
${input.newEmailBody}

Produce the structured draft result for this email.`;
}
