import { NextResponse } from "next/server";
import { readPipeline, addUrl, updateState, removeItem } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const stateFilter = searchParams.get("state");
  const minScoreParam = searchParams.get("minScore");

  let items = await readPipeline();

  if (stateFilter && ["pending", "processed", "blocked"].includes(stateFilter)) {
    items = items.filter((i) => i.state === stateFilter);
  }

  if (minScoreParam !== null) {
    const minScore = parseFloat(minScoreParam);
    if (!Number.isNaN(minScore)) {
      items = items.filter((i) => i.score !== null && i.score >= minScore);
    }
  }

  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.url !== "string") {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  try {
    new URL(body.url);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  const item = await addUrl(body.url, {
    company: body.company,
    title: body.title,
  });
  return NextResponse.json({ item });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !body.id || !body.state) {
    return NextResponse.json(
      { error: "id and state required" },
      { status: 400 },
    );
  }
  if (!["pending", "processed", "blocked"].includes(body.state)) {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }
  await updateState(body.id, body.state);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await removeItem(id);
  return NextResponse.json({ ok: true });
}
