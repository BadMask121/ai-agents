import http from "node:http";
import { google } from "googleapis";
import { loadConfig } from "./config.js";
import { GOOGLE_SCOPES } from "./google/oauthClient.js";
import { saveAccount, type GoogleAccount } from "./google/accounts.js";

/**
 * Link a Google account using the OAuth **loopback** flow (the standard
 * installed-app flow). Google's device flow does NOT permit Gmail/Calendar
 * scopes, so we open a browser, you authorize, and Google redirects to a
 * temporary localhost listener that captures the code.
 *
 * Requires an OAuth client of type **"Desktop app"** (loopback redirects allowed).
 *
 *   pnpm --filter @ai-agents/booking-ops build
 *   pnpm --filter @ai-agents/booking-ops auth:local
 *
 * Tokens land in the workspace at google-accounts/<email>.json. Repeat to link
 * more accounts. To use them on the server, copy that dir into the deploy volume.
 */
const PORT = 4571;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redirectUri = `http://localhost:${PORT}`;
  const oauth2 = new google.auth.OAuth2(
    cfg.GOOGLE_CLIENT_ID,
    cfg.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
    scope: GOOGLE_SCOPES,
  });

  console.log("\nOpen this URL in your browser and authorize the account:\n");
  console.log(authUrl);
  console.log(`\nWaiting for the redirect on ${redirectUri} …`);

  const code = await waitForCode(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh token returned. Remove this app at myaccount.google.com/permissions, then re-run.",
    );
  }
  oauth2.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;
  if (!email) throw new Error("Could not resolve the account email after auth.");

  const account: GoogleAccount = {
    email,
    refreshToken: tokens.refresh_token,
    scopes: GOOGLE_SCOPES,
    connectedAt: new Date().toISOString(),
  };
  await saveAccount(account);
  console.log(`\n✅ Connected ${email}`);
  console.log("Token saved to the workspace. Run auth:local again to add another account.");
}

/** Run a one-shot localhost server to capture the OAuth redirect's ?code=. */
function waitForCode(redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.end(`Authorization failed: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(error));
        return;
      }
      if (!code) {
        res.statusCode = 404;
        res.end("Waiting for authorization…");
        return;
      }
      res.end("✅ Connected. You can close this tab and return to the terminal.");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(PORT);
  });
}

main().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
