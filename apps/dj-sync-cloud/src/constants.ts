/** Semver of this Worker. Keep in sync with package.json (a test checks it). */
export const WORKER_VERSION = "0.2.0";

/**
 * Semver of the agent API the Mac polls. A Mac is compatible when it has the
 * same MAJOR and a MINOR no newer than ours (it may not rely on features this
 * Worker lacks). Bump MINOR for additive changes, MAJOR for breaking ones.
 */
export const AGENT_PROTOCOL = "1.1.0";
/** Agent protocol MINOR that understands library snapshots and library jobs. */
export const LIBRARY_PROTOCOL_MINOR = 1;

/** Newest first; the first is what we offer when the client asks for something else. */
export const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const MAX_BODY_BYTES = 64 * 1024;
/** Only `POST /agent/library` (the Mac's whole Rekordbox library) may be this big. */
export const MAX_LIBRARY_BYTES = 16 * 1024 * 1024;
/** Most track ids one playlist tool call may name. */
export const MAX_TRACK_IDS = 500;
/** Tracks `get_playlist` returns in full. */
export const PLAYLIST_TRACKS_SHOWN = 200;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
export const MAX_PLAYLIST_NAME = 100;
/** How long a claimed job stays "running" without a poll extending it. */
export const LEASE_SECONDS = 900;
/** The Mac counts as online if it polled within this window. */
export const AGENT_ONLINE_SECONDS = 120;
export const RETENTION_DAYS = 30;
export const RECENT_JOBS = 5;
export const MAX_ACTIVE_IDS = 100;
