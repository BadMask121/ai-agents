import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";
import { getClient, mutateClient, mergeBookingFacts } from "../crm/store.js";
import { hasMinimumBookingFacts, type BookingFacts, type ClientRecord } from "../crm/model.js";
import { getDefaultCalendarAccount } from "../google/accounts.js";
import { createEvent } from "../google/calendar.js";
import { extractBookingFacts } from "../agent/extractFacts.js";
import { sendEvent } from "../loops/client.js";
import { sendMessage } from "../telegram/client.js";
import { getState, setState, clearState } from "../telegram/conversation.js";

const log = logger("payment");
type PaymentKind = "deposit" | "paid";

function chat(): string {
  return loadConfig().TELEGRAM_CHAT_ID;
}

export async function deposit(clientId: string): Promise<void> {
  return handlePayment(clientId, "deposit");
}

export async function paidInFull(clientId: string): Promise<void> {
  return handlePayment(clientId, "paid");
}

async function handlePayment(clientId: string, kind: PaymentKind): Promise<void> {
  const client = await getClient(clientId);
  if (!client) return;

  // Already booked — just update payment status, never double-create the event.
  if (client.calendarEventId) {
    if (kind === "paid") {
      await mutateClient(clientId, (c) => {
        c.status = "paid-in-full";
        c.bookingFacts.balanceDue = undefined;
      });
      await sendEvent(client.email, "booking_confirmed");
      await sendMessage(chat(), `💰 Marked paid in full for ${client.name ?? client.email}.`);
    } else {
      await sendMessage(chat(), `Already booked for ${client.name ?? client.email}.`);
    }
    return;
  }

  if (!hasMinimumBookingFacts(client.bookingFacts)) {
    await setState(chat(), {
      mode: "awaiting-booking-facts",
      clientId,
      pendingPayment: kind,
    });
    await sendMessage(
      chat(),
      `📅 I need the event details to book ${client.name ?? client.email}.\nReply with the date, start time, and duration (e.g. "Aug 14 2026, 2pm, 4 hours").`,
      { forceReply: true },
    );
    return;
  }

  await createBookingEvent(client, kind);
}

/** Force-reply supplying missing booking facts for a pending payment. */
export async function submitBookingFacts(clientId: string, text: string): Promise<void> {
  const state = await getState(chat());
  const kind: PaymentKind = state.pendingPayment ?? "deposit";

  const facts = await extractBookingFacts(text, loadConfig().BOOKING_TIMEZONE);
  await mergeBookingFacts(clientId, facts);

  const client = await getClient(clientId);
  if (!client) {
    await clearState(chat());
    return;
  }
  if (!hasMinimumBookingFacts(client.bookingFacts)) {
    await sendMessage(
      chat(),
      "I still need a date, start time, and duration (or end time). Please reply again.",
      { forceReply: true },
    );
    return; // keep awaiting-booking-facts
  }
  await clearState(chat());
  await createBookingEvent(client, kind);
}

async function createBookingEvent(client: ClientRecord, kind: PaymentKind): Promise<void> {
  const account = await getDefaultCalendarAccount();
  if (!account) {
    await sendMessage(chat(), "⚠️ No calendar connected. Use /connect, then /setcalendar.");
    return;
  }

  const times = buildEventTimes(client.bookingFacts, loadConfig().BOOKING_TIMEZONE);
  if (!times) {
    await sendMessage(chat(), "⚠️ Couldn't compute the event time from the booking details.");
    return;
  }

  const f = client.bookingFacts;
  const summary = `${f.eventType ?? "Booking"} — ${client.name ?? client.email}`;
  const description = [
    f.package ? `Package: ${f.package}` : null,
    f.budget ? `Budget: ${f.budget}` : null,
    f.depositAmount ? `Deposit: ${f.depositAmount}` : null,
    f.balanceDue ? `Balance due: ${f.balanceDue}` : null,
    `Client: ${client.email}`,
    f.notes ?? null,
  ]
    .filter(Boolean)
    .join("\n");

  const event = await createEvent(account, {
    summary,
    description,
    start: times.start,
    end: times.end,
    timeZone: times.timeZone,
    location: f.location,
  });

  await mutateClient(client.id, (c) => {
    c.calendarEventId = event.id;
    c.status = kind === "paid" ? "paid-in-full" : "deposit-paid";
    if (kind === "paid") c.bookingFacts.balanceDue = undefined;
  });

  await sendEvent(client.email, kind === "paid" ? "booking_confirmed" : "deposit_paid");
  await sendMessage(
    chat(),
    `📅 Booked ${summary}\n${times.start} (${times.timeZone})\n${event.htmlLink}`,
  );
  log.info("event created", { client: client.email, eventId: event.id, kind });
}

/** Build RFC3339 start/end from booking facts, or null if insufficient. */
export function buildEventTimes(
  f: BookingFacts,
  defaultTz: string,
): { start: string; end: string; timeZone: string } | null {
  if (!f.eventDate || !f.startTime) return null;
  const timeZone = f.timezone ?? defaultTz;
  const start = `${f.eventDate}T${pad(f.startTime)}:00`;

  if (f.endTime) {
    return { start, end: `${f.eventDate}T${pad(f.endTime)}:00`, timeZone };
  }
  if (!f.durationMinutes) return null;

  const parts = f.startTime.split(":");
  const h = Number.parseInt(parts[0] ?? "0", 10);
  const m = Number.parseInt(parts[1] ?? "0", 10);
  const startTotal = h * 60 + m;
  const endTotal = startTotal + f.durationMinutes;
  const dayOffset = Math.floor(endTotal / (24 * 60));
  const endMin = endTotal % (24 * 60);
  const endDate = addDays(f.eventDate, dayOffset);
  const end = `${endDate}T${pad2(Math.floor(endMin / 60))}:${pad2(endMin % 60)}:00`;
  return { start, end, timeZone };
}

function pad(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${pad2(Number(h))}:${pad2(Number(m ?? 0))}`;
}
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function addDays(isoDate: string, days: number): string {
  if (days === 0) return isoDate;
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
