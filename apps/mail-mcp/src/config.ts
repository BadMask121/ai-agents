/**
 * Configuration from the Worker's environment (secrets + vars). Read per
 * request; fails fast when a required secret is missing so the endpoint never
 * runs half-configured.
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
  /** Text bodies longer than this (bytes) are truncated before returning. */
  maxBodyBytes: number;
  /** get_attachment refuses to return payloads larger than this (bytes). */
  maxAttachmentBytes: number;
}

export type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function intEnv(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  return n;
}

export function loadConfig(env: Env): Config {
  return {
    imapHost: env.IMAP_HOST?.trim() || "mail.privateemail.com",
    imapPort: intEnv(env, "IMAP_PORT", 993),
    smtpHost: env.SMTP_HOST?.trim() || "mail.privateemail.com",
    // 587 (submission/STARTTLS); Workers sockets also refuse port 25.
    smtpPort: intEnv(env, "SMTP_PORT", 587),
    user: required(env, "PRIVATEEMAIL_USER"),
    pass: required(env, "PRIVATEEMAIL_PASS"),
    secretPath: required(env, "MCP_SECRET_PATH").replace(/^\/+|\/+$/g, ""),
    maxBodyBytes: intEnv(env, "MAX_BODY_BYTES", 100_000),
    maxAttachmentBytes: intEnv(env, "MAX_ATTACHMENT_BYTES", 5_000_000),
  };
}
