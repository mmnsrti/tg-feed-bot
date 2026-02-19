/// <reference types="@cloudflare/workers-types" />

export async function ensureDbUpgrades(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS meta_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();

  const row = await db.prepare("SELECT value FROM meta_kv WHERE key='schema_v'").first<any>();
  const v = Number(row?.value ?? 0);
  if (v >= 7) return;

  // v1
  if (v < 1) {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS queued_realtime(
          user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          post_id INTEGER NOT NULL,
          queued_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, username, post_id)
        )`
      )
      .run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_queued_realtime_user_time ON queued_realtime(user_id, queued_at)").run();

    const altersV1 = [
      "ALTER TABLE sources ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sources ADD COLUMN check_every_sec INTEGER NOT NULL DEFAULT 5",
      "ALTER TABLE sources ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sources ADD COLUMN last_error TEXT",
      "ALTER TABLE sources ADD COLUMN last_error_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sources ADD COLUMN last_success_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE user_sources ADD COLUMN backfill_n INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE user_prefs ADD COLUMN default_backfill_n INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE user_prefs ADD COLUMN quiet_start INTEGER NOT NULL DEFAULT -1",
      "ALTER TABLE user_prefs ADD COLUMN quiet_end INTEGER NOT NULL DEFAULT -1",
    ];

    for (const q of altersV1) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  // v2
  if (v < 2) {
    try {
      await db.prepare("ALTER TABLE scraped_posts ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]'").run();
    } catch {}
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_scraped_posts_user_time2 ON scraped_posts(username, scraped_at)").run();
  }

  // v3
  if (v < 3) {
    const altersV3 = ["ALTER TABLE user_prefs ADD COLUMN post_style TEXT NOT NULL DEFAULT 'rich'", "ALTER TABLE user_sources ADD COLUMN label TEXT"];
    for (const q of altersV3) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  // v4: cache source chat photo file_id
  if (v < 4) {
    const altersV4 = [
      "ALTER TABLE sources ADD COLUMN chat_photo_file_id TEXT",
      "ALTER TABLE sources ADD COLUMN chat_photo_updated_at INTEGER NOT NULL DEFAULT 0",
    ];
    for (const q of altersV4) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  // v5: full text style preference
  if (v < 5) {
    const altersV5 = ["ALTER TABLE user_prefs ADD COLUMN full_text_style TEXT NOT NULL DEFAULT 'quote'"];
    for (const q of altersV5) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  // v6: global include/exclude filters in user prefs
  if (v < 6) {
    const altersV6 = [
      "ALTER TABLE user_prefs ADD COLUMN global_include_keywords TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE user_prefs ADD COLUMN global_exclude_keywords TEXT NOT NULL DEFAULT '[]'",
    ];
    for (const q of altersV6) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  // v7: store Telegram user profile fields for admin dashboard visibility
  if (v < 7) {
    const altersV7 = [
      "ALTER TABLE users ADD COLUMN username TEXT",
      "ALTER TABLE users ADD COLUMN first_name TEXT",
      "ALTER TABLE users ADD COLUMN last_name TEXT",
      "ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
    ];
    for (const q of altersV7) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  await db.prepare("INSERT OR REPLACE INTO meta_kv(key, value) VALUES('schema_v', '7')").run();
}
