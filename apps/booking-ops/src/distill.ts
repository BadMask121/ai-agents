import { promises as fs } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { p } from "./paths.js";
import { atomicWrite } from "./lib/atomicWrite.js";

/**
 * One-off CLI: distill a ChatGPT data export (conversations.json) into a
 * reusable context.md the drafting agent reads on every reply.
 *
 *   pnpm --filter @ai-agents/booking-ops build
 *   BOOKING_OPS_WORKSPACE=./workspace node dist/distill.js path/to/conversations.json
 *
 * Map-reduce: linearize every conversation → chunk under a token budget →
 * extract notes per chunk (map) → merge into one document (reduce).
 */

// Rough budget: ~4 chars/token, target ~80k input tokens per chunk.
const MAX_CHUNK_CHARS = 320_000;

const MAP_PROMPT = `You are reading excerpts of one person's ChatGPT conversations. Extract ONLY what reveals their business and how they communicate, as concise markdown notes. Use these headings (omit any with nothing found):
## About me
## Business & services
## Voice & tone  (include 2-3 short example phrasings in their style)
## Pricing & packages
## Availability & booking rules
## FAQs  (question → short answer)
Be faithful — do not invent facts. Ignore unrelated chatter.`;

const MERGE_PROMPT = `You are merging note fragments into ONE cohesive context document for an assistant that drafts client booking emails in this person's voice. Deduplicate and resolve overlaps. Output clean markdown with exactly these sections:
## About me
## Business & services
## Voice & tone
## Pricing & packages
## Availability & booking rules
## FAQs
Be specific and faithful to the notes; never invent details. If a section has no information, write "(none captured)".`;

type AnyRecord = Record<string, unknown>;

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Flatten one conversation's message tree into role-tagged text. */
function linearize(convo: AnyRecord): string {
  const mapping = (convo.mapping as Record<string, AnyRecord> | undefined) ?? {};
  const nodes = Object.values(mapping).filter((n) => {
    const msg = n?.message as AnyRecord | undefined;
    const content = msg?.content as AnyRecord | undefined;
    return Array.isArray(content?.parts) && (content!.parts as unknown[]).length > 0;
  });

  nodes.sort((a, b) => {
    const ta = ((a.message as AnyRecord)?.create_time as number) ?? 0;
    const tb = ((b.message as AnyRecord)?.create_time as number) ?? 0;
    return ta - tb;
  });

  const lines: string[] = [];
  for (const node of nodes) {
    const msg = node.message as AnyRecord;
    const role = (msg.author as AnyRecord | undefined)?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts = (msg.content as AnyRecord).parts as unknown[];
    const text = parts
      .map((x) => (typeof x === "string" ? x : ((x as AnyRecord)?.text as string) ?? ""))
      .join("\n")
      .trim();
    if (!text) continue;
    lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  if (lines.length === 0) return "";
  const title = (convo.title as string) ?? "Conversation";
  return `### ${title}\n${lines.join("\n")}`;
}

/** Greedily pack conversation texts into chunks under the char budget. */
function chunk(texts: string[]): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const t of texts) {
    if (!t) continue;
    if (buf.length + t.length > MAX_CHUNK_CHARS && buf) {
      chunks.push(buf);
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + t.slice(0, MAX_CHUNK_CHARS);
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const path = process.argv.find((a) => a.endsWith(".json"));
  if (!path) {
    console.error("Usage: node dist/distill.js <conversations.json>");
    process.exit(1);
  }

  console.log(`Reading ${path}…`);
  const raw = await fs.readFile(path, "utf-8");
  const data = JSON.parse(raw) as AnyRecord[];
  const conversations = Array.isArray(data) ? data : [];
  console.log(`Parsed ${conversations.length} conversations.`);

  const texts = conversations.map(linearize).filter(Boolean);
  const chunks = chunk(texts);
  console.log(`Linearized into ${chunks.length} chunk(s). Extracting…`);

  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });

  const fragments: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`  • map ${i + 1}/${chunks.length}`);
    const res = await client.messages.create({
      model: cfg.BOOKING_MODEL,
      max_tokens: 2048,
      system: MAP_PROMPT,
      messages: [{ role: "user", content: chunks[i]! }],
    });
    const note = textOf(res);
    if (note) fragments.push(note);
  }

  if (fragments.length === 0) {
    console.error("No notes extracted — is this a ChatGPT conversations.json export?");
    process.exit(1);
  }

  console.log("Merging into context.md…");
  const merged = await client.messages.create({
    model: cfg.BOOKING_MODEL,
    max_tokens: 4096,
    system: MERGE_PROMPT,
    messages: [{ role: "user", content: fragments.join("\n\n---\n\n") }],
  });

  const context = textOf(merged);
  await atomicWrite(p.context, `${context}\n`);
  console.log(`✅ Wrote ${p.context} (${context.length} chars).`);
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
