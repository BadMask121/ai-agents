// workerd globals the Durable Objects touch at construction time.
const g = globalThis as Record<string, unknown>;
if (typeof g.WebSocketRequestResponsePair === "undefined") {
  g.WebSocketRequestResponsePair = class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  };
}
