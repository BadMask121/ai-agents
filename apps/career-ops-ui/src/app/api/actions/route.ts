import { NextResponse } from "next/server";
import { isActionMode, runClaudeAction } from "@/lib/runAction";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.mode !== "string") {
    return NextResponse.json({ error: "mode required" }, { status: 400 });
  }
  if (!isActionMode(body.mode)) {
    return NextResponse.json({ error: `unknown mode: ${body.mode}` }, { status: 400 });
  }
  const arg = typeof body.arg === "string" ? body.arg : undefined;

  const { stream } = runClaudeAction({
    mode: body.mode,
    arg,
    timeoutMs: 30 * 60 * 1000,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
