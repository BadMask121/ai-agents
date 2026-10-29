// Fireworks AI as the Telegram assistant's model: an OpenAI-style chat
// completions call behind the same AiRunner shape as the Workers AI binding.
// chainRunner puts several models behind one runner: DeepSeek on Fireworks
// first, Workers AI when it fails or times out.

import { AGENT_CALL_TIMEOUT_MS } from "./constants";
import type { AiRunner } from "./telegram-agent";

const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

export function fireworksRunner(apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = AGENT_CALL_TIMEOUT_MS): AiRunner {
  return {
    async run(model, inputs) {
      // chat_template_kwargs is a Workers AI switch; Fireworks models don't take it.
      const { chat_template_kwargs: _unused, ...body } = inputs;
      const res = await fetcher(FIREWORKS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`fireworks ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
  };
}

/** Each runner with its own model, tried in order; the last error if all fail. */
export function chainRunner(runners: { ai: AiRunner; model: string }[]): AiRunner {
  return {
    async run(_model, inputs) {
      let last: unknown = new Error("no assistant model configured");
      for (const [i, r] of runners.entries()) {
        try {
          return await r.ai.run(r.model, inputs);
        } catch (e) {
          last = e;
          const next = runners[i + 1];
          if (next) console.warn(`assistant model ${r.model} failed, trying ${next.model}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw last;
    },
  };
}
