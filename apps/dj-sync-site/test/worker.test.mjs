// node --test apps/dj-sync-site/test/*.test.mjs  (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { isCloudPath } from "../src/worker.mjs";

const bytes = new TextEncoder().encode("0123456789");
function env() {
  const calls = { cloud: [], assets: [] };
  const obj = (range) => ({
    size: bytes.length,
    httpEtag: '"e1"',
    range,
    body: range ? bytes.slice(range.offset, range.offset + range.length) : bytes,
    writeHttpMetadata: (h) => h.set("content-type", "application/x-apple-diskimage"),
  });
  return {
    calls,
    CLOUD: { fetch: async (r) => (calls.cloud.push(new URL(r.url).pathname), new Response("cloud")) },
    ASSETS: { fetch: async (r) => (calls.assets.push(new URL(r.url).pathname), new Response("asset")) },
    DOWNLOADS: {
      head: async (k) => (k === "djsync/DJ-Sync-latest.dmg" ? obj() : null),
      get: async (k, o) => {
        if (k !== "djsync/DJ-Sync-latest.dmg") return null;
        if (!o) return obj();
        const m = /bytes=(\d+)-(\d+)/.exec(o.range.get("range"));
        return obj({ offset: +m[1], length: +m[2] - +m[1] + 1 });
      },
    },
  };
}
const req = (url, init) => new Request(url, init);

test("other hostnames get a 301 to the same path on djsync.jeffrey.build", async () => {
  const r = await worker.fetch(req("https://djsync.triplejmusic.art/install/?x=1"), env());
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://djsync.jeffrey.build/install/?x=1");
});

test("cloud paths go to dj-sync-cloud, pages to the static files", async () => {
  const e = env();
  for (const p of ["/health", "/v2/register", "/v2/agent", "/api/downloads", "/api/downloads/abc", "/agent/poll",
    "/u2dDy37bIx227JDdDMLBoA/secret/mcp", "/0123456789abcdef0123456789abcdef/mcp"]) {
    assert.equal(await (await worker.fetch(req(`https://djsync.jeffrey.build${p}`, { method: "POST" }), e)).text(), "cloud", p);
  }
  for (const p of ["/", "/install/", "/assets/site.css", "/mcp-guide/", "/apis"]) {
    assert.equal(await (await worker.fetch(req(`https://djsync.jeffrey.build${p}`), e)).text(), "asset", p);
  }
  assert.equal(isCloudPath("/connect/chatgpt/"), false);
});

test("downloads come from R2, with HEAD and byte ranges", async () => {
  const e = env();
  const full = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg"), e);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-disposition"), 'attachment; filename="DJ-Sync-latest.dmg"');
  assert.equal(full.headers.get("content-length"), "10");
  assert.equal(await full.text(), "0123456789");

  const part = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg", { headers: { range: "bytes=2-5" } }), e);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await part.text(), "2345");

  const head = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg", { method: "HEAD" }), e);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");

  assert.equal((await worker.fetch(req("https://djsync.jeffrey.build/download/nope.dmg"), e)).status, 404);
  assert.equal((await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg", { method: "POST" }), e)).status, 405);
  // Traversal and nested keys never reach R2 (falls through to the 404 page).
  assert.equal(await (await worker.fetch(req("https://djsync.jeffrey.build/download/../secret"), e)).text(), "asset");
  assert.equal(await (await worker.fetch(req("https://djsync.jeffrey.build/download/a/b.dmg"), e)).text(), "asset");
});
