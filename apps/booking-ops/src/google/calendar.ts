import { google, type calendar_v3 } from "googleapis";
import { makeOAuthClient } from "./oauthClient.js";
import type { GoogleAccount } from "./accounts.js";

function calendarClient(account: GoogleAccount): calendar_v3.Calendar {
  const auth = makeOAuthClient(account.refreshToken);
  return google.calendar({ version: "v3", auth });
}

export type BusyInterval = { start: string; end: string };

/**
 * Query free/busy for the primary calendar over a window. Used to avoid
 * proposing times that are already booked when drafting a reply.
 */
export async function queryFreeBusy(
  account: GoogleAccount,
  window: { timeMin: string; timeMax: string; timeZone: string },
): Promise<BusyInterval[]> {
  const calendar = calendarClient(account);
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      timeZone: window.timeZone,
      items: [{ id: "primary" }],
    },
  });
  const busy = res.data.calendars?.primary?.busy ?? [];
  return busy
    .filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
    .map((b) => ({ start: b.start, end: b.end }));
}

export type CalendarEventInput = {
  summary: string;
  description?: string;
  /** RFC3339 start/end (or all-day dates). */
  start: string;
  end: string;
  /** IANA timezone, e.g. "Europe/London". */
  timeZone: string;
  location?: string;
};

/** Create a booking event on the account's primary calendar. */
export async function createEvent(
  account: GoogleAccount,
  input: CalendarEventInput,
): Promise<{ id: string; htmlLink: string }> {
  const calendar = calendarClient(account);
  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.start, timeZone: input.timeZone },
      end: { dateTime: input.end, timeZone: input.timeZone },
    },
  });
  return { id: res.data.id!, htmlLink: res.data.htmlLink ?? "" };
}
