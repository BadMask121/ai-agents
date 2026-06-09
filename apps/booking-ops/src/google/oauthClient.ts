import { google } from "googleapis";
import { loadConfig } from "../config.js";

/**
 * The OAuth2 client type, taken from googleapis' own bundled google-auth-library
 * so it matches what gmail()/calendar() expect (avoids cross-version type skew).
 */
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/**
 * Scopes requested when linking a Google account.
 *   gmail.modify       — read messages, send replies, add/remove labels, mark read
 *   calendar.events    — create the booking event
 *   calendar.readonly  — freebusy.query for availability checks
 * One consent covers both Gmail and Calendar for an account.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/**
 * Build an OAuth2 client. When given a refresh token the googleapis library
 * transparently mints + caches short-lived access tokens, so callers never
 * handle access tokens directly. Used for all per-account Gmail/Calendar calls.
 */
export function makeOAuthClient(refreshToken?: string): OAuth2Client {
  const cfg = loadConfig();
  const client = new google.auth.OAuth2(
    cfg.GOOGLE_CLIENT_ID,
    cfg.GOOGLE_CLIENT_SECRET,
  );
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }
  return client;
}
