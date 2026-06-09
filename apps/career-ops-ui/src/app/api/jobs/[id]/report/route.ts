import { NextResponse } from "next/server";
import { readReportWithScores } from "@/lib/report";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const num = parseInt(id, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return NextResponse.json({ error: "invalid report id" }, { status: 400 });
  }

  const report = await readReportWithScores(num);
  if (!report) {
    return NextResponse.json({ error: "report not found" }, { status: 404 });
  }

  return NextResponse.json({ report });
}
