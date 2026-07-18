/**
 * Environment-derived configuration. Loaded once at startup; fails fast when a
 * required secret is missing so the process never boots half-configured.
 */

export interface Config {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  pass: string;
  /** URL segment the MCP endpoint is mounted under: /<secretPath>/mcp */
  secretPath: string;
  port: number;
  /** Text bodies longer than this (bytes) are truncated before returning. */
  maxBodyBytes: number;
  /** get_attachment refuses to return payloads larger than this (bytes). */
  maxAttachmentBytes: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prev = process.env;
  process.env = env; // let required()/intEnv() read the provided env
  try {
    return {
      imapHost: env.IMAP_HOST?.trim() || "mail.privateemail.com",
      imapPort: intEnv("IMAP_PORT", 993),
      smtpHost: env.SMTP_HOST?.trim() || "mail.privateemail.com",
      smtpPort: intEnv("SMTP_PORT", 465),
      user: required("PRIVATEEMAIL_USER"),
      pass: required("PRIVATEEMAIL_PASS"),
      secretPath: required("MCP_SECRET_PATH").replace(/^\/+|\/+$/g, ""),
      port: intEnv("PORT", 8080),
      maxBodyBytes: intEnv("MAX_BODY_BYTES", 100_000),
      maxAttachmentBytes: intEnv("MAX_ATTACHMENT_BYTES", 5_000_000),
    };
  } finally {
    process.env = prev;
  }
}
