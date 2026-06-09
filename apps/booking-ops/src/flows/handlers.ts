import type { ActionHandlers } from "../telegram/loop.js";
import { approve, reject, notLead, submitEditedDraft } from "./approve.js";
import { deposit, paidInFull, submitBookingFacts } from "./payment.js";

/** Wires the flow handlers into the Telegram loop's ActionHandlers contract. */
export const actionHandlers: ActionHandlers = {
  approve,
  reject,
  notLead,
  submitEditedDraft,
  deposit,
  paidInFull,
  submitBookingFacts,
};
