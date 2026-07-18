import { describe, it, expect, vi } from "vitest";
import { Mailbox, encodeId, decodeId } from "./mailbox.js";
import type { ImapClient } from "./imap.js";
import type { SmtpClient, OutgoingMessage } from "./smtp.js";
import type { Config } from "./config.js";

const cfg: Config = {
  imapHost: "mail.privateemail.com",
  imapPort: 993,
  smtpHost: "mail.privateemail.com",
  smtpPort: 465,
  user: "me@example.com",
  pass: "secret",
  secretPath: "s",
  port: 8080,
  maxBodyBytes: 100_000,
  maxAttachmentBytes: 5_000_000,
};

const RAW = [
  "From: Alice <alice@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Hello there",
  "Message-ID: <orig@example.com>",
  "Date: Mon, 01 Jan 2024 10:00:00 +0000",
  'Content-Type: multipart/mixed; boundary="B"',
  "",
  "--B",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello world body.",
  "--B",
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  "",
  "attachment contents",
  "--B--",
  "",
].join("\r\n");

describe("id helpers", () => {
  it("round-trips folder + uid, tolerating separators in folder names", () => {
    const id = encodeId("INBOX/Sub:Weird", 42);
    expect(decodeId(id)).toEqual({ folder: "INBOX/Sub:Weird", uid: 42 });
  });
  it("rejects malformed ids", () => {
    expect(() => decodeId("nope")).toThrow(/Malformed/);
  });
});

describe("Mailbox.read / getAttachment", () => {
  const fakeImap = { fetchSource: vi.fn(async () => Buffer.from(RAW)) } as unknown as ImapClient;
  const mailbox = new Mailbox(cfg, { imap: fakeImap });

  it("parses headers, body and attachment manifest", async () => {
    const msg = await mailbox.read("INBOX", 1);
    expect(msg.subject).toBe("Hello there");
    expect(msg.from).toContain("alice@example.com");
    expect(msg.to).toContain("bob@example.com");
    expect(msg.body).toContain("Hello world body.");
    expect(msg.bodyTruncated).toBe(false);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe("note.txt");
    expect(msg.id).toBe(encodeId("INBOX", 1));
  });

  it("returns attachment bytes as base64", async () => {
    const att = await mailbox.getAttachment("INBOX", 1, 0);
    expect(att.filename).toBe("note.txt");
    expect(Buffer.from(att.base64, "base64").toString("utf8")).toBe("attachment contents");
  });

  it("errors on a missing attachment index", async () => {
    await expect(mailbox.getAttachment("INBOX", 1, 5)).rejects.toThrow(/No attachment at index/);
  });

  it("truncates oversized bodies", async () => {
    const tiny = new Mailbox({ ...cfg, maxBodyBytes: 5 }, { imap: fakeImap });
    const msg = await tiny.read("INBOX", 1);
    expect(msg.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(msg.body)).toBeLessThanOrEqual(5);
  });
});

describe("Mailbox.send threading", () => {
  it("derives Re: subject and In-Reply-To from the replied-to message", async () => {
    const sent: OutgoingMessage[] = [];
    const fakeImap = {
      envelopeFor: vi.fn(async () => ({ messageId: "<orig@example.com>", subject: "Hi" })),
    } as unknown as ImapClient;
    const fakeSmtp = {
      send: vi.fn(async (m: OutgoingMessage) => {
        sent.push(m);
        return { messageId: "<new@example.com>" };
      }),
    } as unknown as SmtpClient;
    const mailbox = new Mailbox(cfg, { imap: fakeImap, smtp: fakeSmtp });

    const res = await mailbox.send(
      { to: ["alice@example.com"], subject: "", body: "reply text" },
      encodeId("INBOX", 5),
    );

    expect(res.messageId).toBe("<new@example.com>");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("Re: Hi");
    expect(sent[0]?.inReplyTo).toBe("<orig@example.com>");
  });
});
