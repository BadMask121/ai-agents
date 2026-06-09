import { NextResponse } from "next/server";
import { getSessionFromCookie } from "@/lib/auth";
import { verifyAutofillToken } from "@/lib/autofillToken";
import {
  EMPTY_PROFILE,
  readAutofillProfile,
  writeAutofillProfile,
  type AutofillProfile,
} from "@/lib/autofillProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function bearerFrom(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: Request) {
  const token = bearerFrom(req);
  const tokenOk = await verifyAutofillToken(token);
  const cookieOk = !tokenOk && (await getSessionFromCookie());

  if (!tokenOk && !cookieOk) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  const profile = await readAutofillProfile();
  return NextResponse.json(profile, { headers: CORS_HEADERS });
}

export async function PUT(req: Request) {
  // Editing profile is settings-UI only (cookie auth). Bearer cannot mutate.
  if (!(await getSessionFromCookie())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const next: AutofillProfile = { ...EMPTY_PROFILE, ...body };
  await writeAutofillProfile(next);
  return NextResponse.json({ ok: true });
}
