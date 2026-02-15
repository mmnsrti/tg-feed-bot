ALTER TABLE scraped_posts ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_scraped_posts_user_time2 ON scraped_posts(username, scraped_at);
