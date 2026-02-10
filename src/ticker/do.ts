import { Env, MediaItem, ScrapedPost, UserPrefs } from "../types";
import { tg, TelegramError } from "../telegram/client";
import { renderDestinationPost, t } from "../telegram/ui";
import { clamp, ensurePrefs, getDestination, markDestinationBad, nowSec, setPrefs } from "../db/repo";
import { fetchTme, scrapeTmePreview } from "../scraper/tme";
import { shouldStoreScrapedPosts } from "../config";

const FIRST_SYNC_LIMIT = 5;

export const MIN_POLL_SEC = 5;
const MAX_POLL_SEC = 240;

const MAX_FETCH_CONCURRENCY = 6;
const MAX_SOURCES_PER_TICK = 30;

const LOCK_NAME = "scrape_tick";
const LOCK_TTL_SEC = 25;

/** ------------------- filters ------------------- */
function safeParseKeywords(raw: any): string[] {
  try {
    if (!raw) return [];
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function textPassesFilters(text: string, include: string[], exclude: string[]) {
  const hay = (text || "").toLowerCase();

  for (const kw of exclude) {
    const k = kw.toLowerCase();
    if (k && hay.includes(k)) return false;
  }
  if (!include.length) return true;

  for (const kw of include) {
    const k = kw.toLowerCase();
    if (k && hay.includes(k)) return true;
  }
  return false;
}

/** ------------------- quiet hours ------------------- */
function utcHourNow(): number {
  return new Date().getUTCHours();
}

function isQuietNow(prefs: { quiet_start: number; quiet_end: number }) {
  const qs = Number(prefs.quiet_start ?? -1);
  const qe = Number(prefs.quiet_end ?? -1);
  if (qs < 0 || qe < 0) return false;

  const h = utcHourNow();
  if (qs === qe) return true;
  if (qs < qe) return h >= qs && h < qe;
  return h >= qs || h < qe;
}

/** ------------------- destination delivery ------------------- */
function safeParseMediaJson(raw: any): MediaItem[] {
  try {
    if (!raw) return [];
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    const out: MediaItem[] = [];
    for (const it of arr) {
      const kind = String(it?.kind || "");
      const url = String(it?.url || "");
      if ((kind === "photo" || kind === "video" || kind === "document") && url) out.push({ kind, url } as MediaItem);
    }
    return out.slice(0, 10);
  } catch {
    return [];
  }
}

function isDestinationAccessError(err: TelegramError) {
  if (err.code === 403) return true;
  if (err.code !== 400) return false;
  const desc = String(err.description || "").toLowerCase();
  const patterns = [
    "chat not found",
    "channel private",
    "not enough rights",
    "need administrator rights",
    "have no rights",
    "bot was kicked",
    "bot was blocked",
    "not a member",
  ];
  return patterns.some((p) => desc.includes(p));
}

async function sendFeedPost(env: Env, destChatId: number, prefs: UserPrefs, username: string, label: string | null, post: ScrapedPost) {
  const link = post.link || `https://t.me/${username}/${post.postId}`;
  const rendered = renderDestinationPost(prefs.post_style, prefs.lang, username, label, post.text, link, nowSec(), {
    fullTextStyle: prefs.full_text_style,
  });

  await tg(env, "sendMessage", {
    chat_id: destChatId,
    text: rendered.text,
    parse_mode: "HTML",
    reply_markup: rendered.reply_markup,
  });
}

export async function deliverRealtime(
  env: Env,
  userId: number,
  destChatId: number,
  username: string,
  label: string | null,
  post: ScrapedPost,
  prefs: UserPrefs
) {
  if (isQuietNow(prefs)) {
    await env.DB
      .prepare("INSERT OR IGNORE INTO queued_realtime(user_id, username, post_id, queued_at) VALUES(?, ?, ?, ?)")
      .bind(userId, username, post.postId, nowSec())
      .run();
    return;
  }

  const lock = await env.DB
    .prepare("INSERT OR IGNORE INTO deliveries(user_id, username, post_id, created_at) VALUES(?, ?, ?, ?)")
    .bind(userId, username, post.postId, nowSec())
    .run();

  if ((lock as any)?.meta?.changes === 0) return;

  try {
    await sendFeedPost(env, destChatId, prefs, username, label, post);
  } catch (e: any) {
    if (e instanceof TelegramError && isDestinationAccessError(e)) {
      await markDestinationBad(env.DB, userId);
    }
    await env.DB.prepare("DELETE FROM deliveries WHERE user_id=? AND username=? AND post_id=?").bind(userId, username, post.postId).run();
    throw e;
  }
}

export async function flushQueuedRealtime(env: Env, userId: number, prefs: UserPrefs) {
  if (isQuietNow(prefs)) return;

  const dest = await getDestination(env.DB, userId);
  if (!dest?.verified) return;

  const rows = await env.DB
    .prepare(
      `SELECT qr.username, qr.post_id, sp.text, sp.link, sp.media_json, us.label
       FROM queued_realtime qr
       LEFT JOIN scraped_posts sp ON sp.username=qr.username AND sp.post_id=qr.post_id
       LEFT JOIN user_sources us ON us.user_id=qr.user_id AND us.username=qr.username
       WHERE qr.user_id=?
       ORDER BY qr.queued_at ASC
       LIMIT 20`
    )
    .bind(userId)
    .all<any>();

  if (!rows.results.length) return;

  for (const r of rows.results) {
    const post: ScrapedPost = {
      postId: Number(r.post_id),
      text: String(r.text || ""),
      link: String(r.link || `https://t.me/${r.username}/${r.post_id}`),
      media: safeParseMediaJson(r.media_json),
    };

    try {
      await deliverRealtime(env, userId, Number(dest.chat_id), String(r.username), r.label ?? null, post, prefs);
      await env.DB.prepare("DELETE FROM queued_realtime WHERE user_id=? AND username=? AND post_id=?").bind(userId, String(r.username), Number(r.post_id)).run();
    } catch {
      break;
    }
  }
}

/** ------------------- digest ------------------- */
function splitTelegramText(text: string, max = 3800): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const block of text.split("\n\n")) {
    if ((cur + (cur ? "\n\n" : "") + block).length <= max) {
      cur = cur ? `${cur}\n\n${block}` : block;
    } else {
      if (cur) parts.push(cur);
      cur = block;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

export async function sendDigestForUser(env: Env, userId: number, force = false) {
  if (!shouldStoreScrapedPosts(env)) return;
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  if (!dest?.verified) return;

  const subs = await env.DB
    .prepare("SELECT username, include_keywords, exclude_keywords FROM user_sources WHERE user_id=? AND mode='digest' AND paused=0")
    .bind(userId)
    .all<any>();

  if (!subs.results.length) return;

  const digestHours = Number(prefs.digest_hours ?? 6);
  const last = Number(prefs.last_digest_at ?? 0);
  const due = force || last === 0 || nowSec() - last >= digestHours * 3600;
  if (!due) return;

  const since = last || nowSec() - digestHours * 3600;

  const items: { username: string; post_id: number; link: string; text: string }[] = [];

  for (const s of subs.results) {
    const u = String(s.username);
    const include = safeParseKeywords(s.include_keywords);
    const exclude = safeParseKeywords(s.exclude_keywords);

    const rows = await env.DB
      .prepare("SELECT username, post_id, link, text FROM scraped_posts WHERE username=? AND scraped_at > ? ORDER BY post_id DESC LIMIT 20")
      .bind(u, since)
      .all<any>();

    for (const r of rows.results) {
      const txt = String(r.text || "");
      if (!textPassesFilters(txt, include, exclude)) continue;
      items.push({ username: String(r.username), post_id: Number(r.post_id), link: String(r.link), text: txt });
    }
  }

  items.sort((a, b) => b.post_id - a.post_id);
  const top = items.slice(0, 25);

  if (!top.length) {
    await setPrefs(env.DB, userId, { last_digest_at: nowSec() });
    return;
  }

  const title = t(prefs.lang, `🧾 خلاصهٔ ${digestHours} ساعت اخیر`, `🧾 Digest for last ${digestHours} hours`);
  const blocks = top.map((it) => {
    const snip = (it.text || "").replace(/\s+/g, " ").slice(0, 180);
    return `@${it.username}\n${it.link}${snip ? `\n${snip}` : ""}`;
  });

  const full = `${title}\n\n${blocks.join("\n\n")}`;
  const parts = splitTelegramText(full, 3800);

  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.length > 1 ? `\n\n(${i + 1}/${parts.length})` : "";
    await tg(env, "sendMessage", { chat_id: Number(dest.chat_id), text: (parts[i] + suffix).slice(0, 3900), disable_web_page_preview: true });
  }

  await setPrefs(env.DB, userId, { last_digest_at: nowSec() });
}

/** ------------------- locks ------------------- */
async function acquireTickLock(db: D1Database): Promise<boolean> {
  const now = nowSec();
  const ins = await db.prepare("INSERT OR IGNORE INTO locks(name, acquired_at) VALUES(?, ?)").bind(LOCK_NAME, now).run();
  if ((ins as any)?.meta?.changes === 1) return true;

  const row = await db.prepare("SELECT acquired_at FROM locks WHERE name=?").bind(LOCK_NAME).first<any>();
  const acquiredAt = Number(row?.acquired_at ?? 0);

  if (!acquiredAt || now - acquiredAt > LOCK_TTL_SEC) {
    const upd = await db.prepare("UPDATE locks SET acquired_at=? WHERE name=? AND acquired_at=?").bind(now, LOCK_NAME, acquiredAt).run();
    if ((upd as any)?.meta?.changes === 1) return true;
  }
  return false;
}

async function releaseTickLock(db: D1Database) {
  await db.prepare("DELETE FROM locks WHERE name=?").bind(LOCK_NAME).run();
}

/** ------------------- tick work ------------------- */
async function pMapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runScrapeTick(env: Env) {
  const storeScraped = shouldStoreScrapedPosts(env);
  const due = await env.DB
    .prepare(
      `SELECT s.username, s.last_post_id, s.check_every_sec, s.fail_count
       FROM sources s
       JOIN (SELECT DISTINCT username FROM user_sources) u ON u.username=s.username
       WHERE s.next_check_at <= ?
       ORDER BY s.next_check_at ASC
       LIMIT ?`
    )
    .bind(nowSec(), MAX_SOURCES_PER_TICK)
    .all<any>();

  const dueSources = due.results || [];

  await pMapLimit(dueSources, MAX_FETCH_CONCURRENCY, async (row) => {
    const username = String(row.username);
    const lastSeen = Number(row.last_post_id ?? 0);
    const curEvery = clamp(Number(row.check_every_sec ?? MIN_POLL_SEC), MIN_POLL_SEC, MAX_POLL_SEC);
    const failCount = Number(row.fail_count ?? 0);

    try {
      const html = await fetchTme(username);
      const posts = scrapeTmePreview(username, html);
      if (!posts.length) throw new Error("no posts parsed");

      let newPosts = posts.filter((p) => p.postId > lastSeen);
      if (lastSeen === 0 && newPosts.length > FIRST_SYNC_LIMIT) newPosts = newPosts.slice(-FIRST_SYNC_LIMIT);

      if (storeScraped && newPosts.length) {
        for (const p of newPosts) {
          await env.DB
            .prepare("INSERT OR IGNORE INTO scraped_posts(username, post_id, text, link, media_json, scraped_at) VALUES(?, ?, ?, ?, ?, ?)")
            .bind(username, p.postId, p.text || "", p.link, JSON.stringify(p.media || []), nowSec())
            .run();
        }
      }

      if (newPosts.length) {
        const subs = await env.DB
          .prepare(
            `SELECT us.user_id, d.chat_id AS dest_chat_id, us.paused, us.mode, us.include_keywords, us.exclude_keywords, us.label
             FROM user_sources us
             JOIN destinations d ON d.user_id = us.user_id
             WHERE us.username=? AND d.verified=1`
          )
          .bind(username)
          .all<any>();

        for (const post of newPosts) {
          for (const s of subs.results) {
            const userId = Number(s.user_id);
            const destChatId = Number(s.dest_chat_id);

            if (Number(s.paused) === 1) continue;
            if (String(s.mode) !== "realtime") continue;

            const prefs = await ensurePrefs(env.DB, userId);
            if (!prefs.realtime_enabled) continue;

            const include = safeParseKeywords(s.include_keywords);
            const exclude = safeParseKeywords(s.exclude_keywords);
            if (!textPassesFilters(post.text || "", include, exclude)) continue;

            await deliverRealtime(env, userId, destChatId, username, s.label ?? null, post, prefs).catch(() => {});
          }
        }
      }

      const maxId = (newPosts.length ? newPosts[newPosts.length - 1].postId : lastSeen) || 0;
      const nextEvery = newPosts.length ? MIN_POLL_SEC : clamp(Math.round(curEvery * 1.6), MIN_POLL_SEC, MAX_POLL_SEC);
      const nextAt = nowSec() + nextEvery;

      await env.DB
        .prepare(
          `UPDATE sources SET
             last_post_id=?, updated_at=?, next_check_at=?, check_every_sec=?,
             fail_count=0, last_error=NULL, last_error_at=0, last_success_at=?
           WHERE username=?`
        )
        .bind(maxId, nowSec(), nextAt, nextEvery, nowSec(), username)
        .run();
    } catch (e: any) {
      const msg = String(e?.message || e);
      const nextEvery = clamp(Math.round(curEvery * 2), MIN_POLL_SEC, MAX_POLL_SEC);
      const nextAt = nowSec() + nextEvery;

      await env.DB
        .prepare(
          `UPDATE sources SET
             updated_at=?, next_check_at=?, check_every_sec=?,
             fail_count=?, last_error=?, last_error_at=?
           WHERE username=?`
        )
        .bind(nowSec(), nextAt, nextEvery, failCount + 1, msg.slice(0, 250), nowSec(), username)
        .run();
    }
  });

  const queuedUsers = await env.DB.prepare("SELECT DISTINCT user_id FROM queued_realtime").all<any>();
  for (const r of queuedUsers.results || []) {
    const userId = Number(r.user_id);
    const prefs = await ensurePrefs(env.DB, userId);
    await flushQueuedRealtime(env, userId, prefs).catch(() => {});
  }

  if (storeScraped) {
    const digestUsers = await env.DB.prepare("SELECT DISTINCT user_id FROM user_sources WHERE mode='digest' AND paused=0").all<any>();
    for (const r of digestUsers.results || []) {
      await sendDigestForUser(env, Number(r.user_id), false).catch(() => {});
    }
  }
}

export async function runScrapeTickLocked(env: Env) {
  const got = await acquireTickLock(env.DB);
  if (!got) return;
  try {
    await runScrapeTick(env);
  } finally {
    await releaseTickLock(env.DB);
  }
}
