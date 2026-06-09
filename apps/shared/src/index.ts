/** Shared types and helpers for agent packages. */

import { randomUUID } from "node:crypto";

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: AgentRole;
  content: string;
};

export type AgentRunInput = {
  messages: ChatMessage[];
  /** Optional correlation id for logs/traces */
  runId?: string;
};

export function createRunId(): string {
  return randomUUID();
}
