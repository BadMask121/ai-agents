// The API the Mac (apps/dj-sync, cloud lane) polls. Every request carries
//   Authorization: Bearer <AGENT_TOKEN>
//   X-DJ-Sync-Agent-Protocol: <semver>   (checked against AGENT_PROTOCOL)
//   X-DJ-Sync-Agent-Version:  <semver>   (recorded for /health)
//
//   POST /agent/poll                {active: string[], can_claim: boolean, library_hash?: string}
//     → 200 {worker_version, protocol, library_wanted,
//            job: null | {job_id, kind, playlist, urls, attempt, [ops, summary]}}
//   POST /agent/library             {hash, generated_at, library_version, playlists, tracks}   (protocol ≥ 1.1)
//     → 200 {ok: true}
//   POST /agent/jobs/{id}/complete  {state, message, tracks, errors, xml_version, library_version?}
//     → 200 {ok: true} | 404 | 409 (already finished differently)

import { AGENT_PROTOCOL, LEASE_SECONDS, LIBRARY_PROTOCOL_MINOR, MAX_ACTIVE_IDS, WORKER_VERSION } from "./constants";
import type { Deps } from "./jobs";
import { parseSemver, protocolCompatible, type SemVer } from "./semver";
import type { JobError, JobResult, JobRow, JobTrack, LibPlaylist, LibTrack } from "./store";
import { addSeconds, json, timingSafeEqual } from "./util";

export const PROTOCOL_HEADER = "x-dj-sync-agent-protocol";
export const VERSION_HEADER = "x-dj-sync-agent-version";

const WORKER_PROTOCOL = parseSemver(AGENT_PROTOCOL)!;

export type Gate = { ok: true; protocol: SemVer } | { ok: false; response: Response };

/**
 * Auth + protocol gate shared by every agent route. On success the agent is
 * recorded as seen and its protocol is returned (routes that need a newer
 * MINOR check it themselves).
 */
export async function gate(req: Request, token: string, deps: Deps): Promise<Gate> {
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (presented === "" || !timingSafeEqual(presented, token)) {
    return { ok: false, response: json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" }) };
  }

  const rawProtocol = req.headers.get(PROTOCOL_HEADER);
  const agentProtocol = parseSemver(rawProtocol);
  if (!agentProtocol) {
    return {
      ok: false,
      response: json({ error: "missing_or_invalid_protocol", expected_header: "X-DJ-Sync-Agent-Protocol" }, 400),
    };
  }
  if (!protocolCompatible(WORKER_PROTOCOL, agentProtocol)) {
    return { ok: false, response: incompatible(rawProtocol!.trim()) };
  }

  const version = req.headers.get(VERSION_HEADER)?.trim().slice(0, 64) || null;
  await deps.store.touchAgent({
    last_seen: deps.now().toISOString(),
    version,
    protocol: rawProtocol!.trim(),
  });
  return { ok: true, protocol: agentProtocol };
}

function incompatible(agentProtocol: string, detail?: string): Response {
  return json(
    {
      error: "incompatible_protocol",
      worker_protocol: AGENT_PROTOCOL,
      agent_protocol: agentProtocol,
      worker_version: WORKER_VERSION,
      ...(detail ? { detail } : {}),
    },
    409,
  );
}

const understandsLibrary = (p: SemVer) => p.major === WORKER_PROTOCOL.major && p.minor >= LIBRARY_PROTOCOL_MINOR;

export async function poll(body: unknown, protocol: SemVer, deps: Deps): Promise<Response> {
  if (!isObj(body)) return invalid("expected a JSON object");
  const active = body.active ?? [];
  const canClaim = body.can_claim ?? false;
  const libraryHash = body.library_hash ?? null;
  if (!Array.isArray(active) || active.length > MAX_ACTIVE_IDS || !active.every((a) => typeof a === "string")) {
    return invalid(`active must be an array of at most ${MAX_ACTIVE_IDS} job ids`);
  }
  if (typeof canClaim !== "boolean") return invalid("can_claim must be a boolean");
  if (libraryHash !== null && typeof libraryHash !== "string") return invalid("library_hash must be a string");

  const now = deps.now();
  const leaseUntil = addSeconds(now, LEASE_SECONDS).toISOString();
  await deps.store.extendLeases(active as string[], leaseUntil);

  // Ask for a fresh snapshot only when the Mac says its library changed.
  let libraryWanted = false;
  if (libraryHash !== null) {
    const agent = await deps.store.getAgent();
    libraryWanted = agent?.library_hash !== libraryHash;
  }

  let job = null;
  if (canClaim) {
    const claimed = await deps.store.claimNext(now.toISOString(), leaseUntil, understandsLibrary(protocol));
    if (claimed) job = claimedJobView(claimed);
  }
  return json({ worker_version: WORKER_VERSION, protocol: AGENT_PROTOCOL, library_wanted: libraryWanted, job });
}

/** A claimed job as the Mac receives it (v1 poll and the v2 `job` frame). */
export function claimedJobView(claimed: JobRow) {
  return claimed.kind === "library"
    ? {
        job_id: claimed.id,
        kind: claimed.kind,
        playlist: claimed.playlist,
        urls: [] as string[],
        attempt: claimed.attempts,
        ops: claimed.ops ?? [],
        summary: claimed.summary ?? "",
      }
    : {
        job_id: claimed.id,
        kind: claimed.kind,
        playlist: claimed.playlist,
        urls: claimed.urls,
        attempt: claimed.attempts,
      };
}

/** The Mac's Rekordbox library (playlists + tracks), for ChatGPT to browse. */
export async function uploadLibrary(
  body: unknown,
  protocol: SemVer,
  rawProtocol: string,
  deps: Deps,
): Promise<Response> {
  if (!understandsLibrary(protocol)) {
    return incompatible(rawProtocol, `library snapshots need agent protocol ≥ 1.${LIBRARY_PROTOCOL_MINOR}`);
  }
  const parsed = parseLibrary(body);
  if (typeof parsed === "string") return invalid(parsed);
  try {
    await deps.store.putLibrary(parsed.playlists, parsed.tracks);
  } catch (e) {
    console.error(`library upload not stored: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "library_storage_unavailable" }, 503);
  }
  await deps.store.setLibraryMeta({
    library_hash: parsed.hash,
    library_generated_at: parsed.generated_at,
    library_version: parsed.library_version,
  });
  return json({ ok: true, playlists: parsed.playlists.length, tracks: parsed.tracks.length });
}

export interface Snapshot {
  hash: string;
  generated_at: string;
  library_version: string | null;
  playlists: LibPlaylist[];
  tracks: LibTrack[];
}

const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseLibrary(body: unknown): Snapshot | string {
  if (!isObj(body)) return "expected a JSON object";
  const { hash, generated_at, library_version = null, playlists, tracks } = body;
  if (typeof hash !== "string" || hash === "") return "hash must be a non-empty string";
  if (typeof generated_at !== "string" || Number.isNaN(Date.parse(generated_at))) {
    return "generated_at must be an RFC 3339 timestamp";
  }
  if (library_version !== null && typeof library_version !== "string") return "library_version must be a string or null";
  if (!Array.isArray(playlists)) return "playlists must be an array";
  if (!Array.isArray(tracks)) return "tracks must be an array";

  const outPlaylists: LibPlaylist[] = [];
  for (const p of playlists) {
    if (!isObj(p) || typeof p.id !== "string" || typeof p.name !== "string") {
      return "each playlist needs string id and name";
    }
    const ids = p.track_ids ?? [];
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return "playlist track_ids must be strings";
    outPlaylists.push({ id: p.id, name: p.name, folder: typeof p.folder === "string" ? p.folder : "", track_ids: ids });
  }
  const outTracks: LibTrack[] = [];
  for (const t of tracks) {
    if (!isObj(t) || typeof t.id !== "string") return "each track needs a string id";
    outTracks.push({
      id: t.id,
      title: typeof t.title === "string" ? t.title : "",
      artist: strOrNull(t.artist),
      album: strOrNull(t.album),
      genre: strOrNull(t.genre),
      bpm: numOrNull(t.bpm),
      key: strOrNull(t.key),
      duration_secs: numOrNull(t.duration_secs),
    });
  }
  return { hash, generated_at, library_version, playlists: outPlaylists, tracks: outTracks };
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

export interface Completion {
  state: "done" | "failed";
  message: string;
  result: JobResult;
}

export function parseCompletion(body: unknown): Completion | string {
  if (!isObj(body)) return "expected a JSON object";
  const { state, message, tracks = [], errors = [], xml_version = null, library_version = null } = body;
  if (state !== "done" && state !== "failed") return 'state must be "done" or "failed"';
  if (typeof message !== "string") return "message must be a string";
  if (!Array.isArray(tracks) || !tracks.every(isTrack)) return "tracks must be [{artist, title, file, already_downloaded}]";
  if (!Array.isArray(errors) || !errors.every(isError)) return "errors must be [{url, error}]";
  if (xml_version !== null && typeof xml_version !== "string") return "xml_version must be a string or null";
  if (library_version !== null && typeof library_version !== "string") {
    return "library_version must be a string or null";
  }
  return {
    state,
    message: message.slice(0, 2000),
    result: { tracks: tracks as JobTrack[], errors: errors as JobError[], xml_version, library_version },
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
