import { LoopsClient, APIError, RateLimitExceededError } from "loops";
import { loadConfig } from "../config.js";
import { logger } from "../lib/log.js";

const log = logger("loops");

/**
 * Loops.so lead store via the official `loops` SDK. Every call is best-effort and
 * NEVER throws — a Loops outage or rate-limit must not block drafting or sending.
 * Callers use the returned {ok} to flag the client for a later retry.
 */
export type LoopsResult = { ok: boolean; error?: string };

let client: LoopsClient | null = null;
function getClient(): LoopsClient | null {
  if (client) return client;
  try {
    client = new LoopsClient(loadConfig().LOOPS_API_KEY);
    return client;
  } catch (err) {
    log.warn("loops client init failed", err);
    return null;
  }
}

function toResult(scope: string, err: unknown): LoopsResult {
  if (err instanceof RateLimitExceededError) {
    log.warn(`loops ${scope} rate-limited`, { limit: err.limit, remaining: err.remaining });
    return { ok: false, error: "rate_limited" };
  }
  if (err instanceof APIError) {
    log.warn(`loops ${scope} API error`, { status: err.statusCode, body: err.json });
    return { ok: false, error: String(err.statusCode) };
  }
  log.warn(`loops ${scope} failed`, err);
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Create-or-update a contact (lead). `updateContact` upserts on email, so we
 * avoid create-vs-update branching. firstName / source / userGroup are standard
 * Loops contact properties, so they go inside `properties`.
 */
export async function upsertContact(input: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  source?: string;
  userGroup?: string;
  properties?: Record<string, string | number | boolean | null>;
}): Promise<LoopsResult> {
  const c = getClient();
  if (!c) return { ok: false, error: "no_client" };

  const properties: Record<string, string | number | boolean | null> = {
    ...(input.properties ?? {}),
  };
  if (input.firstName) properties.firstName = input.firstName;
  if (input.lastName) properties.lastName = input.lastName;
  if (input.source) properties.source = input.source;
  if (input.userGroup) properties.userGroup = input.userGroup;

  try {
    await c.updateContact({ email: input.email, properties });
    return { ok: true };
  } catch (err) {
    return toResult("updateContact", err);
  }
}

/** Fire an event (triggers Loops automations), e.g. `booking_inquiry`. */
export async function sendEvent(
  email: string,
  eventName: string,
  properties?: Record<string, string | number | boolean>,
): Promise<LoopsResult> {
  const c = getClient();
  if (!c) return { ok: false, error: "no_client" };

  try {
    await c.sendEvent({
      email,
      eventName,
      ...(properties ? { eventProperties: properties } : {}),
    });
    return { ok: true };
  } catch (err) {
    return toResult("sendEvent", err);
  }
}
