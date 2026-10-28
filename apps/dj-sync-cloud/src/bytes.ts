// Random ids and secrets, hashing, and gzip — protocol 2 tenants (spec §3.2).

/** base64url, no padding. */
export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** 128 random bits → 22 chars. Not secret on its own. */
export const newTenantId = () => randomBase64url(16);
/** 256 random bits, prefixed so it's recognisable in a config file. */
export const newAgentToken = () => `djsa_${randomBase64url(32)}`;
/** 256 random bits → 43 chars; the credential in a link URL. */
export const newLinkSecret = () => randomBase64url(32);

export const TENANT_ID = /^[A-Za-z0-9_-]{22}$/;
export const LINK_SECRET = /^[A-Za-z0-9_-]{43}$/;
export const AGENT_TOKEN = /^djsa_[A-Za-z0-9_-]{43}$/;

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Gunzip, refusing output past `maxBytes` (`null`) instead of buffering a bomb. */
export async function gunzip(data: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** "2026-10-28" (UTC) — the granularity of daily limits and last-seen. */
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
