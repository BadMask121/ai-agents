import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import { p } from "@/lib/paths";
import { readText, writeText } from "@/lib/textFile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;

export async function GET() {
  const content = await readText(p.cv);
  return NextResponse.json({ content });
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const origName = (file.name || "upload").toLowerCase();
  const ext = path.extname(origName);

  const buf = Buffer.from(await file.arrayBuffer());

  let markdown: string;
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    markdown = buf.toString("utf-8");
  } else if (ext === ".pdf") {
    // pandoc can only emit PDF, never read it — use poppler's pdftotext instead.
    markdown = await pdftotextConvert(buf);
  } else if (ext === ".docx" || ext === ".doc" || ext === ".odt" || ext === ".rtf" || ext === ".html") {
    markdown = await pandocConvert(buf, ext);
  } else {
    return NextResponse.json(
      { error: `unsupported extension: ${ext}` },
      { status: 400 },
    );
  }

  await writeText(p.cv, markdown);
  return NextResponse.json({ ok: true, bytes: markdown.length });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  await writeText(p.cv, body.content);
  return NextResponse.json({ ok: true });
}

async function pandocConvert(input: Buffer, ext: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-"));
  const inputPath = path.join(
    tmpDir,
    `input-${crypto.randomBytes(4).toString("hex")}${ext}`,
  );
  try {
    await fs.writeFile(inputPath, input);
    return await new Promise<string>((resolve, reject) => {
      const args = ["--from", extToFormat(ext), "--to", "gfm", inputPath];
      const proc = spawn("pandoc", args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on("data", (c) => chunks.push(c));
      proc.stderr.on("data", (c) => errChunks.push(c));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(
              `pandoc exited with ${code}: ${Buffer.concat(errChunks).toString()}`,
            ),
          );
        }
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function extToFormat(ext: string): string {
  switch (ext) {
    case ".docx":
      return "docx";
    case ".doc":
      return "doc";
    case ".odt":
      return "odt";
    case ".rtf":
      return "rtf";
    case ".html":
      return "html";
    default:
      throw new Error(`unsupported ext: ${ext}`);
  }
}

async function pdftotextConvert(input: Buffer): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-pdf-"));
  const inputPath = path.join(
    tmpDir,
    `input-${crypto.randomBytes(4).toString("hex")}.pdf`,
  );
  try {
    await fs.writeFile(inputPath, input);
    return await new Promise<string>((resolve, reject) => {
      // -layout preserves multi-column resume structure; "-" writes to stdout.
      const proc = spawn("pdftotext", ["-layout", inputPath, "-"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on("data", (c) => chunks.push(c));
      proc.stderr.on("data", (c) => errChunks.push(c));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(
              `pdftotext exited with ${code}: ${Buffer.concat(errChunks).toString()}`,
            ),
          );
        }
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
