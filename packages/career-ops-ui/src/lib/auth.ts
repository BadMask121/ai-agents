import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

const COOKIE_NAME = "career_ops_session";
const ALG = "HS256";

// TEMPORARY: lets the app run over plain HTTP (e.g. Coolify's auto-generated
// sslip.io URL) by dropping the Secure flag from the session cookie. ONLY for
// use until a real domain + Let's Encrypt cert is set up. Tracked by bd
// ai-agents-0xv. See instrumentation.ts for the boot-time warning and
// components/InsecureCookieBanner.tsx for the in-UI banner.
export function insecureCookiesEnabled(): boolean {
  return process.env.ALLOW_INSECURE_COOKIES === "1";
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET must be set to a string of at least 32 characters",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function verifyPassword(input: string): Promise<boolean> {
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (!hash) {
    throw new Error("AUTH_PASSWORD_HASH is not set");
  }
  return bcrypt.compare(input, hash);
}

export async function createSession(): Promise<string> {
  return new SignJWT({ sub: "user" })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  const isProd = process.env.NODE_ENV === "production";
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd && !insecureCookiesEnabled(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getSessionFromCookie(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    await jwtVerify(token, getSecret(), { algorithms: [ALG] });
    return true;
  } catch {
    return false;
  }
}

export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, getSecret(), { algorithms: [ALG] });
    return true;
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
