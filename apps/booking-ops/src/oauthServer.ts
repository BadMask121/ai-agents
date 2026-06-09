import http from "node:http";
import { logger } from "./lib/log.js";
import { consumeState } from "./crm/oauthState.js";
import { exchangeCode } from "./google/oauthWeb.js";
import { saveAccount, type GoogleAccount } from "./google/accounts.js";
import { GOOGLE_SCOPES } from "./google/oauthClient.js";
import { sendMessage } from "./telegram/client.js";

const log = logger("oauth-server");

function html(title: string, body: string): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center"><h2>${title}</h2><p>${body}</p></body>`;
}

/**
 * Tiny public web server for the Telegram /connect flow's OAuth redirect.
 * Routes: GET /oauth/callback  (Google redirects here after consent)
 *         GET /healthz         (liveness)
 * On success it saves the account and DMs the requesting chat "Connected".
 */
export function startOAuthServer(port: number, signal: AbortSignal): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error("oauth handler error", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/html" });
      res.end(html("Something went wrong", "Please return to Telegram and try /connect again."));
    });
  });

  server.on("error", (err) => log.error("oauth server error", err));
  server.listen(port, "0.0.0.0", () => log.info(`oauth server listening on :${port}`));

  signal.addEventListener("abort", () => server.close());
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url.pathname !== "/oauth/callback") {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(html("Not found", ""));
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const now = Date.now();

  if (error) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(html("Authorization cancelled", `Google returned: ${error}. You can close this tab.`));
    return;
  }
  if (!code || !state) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(html("Invalid request", "Missing code or state. Try /connect again."));
    return;
  }

  const chatId = await consumeState(state, now);
  if (!chatId) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(html("Link expired", "That link has expired or was already used. Send /connect for a fresh one."));
    return;
  }

  const { email, refreshToken } = await exchangeCode(code);
  const account: GoogleAccount = {
    email,
    refreshToken,
    scopes: GOOGLE_SCOPES,
    connectedAt: new Date(now).toISOString(),
  };
  await saveAccount(account);
  await sendMessage(chatId, `✅ Connected ${email}`).catch((e) =>
    log.warn("failed to notify chat after connect", e),
  );

  log.info("account connected via web flow", { email });
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html("✅ Connected", `${email} is linked. Return to Telegram — you're all set.`));
}
