CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_claims (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('dest')),
  created_at INTEGER NOT NULL
);

-- Public source channels by @username
CREATE TABLE IF NOT EXISTS sources (
  username TEXT PRIMARY KEY,
  last_post_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- user follows a username
CREATE TABLE IF NOT EXISTS user_sources (
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, username)
);

-- dedupe deliveries
CREATE TABLE IF NOT EXISTS deliveries (
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, username, post_id)
);
