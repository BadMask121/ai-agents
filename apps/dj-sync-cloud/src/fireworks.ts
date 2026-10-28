// Fireworks AI as the Telegram assistant's model: an OpenAI-style chat
// completions call behind the same AiRunner shape as the Workers AI binding.

import type { AiRunner } from "./telegram-agent";

const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

export function fireworksRunner(apiKey: string, fetcher: typeof fetch = fetch): AiRunner {
  return {
    async run(model, inputs) {
      // chat_template_kwargs is a Workers AI switch; Fireworks models don't take it.
      const { chat_template_kwargs: _unused, ...body } = inputs;
      const res = await fetcher(FIREWORKS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, ...body }),
      });
      if (!res.ok) throw new Error(`fireworks ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
  };
}
