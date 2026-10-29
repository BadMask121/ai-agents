/** Semver of this Worker. Keep in sync with package.json (a test checks it). */
export const WORKER_VERSION = "1.5.0";

/**
 * Semver of the agent API the Mac polls. A Mac is compatible when it has the
 * same MAJOR and a MINOR no newer than ours (it may not rely on features this
 * Worker lacks). Bump MINOR for additive changes, MAJOR for breaking ones.
 */
export const AGENT_PROTOCOL = "1.1.0";
/** Agent protocol MINOR that understands library snapshots and library jobs. */
export const LIBRARY_PROTOCOL_MINOR = 1;

/**
 * Agent protocol 2: one WebSocket per Mac to its own Tenant Durable Object
 * (GET /v2/agent). Same compatibility rule as protocol 1. Protocol 1 above
 * keeps serving /agent/* until V1_RETIRED.
 */
export const AGENT_PROTOCOL_V2 = "2.0.0";

/** Newest first; the first is what we offer when the client asks for something else. */
export const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const MAX_BODY_BYTES = 64 * 1024;
/** Only `POST /agent/library` (the Mac's whole Rekordbox library) may be this big. */
export const MAX_LIBRARY_BYTES = 16 * 1024 * 1024;
/** Most track ids one playlist tool call may name. */
export const MAX_TRACK_IDS = 500;
/** Tracks `get_playlist` returns in full. */
/** get_playlist: tracks per page by default, and the most one call may ask for. */
export const PLAYLIST_TRACKS_SHOWN = 500;
export const PLAYLIST_PAGE_MAX = 1000;
/** list_playlists lists this many in its text (all of them, in practice). */
export const PLAYLISTS_LISTED = 1000;
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

// ---------- protocol 2: per-DJ tenants (spec §3) ----------

/** gzip'd library upload (PUT /v2/agent/library). */
export const MAX_LIBRARY_GZIP_BYTES = 8 * 1024 * 1024;
/** Decompressed cap, so a small gzip bomb can't exhaust memory. */
export const MAX_LIBRARY_JSON_BYTES = 64 * 1024 * 1024;
/** Library snapshot BLOB rows (SQLite rows max out at 2 MB). */
export const LIBRARY_CHUNK_BYTES = 1024 * 1024;

export const MAX_QUEUED_JOBS = 50;
export const MAX_JOBS_PER_DAY = 200;
export const MAX_MCP_CALLS_PER_HOUR = 600;
export const MAX_LINKS = 10;
export const MAX_LINK_LABEL = 60;
/** Agent reconnects per hour before the socket is refused with 4029. */
export const MAX_AGENT_CONNECTS_PER_HOUR = 120;
/** `last_used_at` is rewritten at most this often (rows written are metered). */
export const LINK_TOUCH_SECONDS = 3600;

export const REGISTRATIONS_PER_IP_PER_DAY = 5;
export const REGISTRATIONS_PER_DAY = 5000;
export const INACTIVE_TENANT_DAYS = 90;
/**
 * The weekly inactivity sweep's cron (must match wrangler.jsonc); any other
 * cron is the daily v1 retention. Lives here because every export of the
 * entry module must be a handler or class.
 */
export const SWEEP_CRON = "41 4 * * 1";
/** Tenants purged per Registry sweep step (DO subrequest budget on Free). */
export const SWEEP_BATCH = 40;

// ---------- Telegram bot (connect-anywhere spec §1) ----------

/** A pairing code from the Mac app works this long, once. */
export const TELEGRAM_PAIRING_SECONDS = 600;
/** Links waiting for a playlist button are kept this long. */
export const TELEGRAM_PENDING_SECONDS = 24 * 3600;
/** Messages a chat may send an hour before the bot stops listening for a while. */
export const TELEGRAM_MESSAGES_PER_HOUR = 60;
/** Playlist buttons offered for a link (plus Default / New). */
export const TELEGRAM_BUTTONS = 6;

// ---------- the router: Jev before the assistant ----------

/** Jev answers within this, or the message goes on to the assistant. */
export const JEV_TIMEOUT_MS = 1500;
/** Options a Jev choice question takes (TypeSafe's limit). */
export const JEV_MAX_CHOICES = 255;
/** Act on Jev's answer only at or above this confidence; below, ask (buttons or the assistant). */
export const JEV_ACT_CONFIDENCE = 0.9;
/** The owner's /metrics keeps this many days of counts (in the Registry). */
export const USAGE_DAYS = 90;
/** Usage events one Telegram message may report at once. */
export const USAGE_EVENTS_MAX = 50;
/** Each assistant model call gives up after this (then the next model is tried). */
export const AGENT_CALL_TIMEOUT_MS = 15_000;

// ---------- one-scan iPhone install (connect-anywhere spec §2b) ----------

/** The signed .shortcut the Mac uploads. */
export const MAX_SHORTCUT_BYTES = 256 * 1024;
/** An install link works this long… */
export const SHORTCUT_INSTALL_SECONDS = 600;
/** …for this many downloads. */
export const SHORTCUT_INSTALL_DOWNLOADS = 5;

// ---------- the Telegram assistant (connect-anywhere spec §1c) ----------

/**
 * Workers AI model with function calling (OpenAI-style tools, tool_call_id
 * round-trips, a thinking switch, 131K context); see README. The AI_MODEL
 * var overrides it.
 */
export const AGENT_MODEL = "@cf/zai-org/glm-4.7-flash";
/** Model calls per message (each may run several tools). */
export const AGENT_MAX_ROUNDS = 5;
export const AGENT_MAX_TOKENS = 700;
/** Tool output fed back to the model is cut here. */
export const AGENT_TOOL_RESULT_CHARS = 6000;
/** Turns (user + assistant messages) remembered per chat, for a day at most. */
export const AGENT_MEMORY_TURNS = 10;
export const AGENT_MEMORY_SECONDS = 24 * 3600;
/** Free-text questions per chat per UTC day (the account's AI allowance is shared). */
export const AGENT_MESSAGES_PER_DAY = 60;
/** A delete / move-everything question can be confirmed for this long. */
export const AGENT_CONFIRM_SECONDS = 3600;

/** WebSocket close codes (agent protocol 2). */
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_INCOMPATIBLE = 4009;
export const CLOSE_REPLACED = 4010;
export const CLOSE_OVER_LIMITS = 4029;
