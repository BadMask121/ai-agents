// Stateless MCP (JSON-RPC 2.0) dispatch — port of apps/dj-sync/src/mcp.rs.
// Transport concerns (status codes, headers) live in router.ts; this maps one
// message to at most one response (`null` = notification → 202).

import { RECENT_JOBS, SUPPORTED_MCP_VERSIONS, WORKER_VERSION } from "./constants";
import { agentStatus, jobView, offlineNote, stateWord, submit, type Deps } from "./jobs";
import { extractMediaRef, type MediaRef } from "./links";
import { errorSummary } from "./util";

const DOWNLOAD_TOOL = "download_to_rekordbox";
const STATUS_TOOL = "get_download_status";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Json = unknown;
type Obj = Record<string, unknown>;

export function parseError(): Json {
  return error(null, PARSE_ERROR, "Parse error: body is not valid JSON");
}

export async function dispatch(msg: Json, deps: Deps): Promise<Json | null> {
  if (Array.isArray(msg)) return error(null, INVALID_REQUEST, "JSON-RPC batches are not supported");
  if (!isObj(msg)) return error(null, INVALID_REQUEST, "expected a JSON-RPC object");

  const hasId = "id" in msg;
  const method = typeof msg.method === "string" ? msg.method : undefined;
  if (!hasId || method === undefined) {
    // No id: a notification (e.g. notifications/initialized) — nothing to say.
    return hasId ? error(msg.id, INVALID_REQUEST, "missing method") : null;
  }
  const id = msg.id;
  if (msg.jsonrpc !== "2.0") return error(id, INVALID_REQUEST, 'jsonrpc must be "2.0"');
  const params = isObj(msg.params) ? msg.params : {};

  switch (method) {
    case "initialize":
      return ok(id, initialize(params));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toolDefinitions(deps.config.maxUrls) });
    case "tools/call": {
      const name = params.name;
      const args = isObj(params.arguments) ? params.arguments : undefined;
      if (name === DOWNLOAD_TOOL) return ok(id, await callDownload(args, deps));
      if (name === STATUS_TOOL) return ok(id, await callStatus(args, deps));
      if (typeof name === "string") return error(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      return error(id, INVALID_PARAMS, "tools/call requires params.name");
    }
    default:
      return error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function initialize(params: Obj): Json {
  const requested = params.protocolVersion;
  const version =
    typeof requested === "string" && (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : SUPPORTED_MCP_VERSIONS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "dj-sync", title: "DJ Sync → Rekordbox", version: WORKER_VERSION },
    instructions:
      "Use download_to_rekordbox when the user shares Spotify or YouTube links they want in " +
      "Rekordbox. It queues a download for the DJ's Mac and returns a job_id right away; the Mac " +
      "picks it up as soon as it's online and downloads take a few minutes. Use " +
      "get_download_status with that job_id when the user asks how it went.",
  };
}

export function toolDefinitions(maxUrls: number): Json {
  return [
    {
      name: DOWNLOAD_TOOL,
      title: "Download to Rekordbox",
      description:
        "Download Spotify (track, album, playlist) or YouTube (video, playlist) links as audio files " +
        "on the DJ's Mac and add them to a playlist in the Rekordbox import XML. Returns immediately " +
        "with a job_id; the download runs on the Mac (queued until it's online) and takes a few " +
        "minutes — call get_download_status to check on it.",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: maxUrls,
            description: "Spotify or YouTube links, e.g. https://open.spotify.com/track/… or https://youtu.be/…",
          },
          playlist_name: {
            type: "string",
            maxLength: 100,
            description: "Rekordbox playlist to add the tracks to. Omit to use the default playlist.",
          },
        },
        required: ["urls"],
        additionalProperties: false,
      },
      annotations: {
        title: "Download to Rekordbox",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      name: STATUS_TOOL,
      title: "Download status",
      description:
        "Check a download job started by download_to_rekordbox. Pass its job_id, or omit it to list " +
        "the most recent jobs.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job_id returned by download_to_rekordbox." },
        },
        additionalProperties: false,
      },
      annotations: { title: "Download status", readOnlyHint: true, openWorldHint: false },
    },
  ];
}

async function callDownload(args: Obj | undefined, deps: Deps): Promise<Json> {
  const urls = args?.urls;
  if (!Array.isArray(urls)) return toolError("`urls` must be a list of Spotify or YouTube links.");
  if (urls.length === 0) return toolError("`urls` is empty — send at least one Spotify or YouTube link.");
  if (urls.length > deps.config.maxUrls) {
    return toolError(`Too many links (${urls.length}); send at most ${deps.config.maxUrls} per call.`);
  }
  const rawPlaylist = args?.playlist_name;
  if (rawPlaylist !== undefined && rawPlaylist !== null && typeof rawPlaylist !== "string") {
    return toolError("`playlist_name` must be a string.");
  }

  const media: MediaRef[] = [];
  const rejected: { url: unknown; reason: string }[] = [];
  for (const u of urls) {
    if (typeof u !== "string") {
      rejected.push({ url: u, reason: "not a string" });
      continue;
    }
    const r = extractMediaRef(u);
    if (!r.ok) rejected.push({ url: u, reason: r.reason });
    else if (!media.some((m) => m.url === r.media.url)) media.push(r.media); // duplicate in the same call
  }
  if (media.length === 0) {
    return toolResult(
      "None of the links can be downloaded: only https Spotify track/album/playlist and YouTube " +
        "video/playlist links are supported.",
      { rejected },
      true,
    );
  }

  const sub = await submit(deps, media, rawPlaylist ?? null, "mcp");
  if (!sub.ok) return toolError(sub.error);
  const { job, position, deduplicated } = sub.value;
  const agent = await agentStatus(deps);

  let text = deduplicated
    ? `That download is already in progress as job ${job.id} (${stateWord(job.state)}).`
    : `Queued job ${job.id}: ${job.urls.length} link(s) → Rekordbox playlist "${job.playlist}"` +
      (position > 0 ? ` (${position} job(s) ahead)` : "") +
      ". Downloads take a few minutes; check with get_download_status.";
  if (rejected.length > 0) text += ` Skipped ${rejected.length} unsupported link(s).`;
  if (!agent.online) text += offlineNote(agent, deps.now());

  return toolResult(
    text,
    {
      job_id: job.id,
      state: job.state,
      playlist: job.playlist,
      urls: job.urls,
      created_at: job.created_at,
      position,
      deduplicated,
      rejected,
      mac_online: agent.online,
    },
    false,
  );
}

async function callStatus(args: Obj | undefined, deps: Deps): Promise<Json> {
  const agent = await agentStatus(deps);
  const jobId = typeof args?.job_id === "string" ? args.job_id.trim() : undefined;

  if (jobId !== undefined) {
    const job = await deps.store.getJob(jobId);
    if (!job) {
      return toolError(`No job ${jobId}. Call get_download_status without a job_id to list recent jobs.`);
    }
    const view = jobView(job);
    let text = `Job ${job.id} is ${stateWord(job.state)}. ${job.message}`;
    for (const e of view.errors) text += `\n- ${e.url}: ${errorSummary(e.error)}`;
    if (job.state === "queued" && !agent.online) text += offlineNote(agent, deps.now());
    return toolResult(text, { ...view, mac_online: agent.online }, false);
  }

  const jobs = await deps.store.recentJobs(RECENT_JOBS);
  let text =
    jobs.length === 0
      ? `No download jobs yet. New downloads go to the "${deps.config.defaultPlaylist}" playlist unless you name one.`
      : jobs.map((j) => `${j.id} — ${stateWord(j.state)} — "${j.playlist}" — ${j.message}`).join("\n");
  if (jobs.some((j) => j.state === "queued") && !agent.online) text += `\n${offlineNote(agent, deps.now()).trim()}`;
  return toolResult(text, { jobs: jobs.map(jobView), mac_online: agent.online }, false);
}

function toolResult(text: string, structured: Json, isError: boolean): Json {
  return { content: [{ type: "text", text }], structuredContent: structured, isError };
}

function toolError(text: string): Json {
  return { content: [{ type: "text", text }], isError: true };
}

function ok(id: unknown, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

function error(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
