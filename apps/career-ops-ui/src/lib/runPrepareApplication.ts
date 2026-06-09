import { readReportWithScores } from "./report";
import { readText } from "./textFile";
import { p } from "./paths";
import {
  appendMessage,
  setError,
  updatePayload,
  type ApplySession,
  type ApplyField,
} from "./applySession";
import {
  runClaudePrompt,
  extractLastJsonBlock,
  stripTrailingJsonBlock,
} from "./runClaudePrompt";
import {
  buildPreparePrompt,
  PREPARE_ALLOWED_TOOLS,
} from "@/agents/prepareApplication";

const PREPARE_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes — covers slow portals

/**
 * Drive the initial prepare pass for an apply session. Reads the candidate
 * context (report + cv + profile), builds the prompt, spawns claude one-shot,
 * parses the JSON block, and writes the result back to the session file.
 *
 * Fire-and-forget from the route handler: don't await, let the Node event
 * loop continue running after the HTTP response flushes. Errors land as
 * `session.error` + `status=failed` so the UI can surface a Retry button.
 */
export async function runPrepareApplication(
  session: ApplySession,
): Promise<void> {
  try {
    const [report, cv, profileYaml] = await Promise.all([
      session.jobNum !== null
        ? readReportWithScores(session.jobNum).catch(() => null)
        : Promise.resolve(null),
      readText(p.cv),
      readText(p.profile),
    ]);

    const prompt = buildPreparePrompt({
      jobUrl: session.jobUrl,
      company: session.company,
      title: session.title,
      score: session.score,
      report,
      cv,
      profileYaml,
    });

    const result = await runClaudePrompt({
      prompt,
      allowedTools: PREPARE_ALLOWED_TOOLS,
      timeoutMs: PREPARE_TIMEOUT_MS,
    });

    if (!result.ok) {
      await setError(
        session.id,
        `prepareApplication failed: ${result.error ?? "unknown"}`,
      );
      return;
    }

    const parsed = extractLastJsonBlock<{ fields?: Array<{ question?: unknown; answer?: unknown }> }>(
      result.fullText,
    );

    if (!parsed || !Array.isArray(parsed.fields)) {
      await setError(
        session.id,
        `prepareApplication: no valid JSON payload in agent output (got ${result.fullText.length} chars)`,
      );
      return;
    }

    const fields: ApplyField[] = parsed.fields
      .filter(
        (f): f is { question: string; answer: string } =>
          typeof f.question === "string" && typeof f.answer === "string",
      )
      .map((f) => ({
        question: f.question,
        answer: f.answer,
        source: "agent",
      }));

    if (fields.length === 0) {
      await setError(
        session.id,
        "prepareApplication: agent returned an empty fields array",
      );
      return;
    }

    const explanation = stripTrailingJsonBlock(result.fullText);
    if (explanation.length > 0) {
      await appendMessage(session.id, "agent", explanation);
    }
    await updatePayload(session.id, fields);
  } catch (err) {
    await setError(
      session.id,
      `prepareApplication crashed: ${(err as Error).message}`,
    );
  }
}

