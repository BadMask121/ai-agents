// Assistant observability that costs nothing until you want it to: one JSON
// log line per call (Workers Logs, already on), an optional Analytics Engine
// dataset (binding ANALYTICS) and an optional Telegram alert to the owner
// (var ALERT_CHAT_ID). Unset bindings are skipped. No message text, and the
// chat is only a short hash.

import { sha256Hex } from "./bytes";

export interface AgentEvent {
  outcome: "reply" | "confirm" | "limited" | "unavailable";
  ms: number;
  model: string;
  chat: string;
}

export interface AnalyticsSink {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export async function agentEvent(outcome: AgentEvent["outcome"], ms: number, model: string, chatId: string): Promise<AgentEvent> {
  return { outcome, ms, model, chat: (await sha256Hex(chatId)).slice(0, 8) };
}

export function recordAgentEvent(e: AgentEvent, sink?: AnalyticsSink): void {
  console.log(JSON.stringify({ event: "assistant", ...e }));
  try {
    sink?.writeDataPoint({ indexes: [e.chat], blobs: [e.outcome, e.model], doubles: [e.ms] });
  } catch {
    /* metrics never break the bot */
  }
}
