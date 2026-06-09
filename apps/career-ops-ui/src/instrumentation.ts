// Next.js auto-loads this file once when the server boots. We use it for
// two things:
//   1. Loud warnings about temporary or unsafe runtime configuration flags.
//   2. A preflight check that the claude CLI + Playwright MCP are actually
//      usable — catches structural regressions (missing binary, broken
//      permissions, MCP disconnected) at container boot instead of at the
//      first user Evaluate click, where they look like silent failures.

export async function register(): Promise<void> {
  if (process.env.ALLOW_INSECURE_COOKIES === "1") {
    const lines = [
      "",
      "════════════════════════════════════════════════════════════════════════",
      "  ⚠  ALLOW_INSECURE_COOKIES=1 — session cookies are being issued WITHOUT",
      "     the Secure flag. This is a TEMPORARY workaround so the app can be",
      "     used over plain HTTP (e.g. Coolify's sslip.io URL) until real TLS",
      "     is set up.",
      "",
      "     REMOVE THIS FLAG as soon as you have a real domain + Let's Encrypt",
      "     cert wired up via Coolify (Phase 5 of the deploy checklist).",
      "",
      "     Tracked by bd issue: ai-agents-0xv",
      "════════════════════════════════════════════════════════════════════════",
      "",
    ];
    for (const line of lines) console.warn(line);
  }

  // Preflight — only on the Node runtime (edge runtime can't spawn processes).
  // We intentionally don't await the full result in the hot path; the checks
  // run in the background and log their findings a few seconds after boot.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    void verifyClaudeCli();
  }
}

// Confirms the claude CLI is installed and that claude's MCP registry shows
// the playwright server as "Connected". Pure filesystem + local IPC checks —
// never hits the Anthropic API, so it's free and safe to run on every boot.
async function verifyClaudeCli(): Promise<void> {
  const { spawn } = await import("node:child_process");

  const runCli = (args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const proc = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
      proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
      }, timeoutMs);
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: stderr + "\n" + err.message });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });

  const warn = (msg: string) => {
    console.warn("");
    console.warn("⚠  career-ops preflight: " + msg);
    console.warn(
      "   Agent actions (Evaluate, Dispatch) will fail until this is fixed.",
    );
    console.warn("");
  };

  // 1. Binary present + responsive?
  const version = await runCli(["--version"], 5_000);
  if (version.code !== 0) {
    warn(
      `claude --version failed (code ${version.code}). ` +
        (version.stderr?.slice(0, 200) ?? "no stderr"),
    );
    return;
  }
  const versionStr = version.stdout.trim();
  console.log(`✓ career-ops preflight: claude CLI present (${versionStr})`);

  // 2. Playwright MCP connected?
  const mcp = await runCli(["mcp", "list"], 15_000);
  if (mcp.code !== 0) {
    warn(
      `claude mcp list failed (code ${mcp.code}). ` +
        (mcp.stderr?.slice(0, 200) ?? "no stderr"),
    );
    return;
  }
  const connected = /playwright[^\n]*Connected/i.test(mcp.stdout);
  if (!connected) {
    warn(
      "claude mcp list did not report playwright as Connected. " +
        "Output: " +
        mcp.stdout.slice(0, 400),
    );
    return;
  }
  console.log("✓ career-ops preflight: playwright MCP connected");
}
