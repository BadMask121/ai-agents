// Minimal typing for the Workers TCP socket API (only what socket.ts uses).
declare module "cloudflare:sockets" {
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<unknown>;
    close(): Promise<void>;
  }
  export function connect(
    address: { hostname: string; port: number },
    options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
  ): Socket;
}
