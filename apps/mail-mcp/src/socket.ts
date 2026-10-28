/**
 * TLS sockets for the IMAP client, from the Workers runtime. Kept in its own
 * module so nothing else imports `cloudflare:sockets` (tests run in Node).
 */
import { connect } from "cloudflare:sockets";
import type { Connect } from "./imap.js";

export const connectTls: Connect = async (host, port) => {
  const socket = connect({ hostname: host, port }, { secureTransport: "on" });
  await socket.opened;
  return socket;
};
