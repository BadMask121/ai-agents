import { NextResponse } from "next/server";
import { getSession } from "@/lib/applySession";
import { runPrepareApplication } from "@/lib/runPrepareApplication";
import { promises as fs } from "node:fs";
import path from "node:path";
import { p } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/apply/sessions/[id]/retry
 *
 * Resets `error`, flips `status` back to `draft` if it was `failed`, sets
 * `preparing: true`, and re-fires `runPrepareApplication` as fire-and-forget.
 * Used when a prepare pass crashed or the container restarted mid-run and
 * the session is stuck.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existing = await getSession(id);
  if (!existing) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  // Reset to draft if previously failed. If it's currently "ready" or
  // "applied" we disallow the retry to prevent clobbering a good payload.
  if (existing.status === "applied") {
    return NextResponse.json(
      { error: "session already marked as applied" },
      { status: 409 },
    );
  }
  if (existing.status === "ready" && existing.payload) {
    return NextResponse.json(
      { error: "session already has a payload — cannot retry" },
      { status: 409 },
    );
  }

  // Reset in place: clear error, mark preparing.
  const sessionPath = path.join(p.applySessions, `${id}.json`);
  const next = {
    ...existing,
    preparing: true,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  if (next.status === "failed") next.status = "draft";
  await fs.writeFile(sessionPath, JSON.stringify(next, null, 2), "utf-8");

  void runPrepareApplication(next).catch((err) => {
    console.error("[apply-retry] unhandled:", err);
  });

  return NextResponse.json({ session: next });
}

