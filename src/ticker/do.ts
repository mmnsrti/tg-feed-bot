import { Env, MediaItem, ScrapedPost, UserPrefs } from "../types";
import { tg, TelegramError } from "../telegram/client";
import { renderDestinationPost, t } from "../telegram/ui";
import { clamp, ensurePrefs, ensureSource, getDestination, markDestinationBad, nowSec, setPrefs } from "../db/repo";
import { fetchTme, scrapeTmePreview } from "../scraper/tme";
import { shouldStoreScrapedPosts } from "../config";

const FIRST_SYNC_LIMIT = 5;

export const MIN_POLL_SEC = 5;
const MAX_POLL_SEC = 240;

const MAX_FETCH_CONCURRENCY = 6;
const MAX_SOURCES_PER_TICK = 30;

type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

type SourceState = {
  last_post_id: number;
  check_every_sec: number;
  next_check_at: number;
  fail_count: number;
  last_error: string | null;
  last_error_at: number;
  last_success_at: number;
  updated_at: number;
  last_db_sync_at: number;
};

const SOURCE_STATE_PREFIX = "src:";
const SOURCE_SYNC_INTERVAL_SEC = 15 * 60;

function sourceKey(username: string) {
  return `${SOURCE_STATE_PREFIX}${username}`;
}

function buildBaseState(row: any, now: number): SourceState {
  const checkEvery = clamp(Number(row?.check_every_sec ?? MIN_POLL_SEC), MIN_POLL_SEC, MAX_POLL_SEC);
  const updatedAt = Number(row?.updated_at ?? 0);
  return {
    last_post_id: Number(row?.last_post_id ?? 0),
    check_every_sec: checkEvery,
    next_check_at: Number(row?.next_check_at ?? 0),
    fail_count: Number(row?.fail_count ?? 0),
    last_error: row?.last_error ? String(row.last_error) : null,
    last_error_at: Number(row?.last_error_at ?? 0),
    last_success_at: Number(row?.last_success_at ?? 0),
    updated_at: updatedAt || now,
    last_db_sync_at: updatedAt || 0,
  };
}

async function getOrInitSourceState(storage: StorageLike, username: string, base: SourceState): Promise<SourceState> {
  const key = sourceKey(username);
  const existing = await storage.get<SourceState>(key);
  if (existing) return existing;
  await storage.put(key, base);
  return base;
}

async function maybeSyncSourceToDb(env: Env, username: string, state: SourceState, now: number) {
  if (now - state.last_db_sync_at < SOURCE_SYNC_INTERVAL_SEC) return state;

  await env.DB
    .prepare(
      `UPDATE sources SET
         last_post_id=?, updated_at=?, next_check_at=?, check_every_sec=?,
         fail_count=?, last_error=?, last_error_at=?, last_success_at=?
       WHERE username=?`
    )
    .bind(
      state.last_post_id,
      now,
      state.next_check_at,
      state.check_every_sec,
      state.fail_count,
      state.last_error,
      state.last_error_at,
      state.last_success_at,
      username
    )
    .run();

  return { ...state, last_db_sync_at: now, updated_at: now };
}


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
      const kind = String(it?.kind || "document").trim().toLowerCase();
      const url = String(it?.url || "");
      if (url) out.push({ kind: kind || "document", url });
    }
    return out;
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

function parseGeoCoords(raw: string): { latitude: number; longitude: number } | null {
  const s = String(raw || "").trim();
  if (!s) return null;

  const toNum = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const safeDecode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };

  const geo = /^geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  if (geo) {
    const latitude = toNum(geo[1]);
    const longitude = toNum(geo[2]);
    if (latitude !== null && longitude !== null) return { latitude, longitude };
  }

  try {
    const u = new URL(s);
    const keysLat = ["lat", "latitude"];
    const keysLon = ["lon", "lng", "longitude"];
    let latitude: number | null = null;
    let longitude: number | null = null;
    for (const k of keysLat) {
      const v = u.searchParams.get(k);
      if (v != null) {
        latitude = toNum(v);
        if (latitude !== null) break;
      }
    }
    for (const k of keysLon) {
      const v = u.searchParams.get(k);
      if (v != null) {
        longitude = toNum(v);
        if (longitude !== null) break;
      }
    }
    if (latitude !== null && longitude !== null) return { latitude, longitude };

    const q = u.searchParams.get("q") || u.searchParams.get("query") || "";
    const qm = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(safeDecode(q));
    if (qm) {
      latitude = toNum(qm[1]);
      longitude = toNum(qm[2]);
      if (latitude !== null && longitude !== null) return { latitude, longitude };
    }

    const ll = u.searchParams.get("ll") || "";
    const llm = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(safeDecode(ll));
    if (llm) {
      // Some map providers use ll=lon,lat.
      longitude = toNum(llm[1]);
      latitude = toNum(llm[2]);
      if (latitude !== null && longitude !== null) return { latitude, longitude };
    }

    const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(u.pathname + u.hash);
    if (at) {
      latitude = toNum(at[1]);
      longitude = toNum(at[2]);
      if (latitude !== null && longitude !== null) return { latitude, longitude };
    }
  } catch {}

  const rawPair =
    /(geo:|map|maps|location|venue|lat|lon|lng|ll=|q=)/i.test(s) ? /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(s) : null;
  if (rawPair) {
    const latitude = toNum(rawPair[1]);
    const longitude = toNum(rawPair[2]);
    if (latitude !== null && longitude !== null) return { latitude, longitude };
  }

  return null;
}

function mediaSendSpec(kind: MediaItem["kind"]): { method: string; field: string } {
  const k = String(kind || "").trim().toLowerCase();
  if (k === "source_copy") return { method: "", field: "" };
  if (k === "photo" || k === "image") return { method: "sendPhoto", field: "photo" };
  if (k === "video") return { method: "sendVideo", field: "video" };
  if (k === "audio" || k === "music") return { method: "sendAudio", field: "audio" };
  if (k === "voice" || k === "voice_note") return { method: "sendVoice", field: "voice" };
  if (k === "animation" || k === "gif") return { method: "sendAnimation", field: "animation" };
  if (k === "sticker") return { method: "sendSticker", field: "sticker" };
  if (k === "video_note" || k === "round_video" || k === "videonote") return { method: "sendVideoNote", field: "video_note" };
  return { method: "sendDocument", field: "document" };
}

async function sendFallbackMedia(env: Env, destChatId: number, media: MediaItem[]) {
  let sent = 0;
  for (const item of media || []) {
    const k = String(item.kind || "").trim().toLowerCase();
    if (k === "location" || k === "venue") {
      const geo = parseGeoCoords(item.url);
      if (!geo) continue;
      try {
        await tg(env, "sendLocation", { chat_id: destChatId, latitude: geo.latitude, longitude: geo.longitude });
        sent += 1;
      } catch {}
      continue;
    }

    const { method, field } = mediaSendSpec(k);
    if (!method || !field) continue;
    try {
      await tg(env, method, { chat_id: destChatId, [field]: item.url });
      sent += 1;
    } catch {
      // Retry as generic document when specific media endpoint rejects the URL.
      if (method !== "sendDocument") {
        try {
          await tg(env, "sendDocument", { chat_id: destChatId, document: item.url });
          sent += 1;
        } catch {}
      }
    }
  }
  return sent > 0;
}

async function sendFeedPost(env: Env, destChatId: number, prefs: UserPrefs, username: string, label: string | null, post: ScrapedPost) {
  const link = post.link || `https://t.me/${username}/${post.postId}`;
  const rendered = renderDestinationPost(prefs.post_style, prefs.lang, username, label, post.text, link, {
    fullTextStyle: prefs.full_text_style,
    destinationChatId: destChatId,
  });
  const hasMedia = Array.isArray(post.media) && post.media.length > 0;
  const shouldTryNativeCopy = hasMedia || !(post.text || "").trim();

  if (shouldTryNativeCopy) {
    try {
      // Prefer copying the original Telegram post so media and formatting stay intact.
      await tg(env, "copyMessage", {
        chat_id: destChatId,
        from_chat_id: `@${username}`,
        message_id: Number(post.postId),
        reply_markup: rendered.reply_markup,
      });
      return;
    } catch (e: any) {
      // Preserve destination access failures for caller handling; fallback only for source/copy limitations.
      if (e instanceof TelegramError && isDestinationAccessError(e)) throw e;
    }

    try {
      // Some message types/channels may fail copy but still allow forwarding as-is.
      const forwarded = await tg(env, "forwardMessage", {
        chat_id: destChatId,
        from_chat_id: `@${username}`,
        message_id: Number(post.postId),
      });
      const forwardedId = Number(forwarded?.message_id || 0);
      let markupAttached = false;
      if (forwardedId > 0) {
        try {
          await tg(env, "editMessageReplyMarkup", {
            chat_id: destChatId,
            message_id: forwardedId,
            reply_markup: rendered.reply_markup,
          });
          markupAttached = true;
        } catch {}
      }
      if (!markupAttached) {
        await tg(env, "sendMessage", {
          chat_id: destChatId,
          text: rendered.text,
          parse_mode: "HTML",
          reply_markup: rendered.reply_markup,
          link_preview_options: { is_disabled: true },
        });
      }
      return;
    } catch (e: any) {
      if (e instanceof TelegramError && isDestinationAccessError(e)) throw e;
    }
  }

  const sentFallbackMedia = hasMedia ? await sendFallbackMedia(env, destChatId, post.media) : false;

  const shouldShowLinkPreview = hasMedia && !sentFallbackMedia;

  await tg(env, "sendMessage", {
    chat_id: destChatId,
    text: rendered.text,
    parse_mode: "HTML",
    reply_markup: rendered.reply_markup,
    // Text-only posts stay plain; preview is used only when this post has media and none was sent directly.
    link_preview_options: shouldShowLinkPreview
      ? { is_disabled: false, show_above_text: true, url: link }
      : { is_disabled: true },
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

export async function runScrapeTick(env: Env, storage: StorageLike) {
  const storeScraped = shouldStoreScrapedPosts(env);
  const now = nowSec();

  const rows = await env.DB
    .prepare(
      `SELECT DISTINCT us.username,
              s.last_post_id, s.check_every_sec, s.next_check_at, s.fail_count,
              s.last_error, s.last_error_at, s.last_success_at, s.updated_at
       FROM user_sources us
       LEFT JOIN sources s ON s.username = us.username`
    )
    .all<any>();

  const due: { username: string; state: SourceState }[] = [];

  for (const row of rows.results || []) {
    const username = String(row.username || "");
    if (!username) continue;

    const hasSourceRow = row.last_post_id !== null && row.check_every_sec !== null && row.next_check_at !== null;
    if (!hasSourceRow) {
      await ensureSource(env.DB, username, MIN_POLL_SEC);
    }

    const base = buildBaseState(row, now);
    const state = await getOrInitSourceState(storage, username, base);
    if (state.next_check_at <= now) due.push({ username, state });
  }

  due.sort((a, b) => a.state.next_check_at - b.state.next_check_at);
  const dueSources = due.slice(0, MAX_SOURCES_PER_TICK);

  await pMapLimit(dueSources, MAX_FETCH_CONCURRENCY, async ({ username, state }) => {
    const lastSeen = Number(state.last_post_id ?? 0);
    const curEvery = clamp(Number(state.check_every_sec ?? MIN_POLL_SEC), MIN_POLL_SEC, MAX_POLL_SEC);
    const failCount = Number(state.fail_count ?? 0);

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

      let nextState: SourceState = {
        ...state,
        last_post_id: maxId,
        check_every_sec: nextEvery,
        next_check_at: nextAt,
        fail_count: 0,
        last_error: null,
        last_error_at: 0,
        last_success_at: nowSec(),
        updated_at: nowSec(),
      };

      nextState = await maybeSyncSourceToDb(env, username, nextState, nowSec());
      await storage.put(sourceKey(username), nextState);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const nextEvery = clamp(Math.round(curEvery * 2), MIN_POLL_SEC, MAX_POLL_SEC);
      const nextAt = nowSec() + nextEvery;

      let nextState: SourceState = {
        ...state,
        check_every_sec: nextEvery,
        next_check_at: nextAt,
        fail_count: failCount + 1,
        last_error: msg.slice(0, 250),
        last_error_at: nowSec(),
        updated_at: nowSec(),
      };

      nextState = await maybeSyncSourceToDb(env, username, nextState, nowSec());
      await storage.put(sourceKey(username), nextState);
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

// NOTE: locking is handled by Durable Object storage in src/index.ts
