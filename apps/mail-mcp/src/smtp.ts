/**
 * MCP-agnostic SMTP sender built on nodemailer. Stateless: one transport,
 * reused across sends.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Message-ID of the message being replied to (sets In-Reply-To/References). */
  inReplyTo?: string;
}

export class SmtpClient {
  private transport: Transporter;

  constructor(private readonly cfg: Config) {
    this.transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      // 465 is implicit TLS; every other port (587/25) starts plain and must
      // upgrade via STARTTLS — requireTLS forbids a plaintext fallback.
      secure: cfg.smtpPort === 465,
      requireTLS: true,
      auth: { user: cfg.user, pass: cfg.pass },
      // Fail fast so tool calls surface a clean error instead of an upstream
      // proxy 504 (nodemailer's defaults wait minutes).
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(msg: OutgoingMessage): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: this.cfg.user,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      text: msg.body,
      inReplyTo: msg.inReplyTo,
      references: msg.inReplyTo ? [msg.inReplyTo] : undefined,
    });
    return { messageId: info.messageId };
  }
}
