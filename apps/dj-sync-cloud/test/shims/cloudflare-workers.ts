// Stand-in for the workerd-only `cloudflare:workers` module in Node tests.
export class DurableObject<Env = unknown> {
  constructor(
    public ctx: DurableObjectState,
    public env: Env,
  ) {}
}
