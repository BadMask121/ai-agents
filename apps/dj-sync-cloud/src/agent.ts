// The API the Mac (apps/dj-sync, cloud lane) polls. Every request carries
//   Authorization: Bearer <AGENT_TOKEN>
//   X-DJ-Sync-Agent-Protocol: <semver>   (checked against AGENT_PROTOCOL)
//   X-DJ-Sync-Agent-Version:  <semver>   (recorded for /health)
//
//   POST /agent/poll                {active: string[], can_claim: boolean}
//     → 200 {worker_version, protocol, job: null | {job_id, playlist, urls, attempt}}
//   POST /agent/jobs/{id}/complete  {state, message, tracks, errors, xml_version}
//     → 200 {ok: true} | 404 | 409 (already finished differently)

import { AGENT_PROTOCOL, LEASE_SECONDS, MAX_ACTIVE_IDS, WORKER_VERSION } from "./constants";
import type { Deps } from "./jobs";
import { parseSemver, protocolCompatible } from "./semver";
import type { JobError, JobResult, JobTrack } from "./store";
import { addSeconds, json, timingSafeEqual } from "./util";

export const PROTOCOL_HEADER = "x-dj-sync-agent-protocol";
export const VERSION_HEADER = "x-dj-sync-agent-version";

const WORKER_PROTOCOL = parseSemver(AGENT_PROTOCOL)!;

/**
 * Auth + protocol gate shared by every agent route. Returns a response to
 * send on failure, or null to carry on (after recording the agent as seen).
 */
export async function gate(req: Request, token: string, deps: Deps): Promise<Response | null> {
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (presented === "" || !timingSafeEqual(presented, token)) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }

  const rawProtocol = req.headers.get(PROTOCOL_HEADER);
  const agentProtocol = parseSemver(rawProtocol);
  if (!agentProtocol) {
    return json({ error: "missing_or_invalid_protocol", expected_header: "X-DJ-Sync-Agent-Protocol" }, 400);
  }
  if (!protocolCompatible(WORKER_PROTOCOL, agentProtocol)) {
    return json(
      {
        error: "incompatible_protocol",
        worker_protocol: AGENT_PROTOCOL,
        agent_protocol: rawProtocol!.trim(),
        worker_version: WORKER_VERSION,
      },
      409,
    );
  }

  const version = req.headers.get(VERSION_HEADER)?.trim().slice(0, 64) || null;
  await deps.store.touchAgent({
    last_seen: deps.now().toISOString(),
    version,
    protocol: rawProtocol!.trim(),
  });
  return null;
}

export async function poll(body: unknown, deps: Deps): Promise<Response> {
  if (!isObj(body)) return invalid("expected a JSON object");
  const active = body.active ?? [];
  const canClaim = body.can_claim ?? false;
  if (!Array.isArray(active) || active.length > MAX_ACTIVE_IDS || !active.every((a) => typeof a === "string")) {
    return invalid(`active must be an array of at most ${MAX_ACTIVE_IDS} job ids`);
  }
  if (typeof canClaim !== "boolean") return invalid("can_claim must be a boolean");

  const now = deps.now();
  const leaseUntil = addSeconds(now, LEASE_SECONDS).toISOString();
  await deps.store.extendLeases(active as string[], leaseUntil);

  let job = null;
  if (canClaim) {
    const claimed = await deps.store.claimNext(now.toISOString(), leaseUntil, "Downloading on your Mac…");
    if (claimed) {
      job = { job_id: claimed.id, playlist: claimed.playlist, urls: claimed.urls, attempt: claimed.attempts };
    }
  }
  return json({ worker_version: WORKER_VERSION, protocol: AGENT_PROTOCOL, job });
}

export async function complete(jobId: string, body: unknown, deps: Deps): Promise<Response> {
  const parsed = parseCompletion(body);
  if (typeof parsed === "string") return invalid(parsed);

  const job = await deps.store.getJob(jobId);
  if (!job) return json({ error: "not_found" }, 404);
  if (job.state === parsed.state) return json({ ok: true }); // a retried report
  if (job.state === "done" || job.state === "failed") {
    return json({ error: "already_finished", state: job.state }, 409);
  }

  await deps.store.finishJob(jobId, parsed.state, parsed.message, parsed.result, deps.now().toISOString());
  return json({ ok: true });
}

interface Completion {
  state: "done" | "failed";
  message: string;
  result: JobResult;
}

function parseCompletion(body: unknown): Completion | string {
  if (!isObj(body)) return "expected a JSON object";
  const { state, message, tracks = [], errors = [], xml_version = null } = body;
  if (state !== "done" && state !== "failed") return 'state must be "done" or "failed"';
  if (typeof message !== "string") return "message must be a string";
  if (!Array.isArray(tracks) || !tracks.every(isTrack)) return "tracks must be [{artist, title, file, already_downloaded}]";
  if (!Array.isArray(errors) || !errors.every(isError)) return "errors must be [{url, error}]";
  if (xml_version !== null && typeof xml_version !== "string") return "xml_version must be a string or null";
  return {
    state,
    message: message.slice(0, 2000),
    result: { tracks: tracks as JobTrack[], errors: errors as JobError[], xml_version },
  };
}

function isTrack(t: unknown): boolean {
  return (
    isObj(t) &&
    typeof t.artist === "string" &&
    typeof t.title === "string" &&
    typeof t.file === "string" &&
    typeof t.already_downloaded === "boolean"
  );
}

function isError(e: unknown): boolean {
  return isObj(e) && typeof e.url === "string" && typeof e.error === "string";
}

function invalid(detail: string): Response {
  return json({ error: "invalid_body", detail }, 400);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
