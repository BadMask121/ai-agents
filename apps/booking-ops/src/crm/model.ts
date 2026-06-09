import { createHash } from "node:crypto";

/**
 * Lifecycle of a client/booking. Deposit confirms the booking (creates the
 * calendar event) with a balance owed; `paid-in-full` is the single-payment
 * path. Invalid transitions throw — same guard pattern as career-ops-ui.
 */
export type ClientStatus =
  | "new"
  | "quoted"
  | "awaiting-payment"
  | "deposit-paid"
  | "booked"
  | "paid-in-full"
  | "lost"
  | "other";

export const TRANSITIONS: Record<ClientStatus, ClientStatus[]> = {
  new: ["quoted", "awaiting-payment", "lost", "other"],
  quoted: ["awaiting-payment", "deposit-paid", "paid-in-full", "lost", "other"],
  "awaiting-payment": ["deposit-paid", "paid-in-full", "lost", "other"],
  "deposit-paid": ["paid-in-full", "booked", "lost"],
  booked: ["paid-in-full"],
  "paid-in-full": ["booked"],
  lost: ["new", "quoted"],
  other: ["new", "quoted", "lost"],
};

export function assertTransition(from: ClientStatus, to: ClientStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid client status transition: ${from} → ${to}`);
  }
}

export type ThreadMessage = {
  role: "client" | "user";
  text: string;
  gmailMessageId?: string;
  ts: string;
};

/** Structured booking details extracted from the conversation. */
export type BookingFacts = {
  eventType?: string;
  eventDate?: string; // ISO date, e.g. 2026-08-14
  startTime?: string; // HH:mm local
  durationMinutes?: number;
  endTime?: string; // HH:mm local (alternative to duration)
  timezone?: string; // IANA, overrides BOOKING_TIMEZONE for this client
  package?: string;
  budget?: string;
  location?: string;
  depositAmount?: string;
  balanceDue?: string;
  notes?: string;
};

export type ClientRecord = {
  id: string;
  email: string;
  name: string | null;
  status: ClientStatus;
  /** Google account that received this thread; replies send from it. */
  accountEmail: string;
  gmailThreadId: string | null;
  thread: ThreadMessage[];
  bookingFacts: BookingFacts;
  lastDraft: string | null;
  calendarEventId: string | null;
  loopsSynced: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Stable per-address id so the same client always maps to one record. */
export function clientIdForEmail(email: string): string {
  return createHash("sha1")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/** Fields required before a calendar event can be created. */
export function hasMinimumBookingFacts(facts: BookingFacts): boolean {
  return Boolean(
    facts.eventDate &&
      facts.startTime &&
      (facts.durationMinutes || facts.endTime),
  );
}
