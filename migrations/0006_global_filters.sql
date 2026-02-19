ALTER TABLE user_prefs ADD COLUMN global_include_keywords TEXT NOT NULL DEFAULT '[]';
ALTER TABLE user_prefs ADD COLUMN global_exclude_keywords TEXT NOT NULL DEFAULT '[]';
