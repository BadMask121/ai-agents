/**
 * Mailbox end to end against a scripted IMAP server: the real ImapClient,
 * protocol parser and structure handling, with Dovecot-shaped responses.
 */
import { describe, it, expect } from "vitest";
import { Mailbox, encodeId, decodeId } from "./mailbox.js";
import { ImapClient } from "./imap.js";
import type { Config } from "./config.js";
import { ENVELOPE, MIXED, literalFetch, login, logout, scripted, type Step } from "./imap/fake-server.js";

const cfg: Config = {
  imapHost: "mail.example.com",
  imapPort: 993,
  smtpHost: "mail.example.com",
  smtpPort: 587,
  user: "me@example.com",
  pass: "secret",
  secretPath: "s",
  maxBodyBytes: 100_000,
  maxAttachmentBytes: 5_000_000,
};

function mailbox(steps: Step[], overrides: Partial<Config> = {}) {
  const server = scripted([login, ...steps, logout]);
  const c = { ...cfg, ...overrides };
  return { mb: new Mailbox(c, { imap: new ImapClient(c, server.connect) }), server };
}

const examineInbox: Step = {
  expect: /^A\d+ EXAMINE "INBOX"\r\n$/,
  reply: "* 3 EXISTS\r\n* OK [UIDVALIDITY 1] Ok\r\n$TAG OK [READ-ONLY] Examine completed.\r\n",
};
const fetchMixed = (uid: number, flags = "\\Seen"): Step => ({
  expect: new RegExp(`^A\\d+ UID FETCH ${uid} \\(UID FLAGS ENVELOPE BODYSTRUCTURE\\)\\r\\n$`),
  reply: `* 1 FETCH (UID ${uid} FLAGS (${flags}) ENVELOPE ${ENVELOPE} BODYSTRUCTURE ${MIXED})\r\n$TAG OK Fetch completed.\r\n`,
});

describe("id helpers", () => {
  it("round-trips folder + uid, tolerating separators in folder names", () => {
    const id = encodeId("INBOX/Sub:Weird", 42);
    expect(decodeId(id)).toEqual({ folder: "INBOX/Sub:Weird", uid: 42 });
  });
  it("rejects malformed ids", () => {
    expect(() => decodeId("nope")).toThrow(/Malformed/);
  });
});

describe("listFolders", () => {
  it("lists folders with counts in one session, decoding names and skipping \\Noselect", async () => {
    const { mb, server } = mailbox([
      {
        expect: /^A\d+ LIST "" "\*"\r\n$/,
        reply:
          '* LIST (\\HasNoChildren) "/" INBOX\r\n' +
          '* LIST (\\HasNoChildren \\Trash) "/" Trash\r\n' +
          '* LIST (\\Noselect \\HasChildren) "/" Archive\r\n' +
          '* LIST (\\HasNoChildren) "/" "Archive/Entw&APw-rfe"\r\n' +
          "$TAG OK List completed.\r\n",
      },
      { expect: /STATUS "INBOX" \(MESSAGES UNSEEN\)/, reply: '* STATUS INBOX (MESSAGES 12 UNSEEN 3)\r\n$TAG OK\r\n' },
      { expect: /STATUS "Trash"/, reply: '* STATUS Trash (MESSAGES 4 UNSEEN 0)\r\n$TAG OK\r\n' },
      { expect: /STATUS "Archive\/Entw&APw-rfe"/, reply: '* STATUS "Archive/Entw&APw-rfe" (MESSAGES 1 UNSEEN 1)\r\n$TAG OK\r\n' },
    ]);
    const folders = await mb.listFolders();
    expect(folders).toEqual([
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", unseen: 3, total: 12 },
      { path: "Trash", name: "Trash", specialUse: "\\Trash", unseen: 0, total: 4 },
      { path: "Archive", name: "Archive", specialUse: undefined, unseen: 0, total: 0 },
      { path: "Archive/Entwürfe", name: "Entwürfe", specialUse: undefined, unseen: 1, total: 1 },
    ]);
    expect(server.remaining()).toBe(0);
  });
});

describe("search / listMessages", () => {
  it("searches with UTF-8 terms and returns newest first", async () => {
    const { mb, server } = mailbox([
      examineInbox,
      {
        expect: /^A\d+ UID SEARCH CHARSET UTF-8 SUBJECT \{5\+\}\r\nCafé SINCE 1-Jan-2024 UNSEEN\r\n$/,
        reply: "* SEARCH 5 9 7\r\n$TAG OK Search completed.\r\n",
      },
      {
        expect: /^A\d+ UID FETCH 7,9 \(UID FLAGS ENVELOPE BODYSTRUCTURE\)\r\n$/,
        reply:
          `* 2 FETCH (UID 7 FLAGS () ENVELOPE ${ENVELOPE} BODYSTRUCTURE ${MIXED})\r\n` +
          `* 3 FETCH (UID 9 FLAGS (\\Seen) ENVELOPE ${ENVELOPE} BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 3 1 NIL NIL NIL NIL))\r\n` +
          "$TAG OK Fetch completed.\r\n",
      },
    ]);
    const res = await mb.search("INBOX", { subject: "Café", since: new Date("2024-01-01T00:00:00Z"), unseen: true }, 2);
    expect(res.map((m) => [m.uid, m.unseen, m.hasAttachments])).toEqual([
      [9, false, false],
      [7, true, true],
    ]);
    expect(res[1]).toMatchObject({ id: "INBOX:7", subject: "Héllo there", from: "Alice <alice@example.com>", to: "bob@example.com" });
    expect(server.remaining()).toBe(0);
  });

  it("pages by sequence number from the newest", async () => {
    const { mb } = mailbox([
      examineInbox,
      {
        expect: /^A\d+ FETCH 2:3 \(UID FLAGS ENVELOPE BODYSTRUCTURE\)\r\n$/,
        reply: `* 2 FETCH (UID 20 FLAGS () ENVELOPE ${ENVELOPE} BODYSTRUCTURE ${MIXED})\r\n* 3 FETCH (UID 21 FLAGS () ENVELOPE ${ENVELOPE} BODYSTRUCTURE ${MIXED})\r\n$TAG OK\r\n`,
      },
    ]);
    expect((await mb.listMessages("INBOX", 2, 0)).map((m) => m.uid)).toEqual([21, 20]);
  });
});

describe("read", () => {
  it("fetches only the text part and decodes quoted-printable", async () => {
    const { mb, server } = mailbox([
      examineInbox,
      fetchMixed(7),
      { expect: /^A\d+ UID FETCH 7 \(UID BODY\.PEEK\[1\.1\]\)\r\n$/, reply: literalFetch(7, "1.1", "Caf=C3=A9 au lait=\r\n today.\r\n") },
    ]);
    const msg = await mb.read("INBOX", 7);
    expect(msg).toMatchObject({
      id: "INBOX:7",
      subject: "Héllo there",
      from: "Alice <alice@example.com>",
      to: "bob@example.com",
      cc: "Café <cafe@example.org>",
      date: "2024-01-01T10:00:00.000Z",
      messageId: "<orig@example.com>",
      body: "Café au lait today.\r\n",
      bodyTruncated: false,
      attachments: [{ index: 0, filename: "report.pdf", mimeType: "application/pdf", size: 20 }],
    });
    expect(server.remaining()).toBe(0);
  });

  it("converts an HTML-only body in its charset, and truncates to the byte budget", async () => {
    const html = new Uint8Array([...new TextEncoder().encode("<p>Gr"), 0xfc, 0xdf, ...new TextEncoder().encode("e &amp; <b>hi</b></p>")]);
    const b64 = btoa(String.fromCharCode(...html));
    const structure = `("TEXT" "HTML" ("CHARSET" "iso-8859-1") NIL NIL "BASE64" ${b64.length} 1 NIL NIL NIL NIL)`;
    const steps = (): Step[] => [
      examineInbox,
      { expect: /UID FETCH 8 \(UID FLAGS ENVELOPE BODYSTRUCTURE\)/, reply: `* 1 FETCH (UID 8 FLAGS () ENVELOPE ${ENVELOPE} BODYSTRUCTURE ${structure})\r\n$TAG OK\r\n` },
      { expect: /UID FETCH 8 \(UID BODY\.PEEK\[1\]\)/, reply: literalFetch(8, "1", b64) },
    ];
    expect((await mailbox(steps()).mb.read("INBOX", 8)).body).toBe("Grüße & hi");
    const short = await mailbox(steps(), { maxBodyBytes: 4 }).mb.read("INBOX", 8);
    expect(short).toMatchObject({ body: "Grü", bodyTruncated: true });
  });

  it("maps a missing folder to FOLDER_NOT_FOUND", async () => {
    const { mb } = mailbox([{ expect: /EXAMINE "Nope"/, reply: "$TAG NO [NONEXISTENT] Mailbox doesn't exist: Nope\r\n" }]);
    await expect(mb.read("Nope", 1)).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND" });
  });
});

describe("getAttachment", () => {
  it("returns a base64 part as-is, without decoding it", async () => {
    const { mb } = mailbox([
      examineInbox,
      fetchMixed(7),
      { expect: /UID FETCH 7 \(UID BODY\.PEEK\[2\]\)/, reply: literalFetch(7, "2", "JVBERi0x\r\nLjQKdGVzdA==\r\n") },
    ]);
    expect(await mb.getAttachment("INBOX", 7, 0)).toEqual({
      filename: "report.pdf",
      mimeType: "application/pdf",
      base64: "JVBERi0xLjQKdGVzdA==",
      size: 13,
    });
  });

  it("refuses attachments over the cap before downloading them", async () => {
    const { mb, server } = mailbox([examineInbox, fetchMixed(7)], { maxAttachmentBytes: 10 });
    await expect(mb.getAttachment("INBOX", 7, 0)).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    expect(server.sent.some((c) => c.includes("BODY.PEEK"))).toBe(false);
  });

  it("reports an index that isn't there", async () => {
    const { mb } = mailbox([examineInbox, fetchMixed(7)]);
    await expect(mb.getAttachment("INBOX", 7, 3)).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
  });
});

describe("move / remove / mark", () => {
  const selectInbox: Step = { expect: /^A\d+ SELECT "INBOX"\r\n$/, reply: "* 3 EXISTS\r\n$TAG OK [READ-WRITE] Select completed.\r\n" };
  const listTrash: Step = { expect: /LIST "" "\*"/, reply: '* LIST (\\HasNoChildren \\Trash) "/" "Deleted Items"\r\n$TAG OK\r\n' };

  it("moves with UID MOVE", async () => {
    const { mb, server } = mailbox([selectInbox, { expect: /^A\d+ UID MOVE 7 "Archive"\r\n$/, reply: "$TAG OK Move completed.\r\n" }]);
    await mb.move("INBOX", 7, "Archive");
    expect(server.remaining()).toBe(0);
  });

  it("deletes to the special-use Trash folder", async () => {
    const { mb, server } = mailbox([listTrash, selectInbox, { expect: /UID MOVE 7 "Deleted Items"/, reply: "$TAG OK\r\n" }]);
    await mb.remove("INBOX", 7, false);
    expect(server.remaining()).toBe(0);
  });

  it("permanently deletes just that UID", async () => {
    const { mb, server } = mailbox([
      listTrash,
      selectInbox,
      { expect: /UID STORE 7 \+FLAGS\.SILENT \(\\Deleted\)/, reply: "$TAG OK\r\n" },
      { expect: /^A\d+ UID EXPUNGE 7\r\n$/, reply: "* 2 EXPUNGE\r\n$TAG OK\r\n" },
    ]);
    await mb.remove("INBOX", 7, true);
    expect(server.remaining()).toBe(0);
  });

  it("sets and clears flags", async () => {
    const { mb, server } = mailbox([
      selectInbox,
      { expect: /UID STORE 7 \+FLAGS\.SILENT \(\\Seen\)/, reply: "$TAG OK\r\n" },
      { expect: /UID STORE 7 -FLAGS\.SILENT \(\\Flagged\)/, reply: "$TAG OK\r\n" },
    ]);
    await mb.mark("INBOX", 7, { seen: true, flagged: false });
    expect(server.remaining()).toBe(0);
  });
});

describe("connection errors", () => {
  it("reports a rejected login as IMAP_CONNECT", async () => {
    const server = scripted([{ expect: /LOGIN/, reply: "$TAG NO [AUTHENTICATIONFAILED] Authentication failed.\r\n" }]);
    const mb = new Mailbox(cfg, { imap: new ImapClient(cfg, server.connect) });
    await expect(mb.listFolders()).rejects.toMatchObject({ code: "IMAP_CONNECT" });
  });
});
