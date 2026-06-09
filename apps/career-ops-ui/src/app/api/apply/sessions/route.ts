import { NextResponse } from "next/server";
import { readPipeline } from "@/lib/pipeline";
import { createSession } from "@/lib/applySession";
import { runPrepareApplication } from "@/lib/runPrepareApplication";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/apply/sessions
 *
 * Body: `{ jobNum?: number, jobUrl?: string }` — at least one of the two.
 * If `jobNum` is provided, we look up the matching pipeline item to fill
 * company/title/score automatically. Otherwise the URL must be given
 * directly (the job may not be in pipeline.md yet).
 *
 * Creates a new session and fires `runPrepareApplication` as a
 * fire-and-forget promise in the current Node process. Returns immediately
 * with `{ session }` so the client can redirect to `/apply/[id]` and poll
 * for the payload to land.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }

  const jobNum =
    typeof body.jobNum === "number" && Number.isFinite(body.jobNum)
      ? body.jobNum
      : null;
  const directUrl = typeof body.jobUrl === "string" ? body.jobUrl : null;

  if (jobNum === null && directUrl === null) {
    return NextResponse.json(
      { error: "jobNum or jobUrl required" },
      { status: 400 },
    );
  }

  let jobUrl = directUrl;
  let company: string | null = null;
  let title: string | null = null;
  let score: number | null = null;

  if (jobNum !== null) {
    const items = await readPipeline();
    const match = items.find((i) => i.num === jobNum);
    if (!match) {
      return NextResponse.json(
        { error: `no processed pipeline item with num=${jobNum}` },
        { status: 404 },
      );
    }
    jobUrl = match.url;
    company = match.company;
    title = match.title;
    score = match.score;
  }

  if (!jobUrl) {
    return NextResponse.json({ error: "job url unresolved" }, { status: 400 });
  }

  const session = await createSession({
    jobNum,
    jobUrl,
    company,
    title,
    score,
  });

  // Fire-and-forget: the Node event loop keeps running this after the
  // response flushes. On crash or container restart, the session stays
  // `preparing: true` and the UI offers a Retry. See runPrepareApplication.
  void runPrepareApplication(session).catch((err) => {
    // Errors inside runPrepareApplication already call setError, so this
    // catch is just a safety net for programmer mistakes.
    console.error("[apply-prepare] unhandled:", err);
  });

  return NextResponse.json({ session });
}
