import { describe, it, expect } from "vitest";
import { SmtpClient } from "./smtp.js";
import type { Config } from "./config.js";

function cfgWithPort(smtpPort: number): Config {
  return {
    imapHost: "mail.example.com",
    imapPort: 993,
    smtpHost: "mail.example.com",
    smtpPort,
    user: "me@example.com",
    pass: "secret",
    secretPath: "abc123",
    maxBodyBytes: 100_000,
    maxAttachmentBytes: 5_000_000,
  };
}

function transportOptions(client: SmtpClient): Record<string, unknown> {
  return (client as unknown as { transport: { options: Record<string, unknown> } })
    .transport.options;
}

describe("SmtpClient transport", () => {
  it("uses STARTTLS (secure=false, requireTLS) on port 587", () => {
    const opts = transportOptions(new SmtpClient(cfgWithPort(587)));
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
  });

  it("uses implicit TLS on port 465", () => {
    const opts = transportOptions(new SmtpClient(cfgWithPort(465)));
    expect(opts.secure).toBe(true);
  });

  it("sets fail-fast timeouts well below the reverse proxy's limit", () => {
    const opts = transportOptions(new SmtpClient(cfgWithPort(587)));
    expect(opts.connectionTimeout).toBe(15_000);
    expect(opts.greetingTimeout).toBe(10_000);
    expect(opts.socketTimeout).toBe(30_000);
  });
});
