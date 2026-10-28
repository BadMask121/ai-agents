// node --test apps/dj-sync-site/test/*.test.mjs  (no dependencies)
import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { IPHONE_GUIDE, isCloudPath } from "../src/worker.mjs";

const bytes = new TextEncoder().encode("0123456789");
const FILES = new Set(["djsync/DJ-Sync-1.2.1.dmg", "djsync/DJ-Sync-latest.dmg"]);
function env({ feed = '{"latest": {"version": "1.2.1"}}' } = {}) {
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
      head: async (k) => (FILES.has(k) ? obj() : null),
      get: async (k, o) => {
        if (k === "djsync/appcast.json") return feed === null ? null : { json: async () => JSON.parse(feed) };
        if (!FILES.has(k)) return null;
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
    "/api/playlists", "/telegram/webhook", "/v2/admin/telegram/setup",
    "/i/u2dDy37bIx227JDdDMLBoA/abcdefghijklmnopqrstuv", "/i/u2dDy37bIx227JDdDMLBoA/abcdefghijklmnopqrstuv/DJ%20Sync.shortcut",
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
  const full = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-1.2.1.dmg"), e);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-disposition"), 'attachment; filename="DJ-Sync-1.2.1.dmg"');
  assert.equal(full.headers.get("content-length"), "10");
  assert.equal(await full.text(), "0123456789");

  const part = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-1.2.1.dmg", { headers: { range: "bytes=2-5" } }), e);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await part.text(), "2345");

  const head = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-1.2.1.dmg", { method: "HEAD" }), e);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");

  assert.equal((await worker.fetch(req("https://djsync.jeffrey.build/download/nope.dmg"), e)).status, 404);
  assert.equal((await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg", { method: "POST" }), e)).status, 405);
  // Traversal and nested keys never reach R2 (falls through to the 404 page).
  assert.equal(await (await worker.fetch(req("https://djsync.jeffrey.build/download/../secret"), e)).text(), "asset");
  assert.equal(await (await worker.fetch(req("https://djsync.jeffrey.build/download/a/b.dmg"), e)).text(), "asset");
});

test("DJ-Sync-latest.dmg redirects to the released version's file", async () => {
  for (const method of ["GET", "HEAD"]) {
    const r = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg", { method }), env());
    assert.equal(r.status, 302, method);
    assert.equal(r.headers.get("location"), "https://djsync.jeffrey.build/download/DJ-Sync-1.2.1.dmg");
  }
  // No readable feed: the old copy is served as before.
  for (const feed of [null, "not json", '{"latest": {"version": "../x"}}']) {
    const r = await worker.fetch(req("https://djsync.jeffrey.build/download/DJ-Sync-latest.dmg"), env({ feed }));
    assert.equal(r.status, 200, String(feed));
    assert.equal(r.headers.get("content-disposition"), 'attachment; filename="DJ-Sync-latest.dmg"');
  }
});

test("a browser opening the Shortcut API gets the iPhone guide; API clients don't", async () => {
  const e = env();
  const html = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  for (const p of ["/api/downloads", "/api/playlists"]) {
    const r = await worker.fetch(req(`https://djsync.jeffrey.build${p}`, { headers: html }), e);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get("location"), IPHONE_GUIDE);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(e.calls.cloud, []);
  // The Shortcut (Bearer), plain API calls, POSTs and job status still reach the cloud.
  const api = [
    ["/api/playlists", { headers: { ...html, authorization: "Bearer k" } }],
    ["/api/playlists", { headers: { accept: "application/json" } }],
    ["/api/playlists", {}],
    ["/api/downloads", { method: "POST", headers: html, body: "{}" }],
    ["/api/downloads/abc", { headers: html }],
  ];
  for (const [p, init] of api) {
    assert.equal(await (await worker.fetch(req(`https://djsync.jeffrey.build${p}`, init), e)).text(), "cloud", p);
  }
  assert.equal(e.calls.cloud.length, api.length);
});
