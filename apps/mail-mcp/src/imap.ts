/**
 * IMAP access for mail-mcp: a small client built for Cloudflare Workers
 * sockets (imapflow relies on Node streams that don't work there). See
 * imap/session.ts for the operations, imap/protocol.ts for the wire format.
 */
export {
  ImapClient,
  ImapSession,
  MailboxError,
  type Connect,
  type FetchedMessage,
  type Folder,
  type SearchCriteria,
  type Socket,
} from "./imap/session.js";
export type { BodyPart, Envelope, Address } from "./imap/structure.js";
