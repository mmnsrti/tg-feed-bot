ALTER TABLE sources ADD COLUMN chat_photo_file_id TEXT;
ALTER TABLE sources ADD COLUMN chat_photo_updated_at INTEGER NOT NULL DEFAULT 0;
