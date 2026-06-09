import type { ApplySession } from "@/lib/applySession";

export type IterateApplicationInput = {
  session: ApplySession;
  newUserMessage: string;
};

/**
 * Build the prompt for a single chat turn on an active apply session. The
 * agent sees the current drafted payload, the recent conversation history,
 * and the user's latest message, then:
 *
 *   1. Responds conversationally (short prose).
 *   2. If the user's request requires editing one or more answers, emits a
 *      fenced ```json block at the very end with an index-based patch list.
 *   3. Does NOT use any tools — pure text generation. The entire context is
 *      in the prompt; there's no browsing, fetching, or file reading.
 *
 * The caller pipes the stream-json output through SSE to the client for live
 * typing UX, and parses the final JSON block server-side to apply the patch
 * via `patchPayloadFields`.
 */
export function buildIteratePrompt(input: IterateApplicationInput): string {
  const { session, newUserMessage } = input;

  const header = [
    `You are helping the candidate refine a drafted job application via chat.`,
    `Job: ${session.title ?? "(role unknown)"} at ${session.company ?? "(company unknown)"}`,
    `URL: ${session.jobUrl}`,
    session.score !== null ? `Evaluated fit: ${session.score.toFixed(1)}/5` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const fields = session.payload?.fields ?? [];
  const payloadBlock =
    fields.length === 0
      ? "## Current drafted answers\n\n(empty — nothing to iterate on yet)\n"
      : "## Current drafted answers\n\n" +
        fields
          .map((f, idx) => {
            const answer =
              f.answer.length > 0 ? f.answer : "(blank — candidate to fill)";
            return `### [${idx}] ${f.question}\n${answer}`;
          })
          .join("\n\n") +
        "\n";

  // Last 10 turns of conversation — keeps the prompt bounded. The new user
  // message is passed separately and appended here for the agent's context.
  const recent = session.history.slice(-10);
  const historyBlock =
    recent.length === 0
      ? "## Recent conversation\n\n(this is the first turn)\n"
      : "## Recent conversation\n\n" +
        recent
          .map((m) => {
            const role =
              m.role === "user" ? "User" : m.role === "agent" ? "Assistant" : "System";
            return `**${role}:** ${m.content}`;
          })
          .join("\n\n") +
        "\n";

  const userBlock = `## The user just said\n\n${newUserMessage}\n`;

  const instructions = `
## What to do

1. **Respond conversationally** in 2-4 short sentences. Address the user's
   request directly. Don't repeat what they said back to them. Don't start
   with "Sure!" or "Of course!" — just get to the point.

2. **If the request requires editing one or more answers**, emit a fenced
   JSON block at the very END of your response. No prose after the JSON.
   The JSON shape is strict:

   \`\`\`json
   {
     "fields": [
       { "index": 2, "answer": "new full text here" }
     ]
   }
   \`\`\`

   - \`index\` is the zero-based index shown in brackets above (\`[0]\`, \`[1]\`, …)
   - \`answer\` is the complete replacement text — not a diff, not a patch.
     Write the entire new answer as if the candidate will paste it directly
     into the portal.
   - Only include fields that ACTUALLY changed. Do not re-emit unchanged
     fields.
   - If no fields need to change (the user is chatting, asking a question,
     or giving feedback that doesn't translate to a concrete edit), do not
     emit a JSON block at all.

3. **Tone for rewritten answers**: confident without arrogance, specific
   and concrete, direct (no "I'm passionate about" or "leveraged"), 2-4
   sentences per answer, reference real things from the CV + the JD. Match
   the language of the existing drafts.

4. **Do NOT use tools**. You have everything you need above. Don't try to
   browse, fetch, or read files — just think and write.

5. **Do NOT wrap the explanatory prose in quotes or markdown headers.**
   Plain text. The chat UI renders your response as a conversation message.
`.trim();

  return [
    header,
    "",
    payloadBlock,
    historyBlock,
    userBlock,
    instructions,
  ].join("\n");
}
