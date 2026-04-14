import { spawn } from "node:child_process";
import { p } from "./paths";

export type ClaudePromptResult = {
  ok: boolean;
  fullText: string;
  cost: number;
  durationMs: number;
  exitCode: number;
  error?: string;
};

/**
 * Spawn `claude -p "<prompt>"` once, wait for it to exit, and return the
 * final assistant text. Distinct from `runClaudeAction` in runAction.ts —
 * that function streams into an SSE ReadableStream for long-running UI work,
 * this one awaits completion and returns a plain value for the apply-session
 * prepare/iterate agents.
 */
export async function runClaudePrompt(opts: {
  prompt: string;
  allowedTools?: string;
  timeoutMs?: number;
}): Promise<ClaudePromptResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ];
    if (opts.allowedTools) {
      args.push("--allowedTools", opts.allowedTools);
    }

    const proc = spawn("claude", args, {
      cwd: p.root,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let pending = "";
    let stderr = "";
    let fullText = "";
    let cost = 0;
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          // Hard-kill grace period
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }, 5000);
        }, opts.timeoutMs)
      : null;

    proc.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf-8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "result" && typeof ev.result === "string") {
            fullText = ev.result;
            if (typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
          }
        } catch {
          // partial or malformed — keep going
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        fullText: "",
        cost: 0,
        durationMs: Date.now() - startedAt,
        exitCode: -1,
        error: err.message,
      });
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        resolve({
          ok: false,
          fullText,
          cost,
          durationMs,
          exitCode: code ?? -1,
          error: `agent timed out after ${opts.timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          fullText,
          cost,
          durationMs,
          exitCode: code ?? -1,
          error: stderr.slice(-2000) || `non-zero exit ${code}`,
        });
        return;
      }

      resolve({
        ok: true,
        fullText,
        cost,
        durationMs,
        exitCode: 0,
      });
    });
  });
}

/**
 * Extract the LAST fenced ```json block from an agent's full text output and
 * parse it. Returns null if no block exists or the JSON doesn't parse.
 *
 * "Last" is intentional — agents often write a short explanation + the JSON
 * payload, sometimes with example fragments earlier in the prose. The final
 * block is the real output.
 */
export function extractLastJsonBlock<T = unknown>(text: string): T | null {
  const re = /```json\s*\n([\s\S]*?)```/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
  }
  if (last === null) return null;
  try {
    return JSON.parse(last.trim()) as T;
  } catch {
    return null;
  }
}

/**
 * Strip the trailing ```json ... ``` block from an explanation text so the
 * prose part can be stored in history without the payload duplication.
 */
export function stripTrailingJsonBlock(text: string): string {
  return text.replace(/```json\s*\n[\s\S]*?```\s*$/g, "").trim();
}
