/**
 * Static landing page served at GET /. Purely descriptive — it never exposes the
 * secret MCP path, credentials, or any mailbox data. Self-contained HTML (inline
 * CSS, theme-aware) so there are no external assets to serve.
 */
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>mail-mcp — ChatGPT ⇄ private mailbox</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a17; --muted: #6b6b63;
    --line: #ece9e2; --accent: #b8563f; --chip: #f4f1ea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f; --panel: #1c1c16; --ink: #efece3; --muted: #a3a093;
      --line: #2b2b22; --accent: #e08a6f; --chip: #24241c;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; min-height: 100vh; align-items: center; justify-content: center;
    padding: 32px;
  }
  main {
    width: 100%; max-width: 620px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 16px; padding: 40px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  .badge {
    display: inline-flex; align-items: center; gap: 8px; font-size: 13px;
    color: var(--muted); border: 1px solid var(--line); border-radius: 999px;
    padding: 5px 12px; margin-bottom: 22px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fae6b; box-shadow: 0 0 0 3px rgba(63,174,107,.18); }
  h1 { font-size: 28px; letter-spacing: -.02em; margin: 0 0 8px; }
  h1 .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--accent); }
  .lede { color: var(--muted); font-size: 17px; margin: 0 0 28px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 28px 0 12px; }
  p { margin: 0 0 14px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    font-size: 13px; background: var(--chip); border: 1px solid var(--line);
    border-radius: 8px; padding: 5px 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .rule { height: 1px; background: var(--line); border: 0; margin: 30px 0; }
  footer { color: var(--muted); font-size: 13px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <span class="badge"><span class="dot"></span> Service operational</span>
  <h1><span class="mono">mail-mcp</span></h1>
  <p class="lede">A private <strong>Model Context Protocol</strong> server that lets
  ChatGPT read, send, and manage a personal email mailbox.</p>

  <p>It bridges an AI assistant to a <a href="https://modelcontextprotocol.io" rel="noopener">MCP</a>
  client over the Streamable&nbsp;HTTP transport, talking to the mailbox via standard
  IMAP&nbsp;/&nbsp;SMTP — no web-UI scraping. It's connected to ChatGPT as a custom
  connector in Developer Mode.</p>

  <h2>What it can do</h2>
  <div class="chips">
    <span class="chip">list_folders</span>
    <span class="chip">search_email</span>
    <span class="chip">list_messages</span>
    <span class="chip">read_email</span>
    <span class="chip">get_attachment</span>
    <span class="chip">send_email</span>
    <span class="chip">move_email</span>
    <span class="chip">delete_email</span>
    <span class="chip">mark_email</span>
  </div>

  <hr class="rule" />
  <footer>
    This is a single-user endpoint. The MCP API lives behind a private,
    authenticated path and isn't reachable from here. Nothing to see unless it's
    yours. 🔒
  </footer>
</main>
</body>
</html>`;
