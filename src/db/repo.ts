/// <reference types="@cloudflare/workers-types" />

import { ChannelMode, DestinationRow, Lang, PostStyle, UserPrefs, UserSourceRow, UserState } from "../types";

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

/** ------------------- users & destinations ------------------- */
export async function upsertUser(db: D1Database, userId: number) {
  await db.prepare("INSERT OR IGNORE INTO users(user_id, created_at) VALUES(?, ?)").bind(userId, nowSec()).run();
}

export async function getDestination(db: D1Database, userId: number): Promise<DestinationRow | null> {
  return db.prepare("SELECT chat_id, verified FROM destinations WHERE user_id=?").bind(userId).first<any>();
}

export async function setDestinationVerified(db: D1Database, userId: number, chatId: number) {
  await db
    .prepare("INSERT OR REPLACE INTO destinations(user_id, chat_id, verified, created_at) VALUES(?, ?, 1, ?)")
    .bind(userId, chatId, nowSec())
    .run();
}

export async function markDestinationBad(db: D1Database, userId: number) {
  await db.prepare("UPDATE destinations SET verified=0 WHERE user_id=?").bind(userId).run();
}

export async function clearDestination(db: D1Database, userId: number) {
  await db.prepare("DELETE FROM destinations WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM pending_claims WHERE user_id=? AND kind='dest'").bind(userId).run();
}

/** ------------------- prefs ------------------- */
export async function ensurePrefs(db: D1Database, userId: number): Promise<UserPrefs> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_prefs(
        user_id, lang, digest_hours, last_digest_at, realtime_enabled, updated_at,
        default_backfill_n, quiet_start, quiet_end, post_style, full_text_style,
        global_include_keywords, global_exclude_keywords
      ) VALUES(?, 'fa', 6, 0, 1, ?, 0, -1, -1, 'rich', 'quote', '[]', '[]')`
    )
    .bind(userId, nowSec())
    .run();

  const row = await db
    .prepare(
      `SELECT lang, digest_hours, last_digest_at, realtime_enabled,
              default_backfill_n, quiet_start, quiet_end, post_style, full_text_style,
              global_include_keywords, global_exclude_keywords
       FROM user_prefs WHERE user_id=?`
    )
    .bind(userId)
    .first<any>();

  const lang: Lang = row?.lang === "en" ? "en" : "fa";
  const post_style: PostStyle = row?.post_style === "compact" ? "compact" : "rich";
  const full_text_style = row?.full_text_style === "plain" ? "plain" : "quote";

  return {
    lang,
    digest_hours: Number(row?.digest_hours ?? 6),
    last_digest_at: Number(row?.last_digest_at ?? 0),
    realtime_enabled: Number(row?.realtime_enabled ?? 1),
    default_backfill_n: Number(row?.default_backfill_n ?? 0),
    quiet_start: Number(row?.quiet_start ?? -1),
    quiet_end: Number(row?.quiet_end ?? -1),
    post_style,
    full_text_style,
    global_include_keywords: String(row?.global_include_keywords || "[]"),
    global_exclude_keywords: String(row?.global_exclude_keywords || "[]"),
  };
}

export async function setPrefs(db: D1Database, userId: number, patch: Partial<UserPrefs>) {
  const cur = await ensurePrefs(db, userId);
  const next = { ...cur, ...patch };
  const lang: Lang = next.lang === "en" ? "en" : "fa";
  const post_style: PostStyle = next.post_style === "compact" ? "compact" : "rich";
  const full_text_style = next.full_text_style === "plain" ? "plain" : "quote";

  await db
    .prepare(
      `UPDATE user_prefs SET
        lang=?, digest_hours=?, last_digest_at=?, realtime_enabled=?, updated_at=?,
        default_backfill_n=?, quiet_start=?, quiet_end=?, post_style=?, full_text_style=?,
        global_include_keywords=?, global_exclude_keywords=?
       WHERE user_id=?`
    )
    .bind(
      lang,
      next.digest_hours,
      next.last_digest_at,
      next.realtime_enabled,
      nowSec(),
      clamp(Number(next.default_backfill_n ?? 0), 0, 10),
      Number(next.quiet_start ?? -1),
      Number(next.quiet_end ?? -1),
      post_style,
      full_text_style,
      String(next.global_include_keywords || "[]"),
      String(next.global_exclude_keywords || "[]"),
      userId
    )
    .run();
}

/** ------------------- state ------------------- */
export async function setState(db: D1Database, userId: number, state: string, data: any = null) {
  await db
    .prepare("INSERT OR REPLACE INTO user_state(user_id, state, data, updated_at) VALUES(?, ?, ?, ?)")
    .bind(userId, state, data ? JSON.stringify(data) : null, nowSec())
    .run();
}

export async function getState(db: D1Database, userId: number): Promise<UserState | null> {
  const row = await db.prepare("SELECT state, data FROM user_state WHERE user_id=?").bind(userId).first<any>();
  if (!row) return null;
  return { state: row.state, data: row.data ? JSON.parse(row.data) : null };
}

export async function clearState(db: D1Database, userId: number) {
  await db.prepare("DELETE FROM user_state WHERE user_id=?").bind(userId).run();
}

/** ------------------- sources & subscriptions ------------------- */
export async function ensureSource(db: D1Database, username: string, minPollSec: number) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO sources(username, last_post_id, updated_at, next_check_at, check_every_sec, fail_count, last_error_at, last_success_at)
       VALUES(?, 0, ?, 0, ?, 0, 0, 0)`
    )
    .bind(username, nowSec(), minPollSec)
    .run();
}

export async function countUserSources(db: D1Database, userId: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM user_sources WHERE user_id=?").bind(userId).first<any>();
  return Number(row?.n ?? 0);
}

export async function listUserSources(db: D1Database, userId: number, limit: number, offset: number): Promise<UserSourceRow[]> {
  const rows = await db
    .prepare(
      `SELECT us.username, us.paused, us.mode, us.include_keywords, us.exclude_keywords, us.backfill_n, us.label,
              s.last_post_id
       FROM user_sources us
       LEFT JOIN sources s ON s.username = us.username
       WHERE us.user_id=?
       ORDER BY us.username ASC
       LIMIT ? OFFSET ?`
    )
    .bind(userId, limit, offset)
    .all<any>();

  return (rows.results || []) as UserSourceRow[];
}

export async function getUserSource(db: D1Database, userId: number, username: string): Promise<UserSourceRow | null> {
  return db
    .prepare(
      "SELECT username, paused, mode, include_keywords, exclude_keywords, backfill_n, label FROM user_sources WHERE user_id=? AND lower(username)=lower(?) LIMIT 1"
    )
    .bind(userId, username)
    .first<any>();
}

export async function addUserSource(db: D1Database, userId: number, username: string, backfillN: number) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_sources(
        user_id, username, created_at, paused, mode, include_keywords, exclude_keywords, backfill_n, label
      ) VALUES(?, ?, ?, 0, 'realtime', '[]', '[]', ?, NULL)`
    )
    .bind(userId, username, nowSec(), clamp(backfillN, 0, 10))
    .run();
}

export async function updateUserSourcePaused(db: D1Database, userId: number, username: string, paused: number) {
  await db.prepare("UPDATE user_sources SET paused=? WHERE user_id=? AND username=?").bind(paused ? 1 : 0, userId, username).run();
}

export async function updateUserSourceMode(db: D1Database, userId: number, username: string, mode: ChannelMode) {
  await db.prepare("UPDATE user_sources SET mode=? WHERE user_id=? AND username=?").bind(mode, userId, username).run();
}

export async function updateUserSourceLabel(db: D1Database, userId: number, username: string, label: string | null) {
  await db.prepare("UPDATE user_sources SET label=? WHERE user_id=? AND username=?").bind(label, userId, username).run();
}

export async function updateUserSourceFilters(db: D1Database, userId: number, username: string, include: string[], exclude: string[]) {
  await db
    .prepare("UPDATE user_sources SET include_keywords=?, exclude_keywords=? WHERE user_id=? AND username=?")
    .bind(JSON.stringify(include), JSON.stringify(exclude), userId, username)
    .run();
}

export async function clearUserSourceFilters(db: D1Database, userId: number, username: string) {
  await db.prepare("UPDATE user_sources SET include_keywords='[]', exclude_keywords='[]' WHERE user_id=? AND username=?").bind(userId, username).run();
}

export async function updateUserSourceBackfill(db: D1Database, userId: number, username: string, backfillN: number) {
  await db.prepare("UPDATE user_sources SET backfill_n=? WHERE user_id=? AND username=?").bind(clamp(backfillN, 0, 10), userId, username).run();
}

export async function deleteUserSource(db: D1Database, userId: number, username: string) {
  await db.prepare("DELETE FROM user_sources WHERE user_id=? AND username=?").bind(userId, username).run();
}
