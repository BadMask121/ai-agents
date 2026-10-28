import { describe, it, expect } from "vitest";
import { parseResponse } from "./protocol.js";
import { attachments, parseBodyStructure, parseEnvelope, textPart } from "./structure.js";
import { ENVELOPE, MIXED } from "./fake-server.js";

const enc = new TextEncoder();

/** Parse "(…)" as Dovecot sends it inside a FETCH. */
const value = (s: string) => parseResponse(enc.encode(`* X ${s}\r\n`)).values[1];

describe("parseEnvelope", () => {
  it("decodes subject and names and normalises the date", () => {
    const e = parseEnvelope(value(ENVELOPE));
    expect(e.subject).toBe("Héllo there");
    expect(e.from).toEqual([{ name: "Alice", address: "alice@example.com" }]);
    expect(e.to).toEqual([{ name: undefined, address: "bob@example.com" }]);
    expect(e.cc).toEqual([{ name: "Café", address: "cafe@example.org" }]);
    expect(e.date).toBe("2024-01-01T10:00:00.000Z");
    expect(e.messageId).toBe("<orig@example.com>");
  });
});

describe("parseBodyStructure", () => {
  it("numbers nested parts and finds body text and attachments", () => {
    const root = parseBodyStructure(value(MIXED));
    expect(root.type).toBe("multipart/mixed");
    expect(root.parts!.map((p) => p.section)).toEqual(["1", "2"]);
    expect(root.parts![0]!.parts!.map((p) => `${p.section} ${p.type}`)).toEqual(["1.1 text/plain", "1.2 text/html"]);
    expect(textPart(root)).toMatchObject({ section: "1.1", encoding: "quoted-printable", params: { charset: "utf-8" } });
    expect(attachments(root)).toEqual([
      expect.objectContaining({ section: "2", type: "application/pdf", filename: "report.pdf", size: 20, encoding: "base64" }),
    ]);
  });

  it("treats a single-part message as section 1 and falls back to HTML", () => {
    const root = parseBodyStructure(value('("TEXT" "HTML" ("CHARSET" "iso-8859-1") NIL NIL "BASE64" 40 1 NIL NIL NIL NIL)'));
    expect(root.section).toBe("1");
    expect(textPart(root)?.type).toBe("text/html");
    expect(attachments(root)).toEqual([]);
  });

  it("reads RFC 2231 filenames and counts a named text part as an attachment", () => {
    const root = parseBodyStructure(
      value(
        '(("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)' +
          '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "BASE64" 8 1 NIL ("ATTACHMENT" ("FILENAME*" "utf-8\'\'na%C3%AFve.txt")) NIL NIL) "MIXED" NIL NIL NIL NIL)',
      ),
    );
    expect(textPart(root)?.section).toBe("1");
    expect(attachments(root).map((p) => p.filename)).toEqual(["naïve.txt"]);
  });
});
