-- dj-sync cloud queue: jobs accepted from ChatGPT / the iOS Shortcut while the
-- DJ laptop may be offline, and the single agent row the laptop keeps fresh.

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,                        -- 12 hex chars
  state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  playlist    TEXT NOT NULL,
  urls        TEXT NOT NULL,                           -- JSON array of canonical URLs
  dedupe_key  TEXT NOT NULL,                           -- JSON [playlist, urls]
  source      TEXT NOT NULL CHECK (source IN ('mcp', 'shortcut')),
  created_at  TEXT NOT NULL,                           -- ISO-8601 UTC (lexically ordered)
  claimed_at  TEXT,
  lease_until TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  message     TEXT NOT NULL DEFAULT 'Queued.',
  result      TEXT                                     -- JSON {tracks, errors, xml_version}
);

CREATE INDEX jobs_state_created ON jobs (state, created_at);
CREATE INDEX jobs_dedupe ON jobs (dedupe_key, state);

CREATE TABLE agent (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen TEXT,
  version   TEXT,
  protocol  TEXT
);
