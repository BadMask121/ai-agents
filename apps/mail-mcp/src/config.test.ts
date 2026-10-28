import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  PRIVATEEMAIL_USER: "me@example.com",
  PRIVATEEMAIL_PASS: "secret",
  MCP_SECRET_PATH: "/abc123/",
};

describe("loadConfig", () => {
  it("applies privateemail defaults and strips slashes from the secret path", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.imapHost).toBe("mail.privateemail.com");
    expect(cfg.imapPort).toBe(993);
    expect(cfg.smtpHost).toBe("mail.privateemail.com");
    expect(cfg.smtpPort).toBe(587);
    expect(cfg.secretPath).toBe("abc123");
    expect(cfg.maxBodyBytes).toBe(100_000);
    expect(cfg.maxAttachmentBytes).toBe(5_000_000);
  });

  it("throws when a required var is missing", () => {
    expect(() => loadConfig({ PRIVATEEMAIL_USER: "x" })).toThrow(/PRIVATEEMAIL_PASS/);
  });

  it("respects overrides", () => {
    const cfg = loadConfig({ ...base, IMAP_HOST: "imap.other.com", SMTP_PORT: "2525" });
    expect(cfg.imapHost).toBe("imap.other.com");
    expect(cfg.smtpPort).toBe(2525);
  });

  it("rejects non-integer ports", () => {
    expect(() => loadConfig({ ...base, IMAP_PORT: "abc" })).toThrow(/integer/);
  });
});
