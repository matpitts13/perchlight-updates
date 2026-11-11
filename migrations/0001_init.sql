-- perchlight-updates: releases, their files, private feeds, and counters.

-- A channel is created the first time a release is made for it.
-- private = 1: its feed and files are served only under /p/<token>/.
-- keep: how many releases keep their files (NULL = the KEEP_RELEASES var).
CREATE TABLE channels (
  name       TEXT PRIMARY KEY CHECK (name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9]*' AND length(name) <= 32),
  private    INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  keep       INTEGER CHECK (keep IS NULL OR keep BETWEEN 1 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- draft      uploaded, not served
-- live       the one release a channel's feed serves
-- superseded replaced by a newer live release; files kept for a pull to fall back to
-- pulled     taken down; files kept so it can be restored
-- expired    files deleted by the clean-up
CREATE TABLE releases (
  id           INTEGER PRIMARY KEY,
  channel      TEXT NOT NULL REFERENCES channels (name),
  version      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft', 'live', 'superseded', 'pulled', 'expired')),
  rollout      INTEGER NOT NULL DEFAULT 100 CHECK (rollout BETWEEN 1 AND 100),
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  pulled_at    TEXT,
  UNIQUE (channel, version)
);
CREATE UNIQUE INDEX releases_one_live ON releases (channel) WHERE state = 'live';

-- kind: feed (latest*.yml, latest.json), file (everything else).
-- platform, for feeds: '' (Windows), '-mac', '-linux', '-linux-arm64', ... or 'tauri'.
CREATE TABLE release_files (
  id         INTEGER PRIMARY KEY,
  release_id INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('feed', 'file')),
  platform   TEXT NOT NULL DEFAULT '',
  r2_key     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  sha512     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (release_id, name)
);
CREATE INDEX release_files_name ON release_files (name);
CREATE INDEX release_files_key ON release_files (r2_key);

-- Multipart uploads in progress. Abandoned ones are aborted after a day.
CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  release_id   INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha512       TEXT NOT NULL,
  part_size    INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (release_id, name)
);
CREATE TABLE upload_parts (
  upload_id   TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

-- Private feeds. Only a SHA-256 of the token is stored; the token is shown once.
CREATE TABLE feed_tokens (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  channel    TEXT NOT NULL REFERENCES channels (name),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- Counters. source: 'public' or 'token:<id>'. No IP addresses or user ids.
CREATE TABLE downloads_daily (
  day        TEXT NOT NULL,
  release_id INTEGER NOT NULL,
  file_name  TEXT NOT NULL,
  source     TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, release_id, file_name, source)
);
CREATE TABLE checks_daily (
  day      TEXT NOT NULL,
  channel  TEXT NOT NULL,
  platform TEXT NOT NULL,
  source   TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel, platform, source)
);
