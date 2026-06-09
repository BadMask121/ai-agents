import { spawn } from "node:child_process";
import { p } from "@/lib/paths";
import {
  appendMessage,
  getSession,
  patchPayloadFields,
  type ApplySession,
} from "@/lib/applySession";
import {
  extractLastJsonBlock,
  stripTrailingJsonBlock,
} from "@/lib/runClaudePrompt";
import { buildIteratePrompt } from "@/agents/iterateApplication";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ITERATE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — text-only, no tools

/**
 * POST /api/apply/sessions/[id]/messages
 *
 * Body: `{ content: string }` — the user's new chat message.
 *
 * Commits the user message to the session history, spawns a fresh `claude -p`
 * with the iterate prompt, and streams the agent's response back as SSE. The
 * agent's output is parsed line-by-line for stream-json `assistant` events
 * with text content, which are forwarded to the client as `delta` events for
 * live-typing UX.
 *
 * When the stream ends, the server:
 *   1. Parses the final text for a fenced ```json patch block
 *   2. Applies the patch to session.payload via patchPayloadFields
 *   3. Appends the agent's prose (with the JSON block stripped) to history
 *   4. Emits a final `done` SSE event with the updated session
 *
 * Failures emit an `error` event and close the stream. The user message
 * stays committed to history so the UI can offer a retry without losing it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as
    | { content?: unknown }
    | null;
  const content =
    typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) {
    return new Response(
      JSON.stringify({ error: "content required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const existing = await getSession(id);
  if (!existing) {
    return new Response(
      JSON.stringify({ error: "session not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  if (!existing.payload) {
    return new Response(
      JSON.stringify({ error: "session not ready — no payload yet" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  // Commit the user message immediately so it survives any downstream
  // failure. The iterate prompt uses the session AFTER this append so the
  // agent sees its own context correctly.
  const afterUser = await appendMessage(id, "user", content);

  const prompt = buildIteratePrompt({
    session: afterUser,
    newUserMessage: content,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          // controller may already be closed
        }
      };

      // Empty `--allowedTools` explicitly disables every tool so this is
      // pure text generation — no surprise WebFetch, no Playwright, no
      // Bash. Saves tokens and makes the iterate loop deterministic.
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "",
      ];

      const proc = spawn("claude", args, {
        cwd: p.root,
        env: {
          ...process.env,
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let jsonBuf = "";
      let fullText = "";
      let stderr = "";
      let sawResult = false;

      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }, ITERATE_TIMEOUT_MS);

      proc.stdout.on("data", (chunk: Buffer) => {
        jsonBuf += chunk.toString("utf-8");
        const lines = jsonBuf.split("\n");
        jsonBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Assistant text blocks → stream to client as deltas. Claude-code
          // emits these as they're generated, giving live-typing UX.
          if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
            const msgContent = (ev.message as { content?: unknown }).content;
            if (Array.isArray(msgContent)) {
              for (const c of msgContent) {
                if (
                  c &&
                  typeof c === "object" &&
                  (c as Record<string, unknown>).type === "text" &&
                  typeof (c as Record<string, unknown>).text === "string"
                ) {
                  send("delta", { text: (c as { text: string }).text });
                }
              }
            }
          }

          // Final result event carries the full assembled assistant text.
          // We use that for JSON patch extraction — more reliable than
          // concatenating deltas ourselves.
          if (ev.type === "result") {
            sawResult = true;
            if (typeof ev.result === "string") {
              fullText = ev.result;
            }
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("error", async (err) => {
        clearTimeout(timer);
        send("error", { message: err.message });
        try {
          controller.close();
        } catch {}
      });

      proc.on("close", async (code) => {
        clearTimeout(timer);

        if (code !== 0 || !sawResult) {
          const detail = stderr.slice(-500) || `exit ${code}`;
          send("error", { message: `agent failed: ${detail}` });
          try {
            controller.close();
          } catch {}
          return;
        }

        try {
          // Extract optional JSON patch block from the final text.
          const patch = extractLastJsonBlock<{
            fields?: Array<{ index?: unknown; answer?: unknown }>;
          }>(fullText);

          let updated: ApplySession = afterUser;

          if (patch && Array.isArray(patch.fields) && patch.fields.length > 0) {
            const safePatches = patch.fields
              .filter(
                (f): f is { index: number; answer: string } =>
                  typeof f.index === "number" &&
                  Number.isInteger(f.index) &&
                  typeof f.answer === "string",
              )
              .map((f) => ({ index: f.index, answer: f.answer }));
            if (safePatches.length > 0) {
              updated = await patchPayloadFields(id, safePatches);
            }
          }

          // Strip the JSON block from the prose before persisting as the
          // agent message, so history stays clean. If the prose is empty
          // (rare — agent responded with only JSON), we still append a
          // short placeholder so the chat UI shows something for the turn.
          const prose = stripTrailingJsonBlock(fullText).trim();
          const agentText =
            prose.length > 0
              ? prose
              : "(updated the drafted answers — see above)";
          updated = await appendMessage(id, "agent", agentText);

          send("done", { session: updated });
        } catch (err) {
          send("error", {
            message: `post-stream processing failed: ${(err as Error).message}`,
          });
        } finally {
          try {
            controller.close();
          } catch {}
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
