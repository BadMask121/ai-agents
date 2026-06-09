import { google } from "googleapis";
import { loadConfig } from "../config.js";
import { GOOGLE_SCOPES } from "./oauthClient.js";

/**
 * OAuth helpers for the Telegram → phone **web-callback** flow (authorization
 * code with a public redirect). Requires a "Web application" OAuth client with
 * GOOGLE_REDIRECT_URI registered as an authorized redirect URI.
 */
function webClient() {
  const cfg = loadConfig();
  if (!cfg.GOOGLE_REDIRECT_URI) {
    throw new Error("GOOGLE_REDIRECT_URI is not set");
  }
  return new google.auth.OAuth2(
    cfg.GOOGLE_CLIENT_ID,
    cfg.GOOGLE_CLIENT_SECRET,
    cfg.GOOGLE_REDIRECT_URI,
  );
}

/** Build the consent URL the bot sends to the user. `state` ties it to a chat. */
export function buildAuthUrl(state: string): string {
  return webClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
    scope: GOOGLE_SCOPES,
    state,
  });
}

/** Exchange the redirect's `code` for a refresh token + the account's email. */
export async function exchangeCode(
  code: string,
): Promise<{ email: string; refreshToken: string }> {
  const oauth2 = webClient();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh token returned. Remove the app at myaccount.google.com/permissions and retry.",
    );
  }
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;
  if (!email) throw new Error("Could not resolve the account email after auth.");
  return { email, refreshToken: tokens.refresh_token };
}
