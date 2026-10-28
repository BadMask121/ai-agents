import { describe, expect, it } from "vitest";
import { MAX_SHORTCUT_BYTES, SHORTCUT_INSTALL_DOWNLOADS, SHORTCUT_INSTALL_SECONDS } from "../src/constants";
import { SqlStore } from "../src/sqlstore";
import { agentHeaders, makeCloud, req, type Any, type Registered } from "./cloud";
import { FakeStorage } from "./do-harness";

// The one-scan iPhone install (connect-anywhere spec §2b): the Mac uploads its
// signed Shortcut, the cloud gives back a short-lived /i/<tenant>/<code> link,
// and the iPhone opens a page with one button to the file.

type Cloud = ReturnType<typeof makeCloud>;
const SIGNED = new Uint8Array([0x41, 0x45, 0x41, 0x31, 1, 2, 3, 4, 5, 6, 7, 8]); // "AEA1…"

const putInstall = (c: Cloud, t: Registered, id: string, body: Uint8Array = SIGNED, headers: Record<string, string> = {}) =>
  c.call(req("PUT", `/v2/agent/links/${id}/install`, body, { ...agentHeaders(t), "content-type": "application/octet-stream", ...headers }));
const open = (c: Cloud, path: string, method = "GET") => c.call(req(method, path));
const pathOf = (url: string) => new URL(url).pathname;
const fileOf = (url: string) => `${pathOf(url)}/DJ%20Sync.shortcut`;

async function setup() {
  const c = makeCloud();
  const t = await c.registered();
  const link = await c.link(t, "shortcut");
  return { c, t, link };
}

async function install(c: Cloud, t: Registered, id: string): Promise<{ install_url: string; expires_at: string }> {
  const res = await putInstall(c, t, id);
  expect(res.status).toBe(200);
  return res.json() as Promise<Any>;
}

describe("one-scan iPhone install (connect-anywhere spec §2b)", () => {
  it("turns the Mac's signed Shortcut into a 10-minute install link", async () => {
    const { c, t, link } = await setup();
    const res = await putInstall(c, t, link.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Any;
    expect(Object.keys(body).sort()).toEqual(["expires_at", "install_url"]);
    expect(body.install_url).toMatch(new RegExp(`^https://mcp\\.example\\.test/i/${t.tenant_id}/[A-Za-z0-9_-]{22}$`, "u"));
    expect(body.expires_at).toBe(new Date(c.now().getTime() + SHORTCUT_INSTALL_SECONDS * 1000).toISOString());
  });

  it("shows an iPhone page with one button to the file", async () => {
    const { c, t, link } = await setup();
    const { install_url } = await install(c, t, link.id);
    const res = await open(c, pathOf(install_url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toContain("<h1>Add DJ Sync to your iPhone</h1>");
    expect(html).toContain(`<a class="add" href="${fileOf(install_url)}">Add Shortcut</a>`);
    expect(html).not.toMatch(/<script|https?:\/\//u); // nothing loaded from elsewhere
  });

  it(`serves the file ${SHORTCUT_INSTALL_DOWNLOADS} times, then the link is used up`, async () => {
    const { c, t, link } = await setup();
    const { install_url } = await install(c, t, link.id);

    const head = await open(c, fileOf(install_url), "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(SIGNED.byteLength));
    for (let i = 0; i < SHORTCUT_INSTALL_DOWNLOADS; i++) {
      const res = await open(c, fileOf(install_url));
      expect(res.status, `download ${i + 1}`).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="DJ Sync.shortcut"');
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(SIGNED);
    }
    const spent = await open(c, fileOf(install_url));
    expect(spent.status).toBe(410);
    expect(await spent.text()).toContain("<h1>This link expired</h1>");
    const page = await open(c, pathOf(install_url));
    expect(page.status).toBe(410);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Make a new QR code in DJ Sync on your Mac");
  });

  it("expires after 10 minutes; a new upload replaces the old link", async () => {
    const { c, t, link } = await setup();
    const first = await install(c, t, link.id);
    const second = await install(c, t, link.id);
    expect(second.install_url).not.toBe(first.install_url);
    expect((await open(c, pathOf(first.install_url))).status).toBe(410);
    expect((await open(c, fileOf(first.install_url))).status).toBe(410);
    expect((await open(c, pathOf(second.install_url))).status).toBe(200);

    c.advance(SHORTCUT_INSTALL_SECONDS - 1);
    expect((await open(c, fileOf(second.install_url))).status).toBe(200);
    c.advance(1);
    expect((await open(c, pathOf(second.install_url))).status).toBe(410);
    expect((await open(c, fileOf(second.install_url))).status).toBe(410);
  });

  it("rotating or deleting the link kills its install (the file holds the old key)", async () => {
    const { c, t, link } = await setup();
    const a = await install(c, t, link.id);
    expect((await c.call(req("POST", `/v2/agent/links/${link.id}/rotate`, undefined, agentHeaders(t)))).status).toBe(200);
    expect((await open(c, pathOf(a.install_url))).status).toBe(410);

    const b = await install(c, t, link.id);
    expect((await c.call(req("DELETE", `/v2/agent/links/${link.id}`, undefined, agentHeaders(t)))).status).toBe(204);
    expect((await open(c, fileOf(b.install_url))).status).toBe(410);
  });

  it("only takes a signed Shortcut for the DJ's own shortcut link", async () => {
    const { c, t, link } = await setup();
    const chatgpt = await c.link(t, "chatgpt");
    expect((await putInstall(c, t, chatgpt.id)).status).toBe(409);
    expect(await (await putInstall(c, t, chatgpt.id)).json()).toMatchObject({ error: "not_a_shortcut_link" });
    expect((await putInstall(c, t, "nope")).status).toBe(404);
    expect((await putInstall(c, t, link.id, new Uint8Array())).status).toBe(400);
    expect((await putInstall(c, t, link.id, new Uint8Array(MAX_SHORTCUT_BYTES + 1))).status).toBe(413);
    expect((await putInstall(c, t, link.id, new Uint8Array(MAX_SHORTCUT_BYTES))).status).toBe(200);
    expect((await putInstall(c, t, link.id, SIGNED, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await c.call(req("POST", `/v2/agent/links/${link.id}/install`, SIGNED, agentHeaders(t)))).status).toBe(404);

    // Another DJ can't reach it.
    const other = await c.registered("198.51.100.9");
    expect((await putInstall(c, other, link.id)).status).toBe(404);
  });

  it("answers unknown, malformed and wrong-method install URLs with the friendly page", async () => {
    const { c, t, link } = await setup();
    const { install_url } = await install(c, t, link.id);
    const [, , tenant, code] = pathOf(install_url).split("/");
    expect((await open(c, `/i/${tenant}/${"x".repeat(22)}`)).status).toBe(410);
    expect((await open(c, `/i/${"A".repeat(22)}/${code}`)).status).toBe(410); // no such DJ
    for (const p of [`/i/${tenant}`, `/i/${tenant}/short`, `/i/${tenant}/${code}/`, "/i/"]) {
      const res = await open(c, p);
      expect(res.status, p).toBe(404);
      expect(await res.text()).toContain("This link expired");
    }
    expect((await open(c, pathOf(install_url), "POST")).status).toBe(405);
  });

  it("adds the install table to a tenant from an older Worker", () => {
    const storage = new FakeStorage();
    const db = { exec: storage.sql.exec.bind(storage.sql), transaction: <T>(fn: () => T) => storage.transactionSync(fn) } as Any;
    new SqlStore(db).init({});
    db.exec("DROP TABLE shortcut_installs");
    SqlStore.migrate(db);
    const store = new SqlStore(db);
    store.putInstall("l1", "h1", SIGNED.buffer.slice(0), "2026-10-28T12:10:00.000Z");
    expect(store.installLive("h1", "2026-10-28T12:00:00.000Z", 5)).toBe(true);
    expect(new Uint8Array(store.takeInstallDownload("h1", "2026-10-28T12:00:00.000Z", 5)!)).toEqual(SIGNED);
    expect(store.takeInstallDownload("h1", "2026-10-28T12:00:00.000Z", 1)).toBeNull();
  });
});
