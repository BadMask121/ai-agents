import {
  createRunId,
  type AgentRunInput,
  type ChatMessage,
} from "@ai-agents/shared";

function summarize(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

const input: AgentRunInput = {
  runId: createRunId(),
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello from the TypeScript monorepo." },
  ],
};

console.log("runId:", input.runId);
console.log("conversation:\n", summarize(input.messages));
