import { describe, it, expect } from "vitest";
import {
  argument,
  base64ToBytes,
  bytesToBase64,
  decodeCharset,
  decodeEncodedWords,
  decodeMailboxName,
  decodeQuotedPrintable,
  decodeRfc2231,
  decodeTransfer,
  encodeMailboxName,
} from "./codec.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("mailbox names (modified UTF-7)", () => {
  it("round-trips non-ASCII names and escapes &", () => {
    expect(encodeMailboxName("Entwürfe")).toBe("Entw&APw-rfe");
    expect(decodeMailboxName("Entw&APw-rfe")).toBe("Entwürfe");
    expect(encodeMailboxName("A & B")).toBe("A &- B");
    expect(decodeMailboxName("A &- B")).toBe("A & B");
    for (const name of ["INBOX", "日本語", "Ünïcødé/Sub", "emoji 📬"]) {
      expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
    }
  });
});

describe("headers", () => {
  it("decodes B and Q encoded words, joining adjacent ones", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SMOpbGxv?= there")).toBe("Héllo there");
    expect(decodeEncodedWords("=?iso-8859-1?Q?Gr=FC=DFe_aus_Berlin?=")).toBe("Grüße aus Berlin");
    expect(decodeEncodedWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?=")).toBe("ab");
    expect(decodeEncodedWords("plain subject")).toBe("plain subject");
  });

  it("decodes RFC 2231 filenames", () => {
    expect(decodeRfc2231("utf-8''na%C3%AFve%20plan.pdf")).toBe("naïve plan.pdf");
  });
});

describe("bodies", () => {
  it("decodes quoted-printable including soft breaks", () => {
    expect(dec.decode(decodeQuotedPrintable(enc.encode("Caf=C3=A9 au lait=\r\n today.")))).toBe("Café au lait today.");
  });

  it("round-trips base64 and ignores line breaks", () => {
    const bytes = enc.encode("%PDF-1.4\ntest");
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe("JVBERi0xLjQKdGVzdA==");
    expect(dec.decode(base64ToBytes("JVBERi0x\r\nLjQKdGVzdA=="))).toBe("%PDF-1.4\ntest");
    expect(dec.decode(decodeTransfer(enc.encode("SGk=\r\n"), "BASE64"))).toBe("Hi");
    expect(decodeTransfer(enc.encode("as-is"), "7bit")).toEqual(enc.encode("as-is"));
  });

  it("decodes charsets with a fallback for unknown labels", () => {
    expect(decodeCharset(new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]), "ISO-8859-1")).toBe("Grüße");
    expect(decodeCharset(enc.encode("ok"), "x-made-up")).toBe("ok");
  });
});

describe("command arguments", () => {
  it("quotes ASCII and escapes quotes/backslashes", () => {
    expect(argument('pa"ss\\word')).toBe('"pa\\"ss\\\\word"');
  });
  it("sends non-ASCII as a LITERAL+ literal of UTF-8 bytes", () => {
    const arg = argument("Café");
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(dec.decode(arg as Uint8Array)).toBe("{5+}\r\nCafé");
  });
});
