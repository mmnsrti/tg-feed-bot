-- schema.sql (FULL)

CREATE TABLE IF NOT EXISTS meta_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- core
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_claims (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- sources being monitored
CREATE TABLE IF NOT EXISTS sources (
  username TEXT PRIMARY KEY,
  last_post_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  check_every_sec INTEGER NOT NULL DEFAULT 5,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER NOT NULL DEFAULT 0,
  chat_photo_file_id TEXT,
  chat_photo_updated_at INTEGER NOT NULL DEFAULT 0
);

-- user subscriptions + per-channel settings
CREATE TABLE IF NOT EXISTS user_sources (
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  paused INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'realtime',
  include_keywords TEXT NOT NULL DEFAULT '[]',
  exclude_keywords TEXT NOT NULL DEFAULT '[]',
  backfill_n INTEGER NOT NULL DEFAULT 0,
  label TEXT,

  PRIMARY KEY (user_id, username)
);

-- global user prefs
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER PRIMARY KEY,
  lang TEXT NOT NULL DEFAULT 'fa',
  digest_hours INTEGER NOT NULL DEFAULT 6,
  last_digest_at INTEGER NOT NULL DEFAULT 0,
  realtime_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  default_backfill_n INTEGER NOT NULL DEFAULT 0,
  quiet_start INTEGER NOT NULL DEFAULT -1,
  quiet_end INTEGER NOT NULL DEFAULT -1,
  post_style TEXT NOT NULL DEFAULT 'rich',
  full_text_style TEXT NOT NULL DEFAULT 'quote',
  global_include_keywords TEXT NOT NULL DEFAULT '[]',
  global_exclude_keywords TEXT NOT NULL DEFAULT '[]'
);

-- scraped cache for digest mode
CREATE TABLE IF NOT EXISTS scraped_posts (
  username TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  link TEXT NOT NULL,
  media_json TEXT NOT NULL DEFAULT '[]',
  scraped_at INTEGER NOT NULL,
  PRIMARY KEY (username, post_id)
);

-- queued realtime (quiet hours)
CREATE TABLE IF NOT EXISTS queued_realtime (
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, username, post_id)
);

-- per-user conversation state
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  data TEXT,
  updated_at INTEGER NOT NULL
);

-- de-dupe delivery (prevents duplicates)
CREATE TABLE IF NOT EXISTS deliveries (
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, username, post_id)
);

-- tick lock (prevents overlapping runs)
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  acquired_at INTEGER NOT NULL
);

-- helpful indexes
CREATE INDEX IF NOT EXISTS idx_user_sources_username ON user_sources(username);
CREATE INDEX IF NOT EXISTS idx_user_sources_user_id ON user_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_scraped_posts_user_time ON scraped_posts(username, scraped_at);
CREATE INDEX IF NOT EXISTS idx_scraped_posts_user_time2 ON scraped_posts(username, scraped_at);
CREATE INDEX IF NOT EXISTS idx_queued_realtime_user_time ON queued_realtime(user_id, queued_at);
