import { getDefaultCalendarAccount } from "../google/accounts.js";
import { queryFreeBusy } from "../google/calendar.js";
import { logger } from "../lib/log.js";

const log = logger("availability");
const WINDOW_DAYS = 45;

/**
 * Human-readable availability summary for the drafting agent. Returns "unknown"
 * if no calendar is connected, so the agent asks for a date rather than
 * committing. Best-effort — a calendar error degrades to "unknown".
 */
export async function computeAvailability(timezone: string): Promise<string> {
  const account = await getDefaultCalendarAccount();
  if (!account) return "unknown";

  const timeMin = new Date().toISOString();
  const timeMax = new Date(
    Date.now() + WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    const busy = await queryFreeBusy(account, { timeMin, timeMax, timeZone: timezone });
    if (busy.length === 0) {
      return `No existing commitments in the next ${WINDOW_DAYS} days — broadly open.`;
    }
    const lines = busy
      .slice(0, 40)
      .map((b) => `  • ${b.start} → ${b.end}`)
      .join("\n");
    return `Already booked in the next ${WINDOW_DAYS} days (do NOT offer these times):\n${lines}`;
  } catch (err) {
    log.warn("freebusy query failed", err);
    return "unknown";
  }
}
