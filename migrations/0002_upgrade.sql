-- sources: adaptive polling + error tracking
ALTER TABLE sources ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN check_every_sec INTEGER NOT NULL DEFAULT 5;
ALTER TABLE sources ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_error TEXT;
ALTER TABLE sources ADD COLUMN last_error_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_success_at INTEGER NOT NULL DEFAULT 0;

-- user_sources: per-channel advanced filter + backfill
ALTER TABLE user_sources ADD COLUMN backfill_n INTEGER NOT NULL DEFAULT 3;
ALTER TABLE user_sources ADD COLUMN case_sensitive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_sources ADD COLUMN skip_empty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_sources ADD COLUMN min_len INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_sources ADD COLUMN include_mode TEXT NOT NULL DEFAULT 'substring'; -- substring|wholeword|regex
ALTER TABLE user_sources ADD COLUMN exclude_mode TEXT NOT NULL DEFAULT 'substring'; -- substring|wholeword|regex
ALTER TABLE user_sources ADD COLUMN url_include_hosts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE user_sources ADD COLUMN url_exclude_hosts TEXT NOT NULL DEFAULT '[]';

-- user_prefs: UI + digest + quiet hours + defaults
ALTER TABLE user_prefs ADD COLUMN default_backfill_n INTEGER NOT NULL DEFAULT 3;
ALTER TABLE user_prefs ADD COLUMN digest_max_items INTEGER NOT NULL DEFAULT 30;
ALTER TABLE user_prefs ADD COLUMN digest_max_per_channel INTEGER NOT NULL DEFAULT 10;
ALTER TABLE user_prefs ADD COLUMN list_query TEXT NOT NULL DEFAULT '';
ALTER TABLE user_prefs ADD COLUMN quiet_start INTEGER NOT NULL DEFAULT -1; -- hour 0..23 or -1 disabled
ALTER TABLE user_prefs ADD COLUMN quiet_end INTEGER NOT NULL DEFAULT -1;   -- hour 0..23 or -1 disabled

-- rate limiting table
CREATE TABLE IF NOT EXISTS user_rl (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- queued realtime (quiet hours)
CREATE TABLE IF NOT EXISTS queued_realtime (
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, username, post_id)
);

-- small KV table (cleanup cadence)
CREATE TABLE IF NOT EXISTS meta_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- extra helpful indexes
CREATE INDEX IF NOT EXISTS idx_sources_next_check ON sources(next_check_at);
CREATE INDEX IF NOT EXISTS idx_queued_user_time ON queued_realtime(user_id, queued_at);
