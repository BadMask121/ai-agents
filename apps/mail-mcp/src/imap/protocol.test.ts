import { describe, it, expect } from "vitest";
import { ResponseReader, asText, parseResponse, type ByteSource } from "./protocol.js";

const enc = new TextEncoder();

function source(chunks: string[]): ByteSource {
  const queue = chunks.map((c) => enc.encode(c));
  return { read: async () => (queue.length ? { value: queue.shift()!, done: false } : { done: true }) };
}

describe("ResponseReader", () => {
  it("joins a response split across chunks and keeps literal bytes (CRLF inside)", async () => {
    const r = new ResponseReader(
      source(["* 1 FETCH (UID 7 BODY[1] {9}\r", "\nab\r\ncd\r\ne", ")\r\nA1 OK done\r\n"]),
    );
    const first = parseResponse(await r.next());
    expect(first.values[1]).toBe("FETCH");
    const items = first.values[2] as unknown[];
    expect(items[2]).toBe("BODY[1]");
    expect(new TextDecoder().decode(items[3] as Uint8Array)).toBe("ab\r\ncd\r\ne");
    const second = parseResponse(await r.next());
    expect(second).toMatchObject({ tag: "A1", status: "OK", text: "done" });
  });

  it("fails cleanly when the connection closes mid-response", async () => {
    const r = new ResponseReader(source(["* OK partial"]));
    await expect(r.next()).rejects.toThrow(/closed/);
  });
});

describe("parseResponse", () => {
  it("separates status responses from data", () => {
    expect(parseResponse(enc.encode("* OK [UIDVALIDITY 5] UIDs valid\r\n"))).toMatchObject({
      tag: "*",
      status: "OK",
      text: "[UIDVALIDITY 5] UIDs valid",
    });
    expect(parseResponse(enc.encode("A3 NO [TRYCREATE] Mailbox doesn't exist: Nope\r\n")).status).toBe("NO");
    expect(parseResponse(enc.encode("+ go ahead\r\n"))).toMatchObject({ tag: "+", text: "go ahead" });
  });

  it("parses quoted strings with escapes, NIL and nested lists", () => {
    const r = parseResponse(enc.encode('* LIST (\\HasNoChildren \\Trash) "/" "Old \\"stuff\\""\r\n'));
    expect(r.values).toEqual(["LIST", ["\\HasNoChildren", "\\Trash"], "/", 'Old "stuff"']);
    const n = parseResponse(enc.encode("* 2 FETCH (UID 9 ENVELOPE (NIL \"Hi\" NIL))\r\n"));
    expect(n.values).toEqual(["2", "FETCH", ["UID", "9", "ENVELOPE", [null, "Hi", null]]]);
  });

  it("decodes UTF-8 in quoted strings", () => {
    const r = parseResponse(enc.encode('* SEARCH\r\n'));
    expect(r.values).toEqual(["SEARCH"]);
    expect(asText(parseResponse(enc.encode('* X "Café"\r\n')).values[1])).toBe("Café");
  });
});
