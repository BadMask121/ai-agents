-- Agent protocol 1.1: ChatGPT playlist management.
-- Jobs can now be Rekordbox library edits (playlist ops) as well as downloads;
-- the agent row remembers which library snapshot the Mac last uploaded
-- (the snapshot itself lives in KV, binding LIBRARY).

ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'download' CHECK (kind IN ('download', 'library'));
ALTER TABLE jobs ADD COLUMN ops TEXT;      -- JSON array of playlist ops (library jobs)
ALTER TABLE jobs ADD COLUMN summary TEXT;  -- "Add 3 tracks to “Friday”" (library jobs)

ALTER TABLE agent ADD COLUMN library_hash TEXT;
ALTER TABLE agent ADD COLUMN library_generated_at TEXT;
ALTER TABLE agent ADD COLUMN library_version TEXT;
