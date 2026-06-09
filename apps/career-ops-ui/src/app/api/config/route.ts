import { NextResponse } from "next/server";
import yaml from "js-yaml";
import { p } from "@/lib/paths";
import { readText, writeText } from "@/lib/textFile";

export const dynamic = "force-dynamic";

type FileKind = "profile" | "portals" | "modesProfile";

const files: Record<FileKind, { path: string; format: "yaml" | "markdown" }> =
  {
    profile: { path: p.profile, format: "yaml" },
    portals: { path: p.portals, format: "yaml" },
    modesProfile: { path: p.modesProfile, format: "markdown" },
  };

function kindFromQuery(url: string): FileKind | null {
  const { searchParams } = new URL(url);
  const k = searchParams.get("kind");
  if (k && k in files) return k as FileKind;
  return null;
}

export async function GET(req: Request) {
  const kind = kindFromQuery(req.url);
  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });
  const content = await readText(files[kind].path);
  return NextResponse.json({ content, format: files[kind].format });
}

export async function PUT(req: Request) {
  const kind = kindFromQuery(req.url);
  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (files[kind].format === "yaml") {
    try {
      yaml.load(body.content);
    } catch (err) {
      return NextResponse.json(
        { error: `invalid yaml: ${(err as Error).message}` },
        { status: 400 },
      );
    }
  }
  await writeText(files[kind].path, body.content);
  return NextResponse.json({ ok: true });
}
