// djsync.jeffrey.build — one host for all of DJ Sync:
//   - the website (static files in ../public),
//   - /download/<file> from the R2 bucket (DMG, update zip, signed feed and
//     tools manifest; uploaded by apps/dj-sync/release.sh under djsync/),
//   - the cloud endpoints (MCP connector URLs, the Mac's agent socket and
//     REST, the Shortcut API, the Telegram bot's webhook, the one-scan iPhone
//     install pages under /i/), passed to the dj-sync-cloud Worker over a
//     service binding.
// Any other hostname routed here (djsync.triplejmusic.art) gets a 301 to the
// same path on the canonical host. Someone opening the Shortcut API in a
// browser (/api/downloads, /api/playlists) gets the iPhone setup guide instead
// of a JSON 401.

export const CANONICAL_HOST = "djsync.jeffrey.build";

const CLOUD_EXACT = new Set(["/health", "/api/downloads", "/api/playlists"]);
const CLOUD_PREFIXES = ["/v2/", "/api/downloads/", "/agent/", "/telegram/", "/i/"];
const DOWNLOAD = /^\/download\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
// Kept in R2 for apps that fetch it from the old downloads host directly; here
// it redirects to the released version's file.
const LATEST_DMG = "DJ-Sync-latest.dmg";
const SHORTCUT_API = new Set(["/api/downloads", "/api/playlists"]);
export const IPHONE_GUIDE = "/connect/iphone/";

export function isCloudPath(path) {
  return CLOUD_EXACT.has(path) || CLOUD_PREFIXES.some((p) => path.startsWith(p)) || path.endsWith("/mcp");
}

/** A person's browser, not the Shortcut or another API client. */
export function isBrowserVisit(request) {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    !request.headers.has("authorization") &&
    (request.headers.get("accept") ?? "").includes("text/html")
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL_HOST) {
      url.protocol = "https:";
      url.hostname = CANONICAL_HOST;
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    if (SHORTCUT_API.has(url.pathname) && isBrowserVisit(request)) {
      return new Response(null, { status: 302, headers: { location: IPHONE_GUIDE, "cache-control": "no-store" } });
    }
    if (isCloudPath(url.pathname)) return env.CLOUD.fetch(request);
    const file = DOWNLOAD.exec(url.pathname);
    if (file) return download(request, env, file[1], ctx);
    return env.ASSETS.fetch(request);
  },
};

async function download(request, env, name, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  // Old links and the app's "latest" link save the DMG under its version too.
  if (name === LATEST_DMG) {
    const version = await releasedVersion(env);
    if (version) {
      const location = `https://${CANONICAL_HOST}/download/DJ-Sync-${version}.dmg`;
      return new Response(null, { status: 302, headers: { location, "cache-control": "public, max-age=300" } });
    }
  }
  const key = `djsync/${name}`;
  const ranged = request.method === "GET" && request.headers.has("range");
  let object;
  try {
    object =
      request.method === "HEAD"
        ? await env.DOWNLOADS.head(key)
        : await env.DOWNLOADS.get(key, ranged ? { range: request.headers } : undefined);
  } catch {
    countFailure(env, name, "error", ctx);
    return new Response("Download failed, please try again\n", { status: 502, headers: { "content-type": "text/plain" } });
  }
  if (!object) {
    countFailure(env, name, "missing", ctx);
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  }

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
  countDownload(env, name, ranged, ctx);
  return new Response(object.body, { headers });
}

/**
 * Count a started DMG (first install) or zip (the app updating itself):
 * what and which version, nothing about who. A log line always; a data point
 * only when the optional DOWNLOAD_STATS Analytics Engine binding exists.
 */
export function countDownload(env, name, ranged = false, ctx) {
  const m = /^DJ-Sync-(\d+\.\d+\.\d+)\.(dmg|zip)$/.exec(name);
  if (!m || ranged) return;
  const [, version, ext] = m;
  const kind = ext === "dmg" ? "install" : "update";
  console.log(JSON.stringify({ event: "download", kind, version }));
  try {
    env.DOWNLOAD_STATS?.writeDataPoint({ indexes: [kind], blobs: [kind, version], doubles: [1] });
  } catch {
    /* counting never breaks a download */
  }
  if (ctx && env.DOWNLOADS) ctx.waitUntil(bumpStats(env.DOWNLOADS, `${kind}:${version}`).catch(() => {}));
}

/**
 * A download that didn't happen: the file is missing (404) or R2 failed (502).
 * Only DMG/zip names count, bucketed by version ("other" for anything else),
 * so scanners can't fill the counts with made-up names.
 */
export function countFailure(env, name, reason, ctx) {
  const m = /^DJ-Sync-(\d+\.\d+\.\d+|latest)\.(dmg|zip)$/.exec(name);
  const version = m ? m[1] : "other";
  console.log(JSON.stringify({ event: "download_failed", reason, version }));
  try {
    env.DOWNLOAD_STATS?.writeDataPoint({ indexes: ["failed"], blobs: ["failed", reason, version], doubles: [1] });
  } catch {
    /* counting never breaks a download */
  }
  if (ctx && env.DOWNLOADS) ctx.waitUntil(bumpStats(env.DOWNLOADS, `failed-${reason}:${version}`).catch(() => {}));
}

const STATS_KEY = "djsync/stats/downloads.json";
const STATS_DAYS = 120;

/** One more download in today's bucket of the owner's counts in R2 (a few retries if two land at once). */
export async function bumpStats(bucket, key, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await bucket.get(STATS_KEY);
    const stats = current ? await current.json() : { days: {} };
    stats.days ??= {};
    stats.days[day] ??= {};
    stats.days[day][key] = (stats.days[day][key] ?? 0) + 1;
    for (const d of Object.keys(stats.days).sort().slice(0, -STATS_DAYS)) delete stats.days[d];
    const put = await bucket.put(STATS_KEY, JSON.stringify(stats), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: current ? { etagMatches: current.httpEtag } : { etagDoesNotMatch: "*" },
    });
    if (put) return;
  }
}

/** The released version, from the update feed (null if it can't be read:
 *  DJ-Sync-latest.dmg is then served as is). */
async function releasedVersion(env) {
  try {
    const feed = await env.DOWNLOADS.get("djsync/appcast.json");
    const version = feed && (await feed.json())?.latest?.version;
    return /^\d+\.\d+\.\d+$/.test(version ?? "") ? version : null;
  } catch {
    return null;
  }
}
