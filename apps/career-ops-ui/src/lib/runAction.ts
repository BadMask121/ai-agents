import { spawn } from "node:child_process";
import { p } from "./paths";

export type ActionMode =
  | "scan"
  | "pipeline"
  | "tracker"
  | "pdf"
  | "deep"
  | "oferta"
  | "auto-pipeline";

const MODES: ActionMode[] = [
  "scan",
  "pipeline",
  "tracker",
  "pdf",
  "deep",
  "oferta",
  "auto-pipeline",
];

export function isActionMode(v: string): v is ActionMode {
  return (MODES as string[]).includes(v);
}

export function runClaudeAction(opts: {
  mode: ActionMode;
  arg?: string;
  timeoutMs?: number;
}): {
  stream: ReadableStream<Uint8Array>;
  abort: () => void;
} {
  const promptBody = opts.arg
    ? `/career-ops ${opts.mode} ${opts.arg}`
    : `/career-ops ${opts.mode}`;

  const env = {
    ...process.env,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };

  // --dangerously-skip-permissions: the CLI defaults to permissionMode
  // "default", which interactively prompts for every sensitive tool call
  // (Bash, WebFetch, Playwright MCP, etc.). In a non-interactive `-p`
  // invocation spawned from a web request there is no user to approve the
  // prompts, so every such tool call silently fails as "permission not
  // granted" and the agent finishes without extracting the JD or writing a
  // report. The container is already isolated: it runs as the `node` user,
  // workspace writes are confined to the bind-mounted career-ops workspace,
  // and the only outward network access is over the container's NAT. Flip
  // the mode to bypassPermissions so the agent can actually do its job.
  const proc = spawn(
    "claude",
    [
      "-p",
      promptBody,
      "--model",
      "haiku",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: p.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const encoder = new TextEncoder();
  const abort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {}
  };

  let timer: NodeJS.Timeout | null = null;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(abort, opts.timeoutMs);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      send("start", { mode: opts.mode, arg: opts.arg ?? null });

      proc.stdout.on("data", (chunk: Buffer) => {
        send("stdout", { chunk: chunk.toString("utf-8") });
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        send("stderr", { chunk: chunk.toString("utf-8") });
      });
      proc.on("error", (err) => {
        send("error", { message: err.message });
        controller.close();
      });
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        send("end", { code });
        controller.close();
      });
    },
    cancel() {
      abort();
    },
  });

  return { stream, abort };
}
