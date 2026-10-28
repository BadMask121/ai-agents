/** Semver of this Worker. Keep in sync with package.json (a test checks it). */
export const WORKER_VERSION = "0.1.0";

/**
 * Semver of the agent API the Mac polls. A Mac is compatible when it has the
 * same MAJOR and a MINOR no newer than ours (it may not rely on features this
 * Worker lacks). Bump MINOR for additive changes, MAJOR for breaking ones.
 */
export const AGENT_PROTOCOL = "1.0.0";

/** Newest first; the first is what we offer when the client asks for something else. */
export const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PLAYLIST_NAME = 100;
/** How long a claimed job stays "running" without a poll extending it. */
export const LEASE_SECONDS = 900;
/** The Mac counts as online if it polled within this window. */
export const AGENT_ONLINE_SECONDS = 120;
export const RETENTION_DAYS = 30;
export const RECENT_JOBS = 5;
export const MAX_ACTIVE_IDS = 100;
