import { NextResponse } from "next/server";
import { reconcileEvaluation } from "@/lib/reconcileEvaluation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/pipeline/reconcile
// body: { id: string }
//
// Called by the Pipeline UI right after the /api/actions stream for an
// auto-pipeline run finishes. Locates the just-written report on disk,
// extracts the overall score + num + pdfReady, and patches the pipeline row.
// Always returns the current state of the item — the caller treats a
// non-ok outcome as "still processed, just not scored".
export async function POST(req: Request) {
  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.id !== "string" || body.id.length === 0) {
    return NextResponse.json(
      { error: "id (string) required" },
      { status: 400 },
    );
  }

  try {
    const outcome = await reconcileEvaluation(body.id);
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "reconcile failed" },
      { status: 500 },
    );
  }
}
