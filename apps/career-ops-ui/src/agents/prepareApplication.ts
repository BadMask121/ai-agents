import type { ReportContent } from "@/lib/report";

export type PrepareApplicationInput = {
  jobUrl: string;
  company: string | null;
  title: string | null;
  score: number | null;
  report: ReportContent | null;
  cv: string;
  profileYaml: string;
};

/**
 * Build the prompt we feed to `claude -p "..."` for the initial draft pass of
 * a chat-driven apply session. The agent reads the scored report + CV +
 * profile, navigates the job URL via the Playwright MCP to extract the form
 * fields, and emits a single JSON block with the drafted answers.
 *
 * This prompt is constructed entirely on the UI side — we never reach into
 * the career-ops backend `modes/` directory. Per CLAUDE.md, career-ops is
 * read-only; any new agent behavior lives here.
 *
 * The agent MUST end its output with a fenced ```json block whose shape is:
 *
 *   { "fields": [ { "question": string, "answer": string } ] }
 *
 * The caller parses the last such block out of the stream-json result text.
 * Anything the agent writes BEFORE the JSON block is shown as an explanatory
 * message in the chat history (`history[0]`).
 */
export function buildPreparePrompt(input: PrepareApplicationInput): string {
  const {
    jobUrl,
    company,
    title,
    score,
    report,
    cv,
    profileYaml,
  } = input;

  const header = [
    `You are helping the candidate draft an application for a job they have approved.`,
    `Job: ${title ?? "(role unknown)"} at ${company ?? "(company unknown)"}`,
    `URL: ${jobUrl}`,
    score !== null ? `Evaluated fit: ${score.toFixed(1)}/5` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const reportBlock = report
    ? `## Prior evaluation report\n\n${report.raw}\n`
    : `## Prior evaluation report\n\n(none — this job has not been evaluated yet; rely on the JD you fetch below)\n`;

  const sectionHBlock =
    report && report.sectionH.length > 0
      ? `## Pre-drafted answers from Section H of the evaluation\n\n` +
        report.sectionH
          .map(
            (qa) =>
              `- **${qa.question}**\n  ${qa.answer.replace(/\n/g, "\n  ")}`,
          )
          .join("\n\n") +
        "\n\n**Reuse these where the form has matching questions. Only rewrite if the form explicitly asks something different.**\n"
      : "";

  const cvBlock = `## Candidate CV (cv.md)\n\n${cv}\n`;
  const profileBlock = `## Candidate profile (profile.yml)\n\n\`\`\`yaml\n${profileYaml}\n\`\`\`\n`;

  const instructions = `
## What to do — read carefully

1. **Fetch the job posting**. Use the Playwright MCP tools in this order:
   - \`mcp__playwright__browser_navigate\` to the URL above
   - \`mcp__playwright__browser_snapshot\` to see the rendered form
   - If Playwright fails (LinkedIn login wall, geo-block, portal blocks
     automation), fall back to \`WebFetch\`. If that also fails, emit the
     JSON block with a single placeholder field \`{ "question": "PORTAL
     BLOCKED", "answer": "Agent could not reach the posting. Open the URL
     manually and paste the JD text into the chat to continue." }\` and
     stop.

2. **Identify the application form fields**. Look for inputs, textareas,
   and selects inside a \`<form>\` or any element clearly styled as the
   application. Capture the **question label** (the visible label or
   placeholder text the human would read — not the HTML \`name\`
   attribute), the **type** (short text, long text, select, file upload),
   and any **required** indicator.

3. **Skip fields that don't need a drafted answer**:
   - File uploads (resume, cover letter upload) — the candidate attaches
     these manually.
   - Name / email / phone / location — copy directly from profile.yml.
   - Demographic / EEO questions — do not guess; emit the question with
     an empty answer string and a comment \`"(candidate to fill)"\`.

4. **Draft a thoughtful answer for every remaining open-ended question.**
   Use Section H from the evaluation report (above) as the primary source
   when the question matches. Otherwise, follow this tone:

   - **Confident without arrogance**: "I've spent the past year building
     production AI agent systems — your role is where I want to apply
     that experience next"
   - **Selective without pretension**: "I've been intentional about
     finding a team where I can contribute meaningfully from day one"
   - **Specific and concrete**: always reference something REAL from the
     JD or company AND something REAL from the CV
   - **Direct, no fluff**: 2-4 sentences per answer. No "I'm passionate
     about..." or "I would love the opportunity to..."
   - **The hook is the proof, not the claim**: instead of "I'm great at
     X", say "I built X that does Y"

   Language: match the language of the JD (default EN).

5. **Output format — STRICT**. After your explanatory message, emit
   EXACTLY ONE fenced JSON block. No trailing prose after the JSON. The
   JSON must be:

   \`\`\`json
   {
     "fields": [
       { "question": "Why this role?", "answer": "..." },
       { "question": "Why this company?", "answer": "..." }
     ]
   }
   \`\`\`

   The \`fields\` array order should match the form order. Questions are
   the VISIBLE LABEL, not the HTML name. Answers are the drafted text the
   candidate will send — write them as if the candidate is about to paste
   each one into the portal themselves.

6. **Before the JSON block**, write a 2-4 sentence explanation of what
   you found — how many fields you drafted, which ones you skipped and
   why, anything notable about the posting (salary, remote policy, red
   flag). This message is shown to the candidate as the first chat turn.

Do NOT submit the form. Do NOT click any buttons. You are read-only on
the portal. Your job is to extract and draft, not to act.
`.trim();

  return [header, "", reportBlock, sectionHBlock, cvBlock, profileBlock, instructions].join("\n");
}

/**
 * The list of MCP + built-in tools the prepareApplication agent is allowed
 * to call. Narrowed to read-only browser + fetch + web search — never
 * click, type, submit, or write files.
 */
export const PREPARE_ALLOWED_TOOLS = [
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_close",
  "WebFetch",
  "WebSearch",
  "Read",
].join(",");
