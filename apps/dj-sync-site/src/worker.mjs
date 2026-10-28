// djsync.jeffrey.build — one host for all of DJ Sync:
//   - the website (static files in ../public),
//   - /download/<file> from the R2 bucket (DMG, update zip, signed feed and
//     tools manifest; uploaded by apps/dj-sync/release.sh under djsync/),
//   - the cloud endpoints (MCP connector URLs, the Mac's agent socket and
//     REST, the Shortcut API, the Telegram bot's webhook), passed to the
//     dj-sync-cloud Worker over a service binding.
// Any other hostname routed here (djsync.triplejmusic.art) gets a 301 to the
// same path on the canonical host.

export const CANONICAL_HOST = "djsync.jeffrey.build";

const CLOUD_EXACT = new Set(["/health", "/api/downloads", "/api/playlists"]);
const CLOUD_PREFIXES = ["/v2/", "/api/downloads/", "/agent/", "/telegram/"];
const DOWNLOAD = /^\/download\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export function isCloudPath(path) {
  return CLOUD_EXACT.has(path) || CLOUD_PREFIXES.some((p) => path.startsWith(p)) || path.endsWith("/mcp");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL_HOST) {
      url.protocol = "https:";
      url.hostname = CANONICAL_HOST;
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    if (isCloudPath(url.pathname)) return env.CLOUD.fetch(request);
    const file = DOWNLOAD.exec(url.pathname);
    if (file) return download(request, env, file[1]);
    return env.ASSETS.fetch(request);
  },
};

async function download(request, env, name) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const key = `djsync/${name}`;
  const ranged = request.method === "GET" && request.headers.has("range");
  const object =
    request.method === "HEAD"
      ? await env.DOWNLOADS.head(key)
      : await env.DOWNLOADS.get(key, ranged ? { range: request.headers } : undefined);
  if (!object) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (/\.(dmg|zip)$/.test(name)) headers.set("content-disposition", `attachment; filename="${name}"`);

  if (request.method === "HEAD") {
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }
  // Only answer 206 when the client asked for a range (R2 may report one anyway).
  if (ranged && object.range) {
    const { offset = 0, length = object.size - offset } = object.range;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}
