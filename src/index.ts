/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";

type Env = {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_KEY?: string;
  TICKER: DurableObjectNamespace;
};

type TgUpdate = any;
type Lang = "fa" | "en";

type MediaKind = "photo" | "video" | "document";
type MediaItem = { kind: MediaKind; url: string };

type ScrapedPost = {
  postId: number;
  text: string;
  link: string;
  media: MediaItem[];
};

const app = new Hono<{ Bindings: Env }>();

/** ------------------- constants ------------------- */
const TME_BASE = "https://t.me/s/";
const FIRST_SYNC_LIMIT = 5;

const TICK_MS = 5000;
const LOCK_NAME = "scrape_tick";
const LOCK_TTL_SEC = 25;

const MAX_FETCH_CONCURRENCY = 6;
const MAX_SOURCES_PER_TICK = 30;

const MIN_POLL_SEC = 5;
const MAX_POLL_SEC = 240;

const LIST_PAGE_SIZE = 8;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function utcHourNow(): number {
  return new Date().getUTCHours();
}

function truncate(s: string, max: number) {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

/** ------------------- i18n ------------------- */
function t(lang: Lang, fa: string, en: string) {
  return lang === "fa" ? fa : en;
}

function S(lang: Lang) {
  return {
    title: t(lang, "📡 فید کانال‌ها", "📡 Channel Feeds"),
    homeHint: t(lang, "از دکمه‌ها استفاده کن 👇", "Use the buttons below 👇"),

    setDest: t(lang, "🎯 تنظیم کانال مقصد", "🎯 Set Destination"),
    addChannel: t(lang, "➕ افزودن کانال", "➕ Add Channel"),
    myChannels: t(lang, "📋 کانال‌های من", "📋 My Channels"),
    settings: t(lang, "⚙️ تنظیمات", "⚙️ Settings"),
    help: t(lang, "❓ راهنما", "❓ Help"),

    back: t(lang, "⬅️ برگشت", "⬅️ Back"),
    cancel: t(lang, "✖️ لغو", "✖️ Cancel"),

    language: t(lang, "🌐 زبان", "🌐 Language"),
    realtime: t(lang, "⚡ ریل‌تایم", "⚡ Realtime"),
    digest: t(lang, "🧾 خلاصه", "🧾 Digest"),
    quiet: t(lang, "🌙 ساعت سکوت", "🌙 Quiet Hours"),
    defaultBackfill: t(lang, "📌 بک‌فیل پیش‌فرض", "📌 Default Backfill"),
    testDelivery: t(lang, "✅ تست ارسال", "✅ Test Delivery"),

    realtimeOn: t(lang, "روشن ✅", "ON ✅"),
    realtimeOff: t(lang, "خاموش ❌", "OFF ❌"),

    openOriginal: t(lang, "🔗 پست اصلی", "🔗 Original post"),
    openChannel: t(lang, "📣 کانال", "📣 Channel"),
    noText: t(lang, "(بدون متن)", "(no text)"),

    needDestFirst: t(lang, "⚠️ اول کانال مقصد را تنظیم کن.", "⚠️ Set destination first."),
    sendUsername: t(lang, "نام کاربری یا لینک کانال عمومی را بفرست:\nمثلاً @khabarfuri", "Send a public channel username/link:\nExample: @khabarfuri"),
    invalidFormat: t(lang, "فرمت اشتباه است. مثل @name بفرست.", "Invalid format. Send @name."),
    fetchFailed: t(lang, "الان نتونستم دریافت کنم. چند دقیقه دیگه امتحان کن.", "Fetch failed. Try again in a minute."),
    couldntRead: (u: string) => t(lang, `از @${u} چیزی نتونستم بخونم. عمومی هست؟`, `Couldn’t read @${u}. Is it public?`),

    followed: (u: string, n: number) => t(lang, `✅ @${u} اضافه شد. (${n} پست آخر ارسال شد)`, `✅ Followed @${u}. (Sent last ${n} posts)`),
    followedNoRealtime: (u: string) => t(lang, `✅ @${u} اضافه شد. (ریل‌تایم خاموش است؛ فقط خلاصه)`, `✅ Followed @${u}. (Realtime is OFF; digest only)`),

    helpText: t(
      lang,
      [
        "❓ راهنما",
        "",
        "✅ این ربات پست‌های کانال‌های عمومی را خوانده و داخل کانال مقصد شما ارسال می‌کند.",
        "",
        "⚡ ریل‌تایم: هر پست جدید سریع ارسال می‌شود.",
        "🧾 خلاصه: هر X ساعت یک پیام خلاصه ارسال می‌شود.",
        "",
        "📌 پست‌ها طوری ارسال می‌شوند که داخل تلگرام متن کامل را ببینی (بدون نیاز به رفتن به لینک).",
      ].join("\n"),
      [
        "❓ Help",
        "",
        "✅ This bot reads public channels and posts them into your destination channel.",
        "",
        "⚡ Realtime: new posts are sent quickly.",
        "🧾 Digest: a summary is sent every X hours.",
        "",
        "📌 Posts are formatted so you can read them inside Telegram (no need to open the original link).",
      ].join("\n")
    ),

    settingsText: (rt: number, dh: number, qs: number, qe: number, dbf: number) => {
      const quiet = qs < 0 || qe < 0 ? t(lang, "خاموش", "OFF") : `${qs}:00 → ${qe}:00 (UTC)`;
      return [
        t(lang, "⚙️ تنظیمات", "⚙️ Settings"),
        "",
        `${t(lang, "⚡ ریل‌تایم:", "⚡ Realtime:")} ${rt ? t(lang, "روشن", "ON") : t(lang, "خاموش", "OFF")}`,
        `${t(lang, "🧾 بازه خلاصه:", "🧾 Digest interval:")} ${dh} ${t(lang, "ساعت", "hours")}`,
        `${t(lang, "🌙 ساعت سکوت:", "🌙 Quiet hours:")} ${quiet}`,
        `${t(lang, "📌 بک‌فیل پیش‌فرض:", "📌 Default backfill:")} ${dbf}`,
      ].join("\n");
    },

    destTitle: t(lang, "🎯 تنظیم کانال مقصد", "🎯 Set Destination"),
    destSteps: t(
      lang,
      "1) یک کانال مقصد بساز\n2) ربات را ادمین کن\n3) همین خط را داخل کانال ارسال کن:",
      "1) Create a destination channel\n2) Add the bot as admin\n3) Post this line in the channel:"
    ),
    copyHint: t(lang, "روی متن کادر لمس طولانی کن تا کپی شود.", "Long-press the code block to copy."),

    digestAskHours: t(lang, "عدد بازه خلاصه را بفرست (۱ تا ۲۴).", "Send digest interval in hours (1..24)."),
    invalidNumber: t(lang, "عدد معتبر نیست.", "Invalid number."),
    quietAsk: t(
      lang,
      "برای تنظیم ساعت سکوت (UTC):\nمثال: 1 8\nبرای خاموش کردن: off",
      "Set quiet hours (UTC):\nExample: 1 8\nDisable: off"
    ),
    backfillAsk: t(lang, "عدد بک‌فیل پیش‌فرض را بفرست (۰ تا ۱۰).", "Send default backfill (0..10)."),

    chSettingsTitle: (u: string) => t(lang, `⚙️ تنظیمات @${u}`, `⚙️ Settings @${u}`),
    pause: t(lang, "⏸ توقف", "⏸ Pause"),
    resume: t(lang, "▶️ ادامه", "▶️ Resume"),
    modeRealtime: t(lang, "⚡ ریل‌تایم", "⚡ Realtime"),
    modeDigest: t(lang, "🧾 خلاصه", "🧾 Digest"),
    filters: t(lang, "🔎 فیلترها", "🔎 Filters"),
    backfill: t(lang, "📌 بک‌فیل", "📌 Backfill"),
    unfollow: t(lang, "🗑 حذف", "🗑 Unfollow"),

    setInclude: t(lang, "➕ شامل", "➕ Include"),
    setExclude: t(lang, "➖ حذف", "➖ Exclude"),
    clearFilters: t(lang, "🧹 پاک کردن فیلترها", "🧹 Clear filters"),
    incPrompt: (u: string) => t(lang, `کلمات شامل برای @${u} را بفرست (با کاما جدا کن).`, `Send include keywords for @${u} (comma-separated).`),
    excPrompt: (u: string) => t(lang, `کلمات حذف برای @${u} را بفرست (با کاما جدا کن).`, `Send exclude keywords for @${u} (comma-separated).`),

    testOk: t(lang, "✅ تست ارسال انجام شد.", "✅ Delivery test succeeded."),
  };
}

/** ------------------- Telegram helpers ------------------- */
class TelegramError extends Error {
  code: number;
  description: string;
  parameters?: any;
  constructor(code: number, description: string, parameters?: any) {
    super(`TelegramError ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

async function tg(env: Env, method: string, params: Record<string, any>, tries = 3): Promise<any> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await res.json();

  if (data.ok) return data.result;

  const retryAfter = data?.parameters?.retry_after;
  if (data.error_code === 429 && retryAfter && tries > 0) {
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + 250));
    return tg(env, method, params, tries - 1);
  }

  throw new TelegramError(Number(data.error_code || 0), String(data.description || "Unknown error"), data.parameters);
}

function parseCmd(text: string) {
  if (!text?.startsWith("/")) return null;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

function makeToken() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function normalizeUsername(input: string) {
  let s = (input || "").trim();
  if (!s) return null;

  s = s.replace(/^https?:\/\/t\.me\/s\//i, "");
  s = s.replace(/^https?:\/\/t\.me\//i, "");
  s = s.replace(/^t\.me\/s\//i, "");
  s = s.replace(/^t\.me\//i, "");
  if (s.startsWith("@")) s = s.slice(1);

  if (!/^[A-Za-z0-9_]{5,32}$/.test(s)) return null;
  return s;
}

function escapeHtml(s: string) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ------------------- DB auto-upgrade (safe) ------------------- */
async function ensureDbUpgrades(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS meta_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();

  const row = await db.prepare("SELECT value FROM meta_kv WHERE key='schema_v'").first<any>();
  const v = Number(row?.value ?? 0);
  if (v >= 2) return;

  // v1 changes
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

      "ALTER TABLE user_sources ADD COLUMN backfill_n INTEGER NOT NULL DEFAULT 3",

      "ALTER TABLE user_prefs ADD COLUMN default_backfill_n INTEGER NOT NULL DEFAULT 3",
      "ALTER TABLE user_prefs ADD COLUMN quiet_start INTEGER NOT NULL DEFAULT -1",
      "ALTER TABLE user_prefs ADD COLUMN quiet_end INTEGER NOT NULL DEFAULT -1",
    ];

    for (const q of altersV1) {
      try {
        await db.prepare(q).run();
      } catch {}
    }
  }

  // v2: media_json (kept for storage, even though we now only link-preview)
  if (v < 2) {
    try {
      await db.prepare("ALTER TABLE scraped_posts ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]'").run();
    } catch {}
  }

  await db.prepare("INSERT OR REPLACE INTO meta_kv(key, value) VALUES('schema_v', '2')").run();
}

/** ------------------- DB helpers ------------------- */
async function upsertUser(db: D1Database, userId: number) {
  await db.prepare("INSERT OR IGNORE INTO users(user_id, created_at) VALUES(?, ?)").bind(userId, nowSec()).run();
}

async function getDestination(db: D1Database, userId: number) {
  return db.prepare("SELECT chat_id, verified FROM destinations WHERE user_id=?").bind(userId).first<any>();
}

async function ensurePrefs(db: D1Database, userId: number) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_prefs(
        user_id, lang, digest_hours, last_digest_at, realtime_enabled, updated_at,
        default_backfill_n, quiet_start, quiet_end
      ) VALUES(?, 'fa', 6, 0, 1, ?, 3, -1, -1)`
    )
    .bind(userId, nowSec())
    .run();

  const row = await db
    .prepare(
      `SELECT lang, digest_hours, last_digest_at, realtime_enabled,
              default_backfill_n, quiet_start, quiet_end
       FROM user_prefs WHERE user_id=?`
    )
    .bind(userId)
    .first<any>();

  return {
    lang: (row?.lang as Lang) || "fa",
    digest_hours: Number(row?.digest_hours ?? 6),
    last_digest_at: Number(row?.last_digest_at ?? 0),
    realtime_enabled: Number(row?.realtime_enabled ?? 1),
    default_backfill_n: Number(row?.default_backfill_n ?? 3),
    quiet_start: Number(row?.quiet_start ?? -1),
    quiet_end: Number(row?.quiet_end ?? -1),
  };
}

async function setPrefs(
  db: D1Database,
  userId: number,
  patch: Partial<{
    lang: Lang;
    digest_hours: number;
    last_digest_at: number;
    realtime_enabled: number;
    default_backfill_n: number;
    quiet_start: number;
    quiet_end: number;
  }>
) {
  const cur = await ensurePrefs(db, userId);
  const next = { ...cur, ...patch };
  await db
    .prepare(
      `UPDATE user_prefs SET
        lang=?, digest_hours=?, last_digest_at=?, realtime_enabled=?, updated_at=?,
        default_backfill_n=?, quiet_start=?, quiet_end=?
       WHERE user_id=?`
    )
    .bind(
      next.lang,
      next.digest_hours,
      next.last_digest_at,
      next.realtime_enabled,
      nowSec(),
      clamp(Number(next.default_backfill_n ?? 3), 0, 10),
      Number(next.quiet_start ?? -1),
      Number(next.quiet_end ?? -1),
      userId
    )
    .run();
}

/** ------------------- state ------------------- */
async function setState(db: D1Database, userId: number, state: string, data: any = null) {
  await db
    .prepare("INSERT OR REPLACE INTO user_state(user_id, state, data, updated_at) VALUES(?, ?, ?, ?)")
    .bind(userId, state, data ? JSON.stringify(data) : null, nowSec())
    .run();
}

async function getState(db: D1Database, userId: number): Promise<{ state: string; data: any } | null> {
  const row = await db.prepare("SELECT state, data FROM user_state WHERE user_id=?").bind(userId).first<any>();
  if (!row) return null;
  return { state: row.state, data: row.data ? JSON.parse(row.data) : null };
}

async function clearState(db: D1Database, userId: number) {
  await db.prepare("DELETE FROM user_state WHERE user_id=?").bind(userId).run();
}

/** ------------------- UI helpers ------------------- */
async function sendOrEdit(env: Env, opts: { chat_id: number; text: string; reply_markup?: any; parse_mode?: "HTML"; disable_web_page_preview?: boolean; message_id?: number }) {
  if (opts.message_id) {
    try {
      return await tg(env, "editMessageText", {
        chat_id: opts.chat_id,
        message_id: opts.message_id,
        text: opts.text,
        reply_markup: opts.reply_markup,
        parse_mode: opts.parse_mode,
        disable_web_page_preview: opts.disable_web_page_preview,
      });
    } catch {}
  }
  return tg(env, "sendMessage", {
    chat_id: opts.chat_id,
    text: opts.text,
    reply_markup: opts.reply_markup,
    parse_mode: opts.parse_mode,
    disable_web_page_preview: opts.disable_web_page_preview,
  });
}

/** ------------------- keyboards ------------------- */
function backKb(lang: Lang, data = "m:home") {
  const s = S(lang);
  return { inline_keyboard: [[{ text: s.back, callback_data: data }]] };
}
function cancelKb(lang: Lang) {
  const s = S(lang);
  return { inline_keyboard: [[{ text: s.cancel, callback_data: "m:cancel" }]] };
}

function homeKb(lang: Lang, hasDest: boolean) {
  const s = S(lang);
  const rows: any[] = [];

  if (!hasDest) {
    rows.push([{ text: s.setDest, callback_data: "m:newdest" }]);
    rows.push([{ text: s.help, callback_data: "m:help" }]);
    rows.push([{ text: s.settings, callback_data: "m:settings" }]);
    return { inline_keyboard: rows };
  }

  rows.push([
    { text: s.addChannel, callback_data: "m:follow" },
    { text: s.myChannels, callback_data: "m:list:0" },
  ]);
  rows.push([{ text: s.settings, callback_data: "m:settings" }]);
  rows.push([{ text: s.help, callback_data: "m:help" }]);
  return { inline_keyboard: rows };
}

function settingsKb(lang: Lang, prefs: any, hasDest: boolean) {
  const s = S(lang);
  const rows: any[] = [];

  rows.push([
    { text: s.language, callback_data: "set:lang" },
    { text: `${s.realtime}: ${prefs.realtime_enabled ? s.realtimeOn : s.realtimeOff}`, callback_data: "set:rt" },
  ]);

  rows.push([{ text: s.digest, callback_data: "set:digest" }]);
  rows.push([{ text: s.quiet, callback_data: "set:quiet" }]);
  rows.push([{ text: s.defaultBackfill, callback_data: "set:dbf" }]);

  if (hasDest) rows.push([{ text: s.testDelivery, callback_data: "set:test" }]);

  rows.push([{ text: s.back, callback_data: "m:home" }]);
  return { inline_keyboard: rows };
}

function channelKb(lang: Lang, u: string, paused: number, mode: string) {
  const s = S(lang);
  const pauseBtn = paused ? { text: s.resume, callback_data: `c:resume:${u}` } : { text: s.pause, callback_data: `c:pause:${u}` };
  const modeBtn = mode === "digest" ? { text: s.modeRealtime, callback_data: `c:mode:realtime:${u}` } : { text: s.modeDigest, callback_data: `c:mode:digest:${u}` };

  return {
    inline_keyboard: [
      [pauseBtn, modeBtn],
      [{ text: s.filters, callback_data: `f:menu:${u}` }, { text: s.backfill, callback_data: `bf:menu:${u}` }],
      [{ text: s.unfollow, callback_data: `c:unfollow:${u}` }],
      [{ text: s.back, callback_data: "m:list:0" }],
    ],
  };
}

function filtersKb(lang: Lang, u: string) {
  const s = S(lang);
  return {
    inline_keyboard: [
      [{ text: s.setInclude, callback_data: `f:set_inc:${u}` }, { text: s.setExclude, callback_data: `f:set_exc:${u}` }],
      [{ text: s.clearFilters, callback_data: `f:clear:${u}` }],
      [{ text: s.back, callback_data: `m:channel:${u}` }],
    ],
  };
}

function backfillKb(lang: Lang, u: string) {
  const s = S(lang);
  return {
    inline_keyboard: [
      [
        { text: "0", callback_data: `bf:set:${u}:0` },
        { text: "3", callback_data: `bf:set:${u}:3` },
        { text: "10", callback_data: `bf:set:${u}:10` },
      ],
      [{ text: s.back, callback_data: `m:channel:${u}` }],
    ],
  };
}

/** ------------------- scraper helpers ------------------- */
function decodeHtmlEntities(s: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s
    .replace(/&([a-zA-Z]+);/g, (_, name) => (named[name] ?? `&${name};`))
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function stripHtml(html: string) {
  const withNewlines = html.replace(/<br\s*\/?>/gi, "\n");
  const noTags = withNewlines.replace(/<[^>]*>/g, "");
  return decodeHtmlEntities(noTags).replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUrl(u: string) {
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}

// ✅ prevent "emoji sent as photos"
function isEmojiAssetUrl(u: string) {
  const x = (u || "").toLowerCase();
  if (!x) return false;
  return (
    x.includes("/emoji/") ||
    x.includes("telegram.org/img/emoji") ||
    x.includes("twemoji") ||
    x.includes("emoji.png") ||
    x.includes("emoji.webp") ||
    x.includes("emoji.svg")
  );
}

function extractMedia(htmlSlice: string): MediaItem[] {
  const photos: string[] = [];
  const videos: string[] = [];
  const docs: string[] = [];

  // Photos (but ignore emoji assets)
  const reBg = /background-image\s*:\s*url\(['"]([^'"]+)['"]\)/gi;
  let m: RegExpExecArray | null;
  while ((m = reBg.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (!isEmojiAssetUrl(u)) photos.push(u);
  }

  const reImg = /<img[^>]+src="([^"]+)"/gi;
  while ((m = reImg.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (!isEmojiAssetUrl(u)) photos.push(u);
  }

  // Videos (best-effort)
  const reDataVideo = /data-video="([^"]+)"/gi;
  while ((m = reDataVideo.exec(htmlSlice)) !== null) videos.push(normalizeUrl(m[1]));

  const reVideoSrc = /<(?:video|source)[^>]+src="([^"]+)"/gi;
  while ((m = reVideoSrc.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (/\.mp4(\?|$)/i.test(u) || /video/i.test(u)) videos.push(u);
  }

  // Documents (best-effort)
  const reDoc = /href="(https?:\/\/cdn\d+\.telesco\.pe\/file\/[^"]+)"/gi;
  while ((m = reDoc.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u)) continue;
    if (/\.mp4(\?|$)/i.test(u)) continue;
    docs.push(u);
  }

  const uniq = (arr: string[]) => {
    const s = new Set<string>();
    for (const x of arr) if (x) s.add(x);
    return [...s];
  };

  const out: MediaItem[] = [];
  for (const u of uniq(photos)) out.push({ kind: "photo", url: u });
  for (const u of uniq(videos)) out.push({ kind: "video", url: u });
  for (const u of uniq(docs)) out.push({ kind: "document", url: u });

  return out.slice(0, 10);
}

async function fetchTme(username: string): Promise<string> {
  const url = `${TME_BASE}${username}`;
  const req = new Request(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  const cache = caches.default;
  const cached = await cache.match(req);
  if (cached) return await cached.text();

  const res = await fetch(req, { cf: { cacheTtl: 15, cacheEverything: true } as any });
  if (!res.ok) throw new Error(`t.me fetch failed ${res.status} for ${username}`);

  const clone = res.clone();
  await cache.put(req, clone);
  return await res.text();
}

function scrapeTmePreview(username: string, html: string): ScrapedPost[] {
  const wanted = username.toLowerCase();
  const posts: ScrapedPost[] = [];

  const re = /data-post="([^"\/]+)\/(\d+)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const chan = m[1].toLowerCase();
    if (chan !== wanted) continue;

    const postId = Number(m[2]);
    if (!Number.isFinite(postId)) continue;

    const start = m.index;
    const slice = html.slice(start, start + 80000);

    const textMatch =
      /<div class="tgme_widget_message_text[^"]*">([\s\S]*?)<\/div>/.exec(slice) ||
      /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(slice);

    const raw = textMatch ? textMatch[1] : "";
    const text = raw ? stripHtml(raw) : "";

    const media = extractMedia(slice);

    posts.push({ postId, text, media, link: `https://t.me/${username}/${postId}` });
  }

  const uniq = new Map<number, ScrapedPost>();
  for (const p of posts) uniq.set(p.postId, p);
  return [...uniq.values()].sort((a, b) => a.postId - b.postId);
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
function isQuietNow(prefs: { quiet_start: number; quiet_end: number }) {
  const qs = Number(prefs.quiet_start ?? -1);
  const qe = Number(prefs.quiet_end ?? -1);
  if (qs < 0 || qe < 0) return false;

  const h = utcHourNow();
  if (qs === qe) return true;
  if (qs < qe) return h >= qs && h < qe;
  return h >= qs || h < qe;
}

/** ------------------- destination UX (LINK PREVIEW) ------------------- */
function safeHashtag(username: string) {
  const tag = (username || "").replace(/[^A-Za-z0-9_]/g, "");
  return tag ? `#${tag}` : "";
}

function postButtons(lang: Lang, username: string, link: string) {
  const s = S(lang);
  return {
    inline_keyboard: [
      [
        { text: s.openOriginal, url: link },
        { text: s.openChannel, url: `https://t.me/${username}` },
      ],
    ],
  };
}

// ✅ clean card + include ORIGINAL LINK in message text so Telegram shows preview (video thumb etc)
function renderPostMessageHtml(lang: Lang, username: string, post: ScrapedPost) {
  const s = S(lang);
  const header = `<b>📰 @${escapeHtml(username)}</b>  <code>${post.postId}</code>`;
  const tag = safeHashtag(username);
  const tagLine = tag ? `\n${escapeHtml(tag)}` : "";

  const raw = (post.text || "").trim() || s.noText;
  // keep space so preview renders nicely
  const bodyText = truncate(raw, 2400);

  const block =
    bodyText.length > 900
      ? `<blockquote expandable>${escapeHtml(bodyText)}</blockquote>`
      : `<blockquote>${escapeHtml(bodyText)}</blockquote>`;

  // IMPORTANT: put the raw URL in text (not only button) to trigger preview
  return `${header}${tagLine}\n\n${block}\n\n🔗 ${post.link}`;
}

async function sendFeedPost(env: Env, destChatId: number, lang: Lang, username: string, post: ScrapedPost) {
  const body = renderPostMessageHtml(lang, username, post);

  // ✅ Do NOT disable previews. This will show a preview card for t.me links (including video thumbnail)
  await tg(env, "sendMessage", {
    chat_id: destChatId,
    text: body,
    parse_mode: "HTML",
    // no disable_web_page_preview here
    reply_markup: postButtons(lang, username, post.link),
  });
}

/** ------------------- delivery (dedupe + quiet queue) ------------------- */
async function markDestinationBad(db: D1Database, userId: number) {
  await db.prepare("UPDATE destinations SET verified=0 WHERE user_id=?").bind(userId).run();
}

async function deliverRealtime(env: Env, userId: number, destChatId: number, username: string, post: ScrapedPost, prefs: any) {
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
    await sendFeedPost(env, destChatId, prefs.lang, username, post);
  } catch (e: any) {
    if (e instanceof TelegramError && (e.code === 403 || e.code === 400)) {
      await markDestinationBad(env.DB, userId);
    }
    await env.DB.prepare("DELETE FROM deliveries WHERE user_id=? AND username=? AND post_id=?").bind(userId, username, post.postId).run();
    throw e;
  }
}

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

async function flushQueuedRealtime(env: Env, userId: number, prefs: any) {
  if (isQuietNow(prefs)) return;

  const dest = await getDestination(env.DB, userId);
  if (!dest?.verified) return;

  const rows = await env.DB
    .prepare(
      `SELECT qr.username, qr.post_id, sp.text, sp.link, sp.media_json
       FROM queued_realtime qr
       LEFT JOIN scraped_posts sp ON sp.username=qr.username AND sp.post_id=qr.post_id
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
      await deliverRealtime(env, userId, Number(dest.chat_id), String(r.username), post, prefs);
      await env.DB.prepare("DELETE FROM queued_realtime WHERE user_id=? AND username=? AND post_id=?").bind(userId, String(r.username), Number(r.post_id)).run();
    } catch {
      break;
    }
  }
}

/** ------------------- menus ------------------- */
async function sendHome(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const hasDest = !!dest?.verified;
  const s = S(prefs.lang);

  const text = [
    s.title,
    "",
    hasDest ? t(prefs.lang, "✅ کانال مقصد تنظیم شده.", "✅ Destination is set.") : t(prefs.lang, "⚠️ هنوز کانال مقصد را تنظیم نکردی.", "⚠️ You haven’t set a destination yet."),
    "",
    s.homeHint,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: homeKb(prefs.lang, hasDest) });
}

async function showHelp(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  await sendOrEdit(env, { chat_id: userId, message_id, text: S(prefs.lang).helpText, reply_markup: homeKb(prefs.lang, !!dest?.verified) });
}

async function showSettings(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const hasDest = !!dest?.verified;
  const s = S(prefs.lang);

  const text = s.settingsText(prefs.realtime_enabled, prefs.digest_hours, prefs.quiet_start, prefs.quiet_end, prefs.default_backfill_n);
  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: settingsKb(prefs.lang, prefs, hasDest) });
}

async function createDestToken(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const token = makeToken();
  await env.DB
    .prepare("INSERT OR REPLACE INTO pending_claims(token, user_id, kind, created_at) VALUES(?, ?, 'dest', ?)")
    .bind(token, userId, nowSec())
    .run();

  const line = `DEST ${token}`;

  const text = [
    `✅ ${s.destTitle}`,
    "",
    s.destSteps,
    "",
    s.copyHint,
    "",
    `<pre>${escapeHtml(line)}</pre>`,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, parse_mode: "HTML", reply_markup: backKb(prefs.lang, "m:home") });
}

async function startFollowFlow(env: Env, userId: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  if (!dest?.verified) {
    await tg(env, "sendMessage", { chat_id: userId, text: s.needDestFirst, reply_markup: homeKb(prefs.lang, false) });
    return;
  }

  await setState(env.DB, userId, "await_follow_username");
  await tg(env, "sendMessage", { chat_id: userId, text: s.sendUsername, reply_markup: cancelKb(prefs.lang) });
}

async function showList(env: Env, userId: number, page: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_sources WHERE user_id=?").bind(userId).first<any>();
  const total = Number(totalRow?.n ?? 0);

  const offset = page * LIST_PAGE_SIZE;

  const rows = await env.DB
    .prepare(
      `SELECT username, paused, mode
       FROM user_sources
       WHERE user_id=?
       ORDER BY username ASC
       LIMIT ? OFFSET ?`
    )
    .bind(userId, LIST_PAGE_SIZE, offset)
    .all<any>();

  const list = rows.results || [];
  const hasPrev = page > 0;
  const hasNext = offset + list.length < total;

  if (!list.length) {
    await sendOrEdit(env, { chat_id: userId, message_id, text: s.myChannels + "\n\n" + t(prefs.lang, "هیچ کانالی دنبال نمی‌کنی.", "You aren’t following any channels."), reply_markup: homeKb(prefs.lang, true) });
    return;
  }

  const lines = list.map((r: any) => {
    const u = String(r.username);
    const paused = Number(r.paused) ? "⏸" : "▶️";
    const mode = r.mode === "digest" ? "🧾" : "⚡";
    return `• @${u}  ${paused} ${mode}`;
  });

  const keyboardRows = list.map((r: any) => [{ text: `⚙️ @${r.username}`, callback_data: `m:channel:${r.username}` }]);

  const navRow: any[] = [];
  if (hasPrev) navRow.push({ text: "⬅️", callback_data: `m:list:${page - 1}` });
  navRow.push({ text: s.back, callback_data: "m:home" });
  if (hasNext) navRow.push({ text: "➡️", callback_data: `m:list:${page + 1}` });

  await sendOrEdit(env, {
    chat_id: userId,
    message_id,
    text: `${s.myChannels}\n\n${lines.join("\n")}\n\n${t(prefs.lang, "برای مدیریت، روی دکمه هر کانال بزن.", "Tap a channel button to manage.")}`,
    reply_markup: { inline_keyboard: [...keyboardRows, [{ text: s.addChannel, callback_data: "m:follow" }], [...navRow]] },
  });
}

async function showChannelSettings(env: Env, userId: number, username: string, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const sub = await env.DB
    .prepare("SELECT paused, mode, include_keywords, exclude_keywords, backfill_n FROM user_sources WHERE user_id=? AND username=?")
    .bind(userId, username)
    .first<any>();

  if (!sub) {
    await sendOrEdit(env, { chat_id: userId, message_id, text: t(prefs.lang, "کانال پیدا نشد.", "Channel not found."), reply_markup: backKb(prefs.lang, "m:list:0") });
    return;
  }

  const include = safeParseKeywords(sub.include_keywords);
  const exclude = safeParseKeywords(sub.exclude_keywords);

  const text = [
    s.chSettingsTitle(username),
    t(prefs.lang, `وضعیت: ${sub.paused ? "⏸ متوقف" : "▶️ فعال"}`, `Status: ${sub.paused ? "⏸ paused" : "▶️ active"}`),
    t(prefs.lang, `حالت: ${sub.mode === "digest" ? "🧾 خلاصه" : "⚡ ریل‌تایم"}`, `Mode: ${sub.mode === "digest" ? "🧾 digest" : "⚡ realtime"}`),
    t(prefs.lang, `بک‌فیل: ${Number(sub.backfill_n ?? 3)}`, `Backfill: ${Number(sub.backfill_n ?? 3)}`),
    "",
    t(prefs.lang, `شامل: ${include.length ? include.join(", ") : "—"}`, `Include: ${include.length ? include.join(", ") : "—"}`),
    t(prefs.lang, `حذف: ${exclude.length ? exclude.join(", ") : "—"}`, `Exclude: ${exclude.length ? exclude.join(", ") : "—"}`),
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: channelKb(prefs.lang, username, Number(sub.paused), String(sub.mode)) });
}

async function showFilters(env: Env, userId: number, username: string, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  await sendOrEdit(env, { chat_id: userId, message_id, text: t(prefs.lang, `🔎 فیلترهای @${username}`, `🔎 Filters for @${username}`), reply_markup: filtersKb(prefs.lang, username) });
}

/** ------------------- follow input ------------------- */
async function handleFollowInput(env: Env, userId: number, input: string) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  const username = normalizeUsername(input);
  if (!username) {
    await tg(env, "sendMessage", { chat_id: userId, text: s.invalidFormat, reply_markup: cancelKb(prefs.lang) });
    return;
  }

  if (!dest?.verified) {
    await sendHome(env, userId);
    return;
  }

  let posts: ScrapedPost[] = [];
  try {
    const html = await fetchTme(username);
    posts = scrapeTmePreview(username, html);
    if (!posts.length) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.couldntRead(username), reply_markup: cancelKb(prefs.lang) });
      return;
    }
  } catch {
    await tg(env, "sendMessage", { chat_id: userId, text: s.fetchFailed, reply_markup: cancelKb(prefs.lang) });
    return;
  }

  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO sources(username, last_post_id, updated_at, next_check_at, check_every_sec, fail_count, last_error_at, last_success_at)
       VALUES(?, 0, ?, 0, ?, 0, 0, 0)`
    )
    .bind(username, nowSec(), MIN_POLL_SEC)
    .run();

  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO user_sources(
        user_id, username, created_at, paused, mode, include_keywords, exclude_keywords, backfill_n
      ) VALUES(?, ?, ?, 0, 'realtime', '[]', '[]', ?)`
    )
    .bind(userId, username, nowSec(), clamp(Number(prefs.default_backfill_n ?? 3), 0, 10))
    .run();

  const backfillN = clamp(Number(prefs.default_backfill_n ?? 3), 0, 10);
  const backfill = backfillN > 0 ? posts.slice(-backfillN) : [];

  for (const p of backfill) {
    await env.DB
      .prepare("INSERT OR IGNORE INTO scraped_posts(username, post_id, text, link, media_json, scraped_at) VALUES(?, ?, ?, ?, ?, ?)")
      .bind(username, p.postId, p.text || "", p.link, JSON.stringify(p.media || []), nowSec())
      .run();
  }

  if (prefs.realtime_enabled && backfill.length) {
    for (const p of backfill) {
      await deliverRealtime(env, userId, Number(dest.chat_id), username, p, prefs).catch(() => {});
    }
  }

  const latestId = posts[posts.length - 1].postId;
  await env.DB
    .prepare(
      "UPDATE sources SET last_post_id=?, updated_at=?, next_check_at=?, check_every_sec=?, fail_count=0, last_error=NULL, last_error_at=0, last_success_at=? WHERE username=?"
    )
    .bind(latestId, nowSec(), nowSec() + MIN_POLL_SEC, MIN_POLL_SEC, nowSec(), username)
    .run();

  await clearState(env.DB, userId);

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: prefs.realtime_enabled ? s.followed(username, backfillN) : s.followedNoRealtime(username),
    reply_markup: homeKb(prefs.lang, true),
  });
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

async function sendDigestForUser(env: Env, userId: number, force = false) {
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

  const title = t(prefs.lang, `🧾 خلاصه‌ی ${digestHours} ساعت اخیر`, `🧾 Digest for last ${digestHours} hours`);
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

/** ------------------- destination claim ------------------- */
function parseDestClaim(text: string): string | null {
  const m = /^DEST\s+([A-Za-z0-9_-]{6,64})$/.exec((text || "").trim());
  return m ? m[1] : null;
}

async function handleChannelPost(env: Env, msg: any) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";

  const token = parseDestClaim(text);
  if (!token) return;

  const row = await env.DB.prepare("SELECT token, user_id FROM pending_claims WHERE token=? AND kind='dest'").bind(token).first<any>();
  if (!row) return;

  const userId = Number(row.user_id);

  await env.DB
    .prepare("INSERT OR REPLACE INTO destinations(user_id, chat_id, verified, created_at) VALUES(?, ?, 1, ?)")
    .bind(userId, chatId, nowSec())
    .run();

  await env.DB.prepare("DELETE FROM pending_claims WHERE token=?").bind(token).run();

  await sendHome(env, userId);
}

/** ------------------- callbacks ------------------- */
async function handleCallback(env: Env, cq: any) {
  const userId = cq.from.id;
  await upsertUser(env.DB, userId);

  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);

  const data = String(cq.data || "");
  const message_id = cq?.message?.message_id as number | undefined;

  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data === "m:home") return sendHome(env, userId, message_id);
  if (data === "m:help") return showHelp(env, userId, message_id);
  if (data === "m:settings") return showSettings(env, userId, message_id);

  if (data === "m:newdest") return createDestToken(env, userId, message_id);
  if (data === "m:follow") return startFollowFlow(env, userId);

  if (data.startsWith("m:list:")) {
    const page = Number(data.split(":")[2] || "0") || 0;
    return showList(env, userId, Math.max(0, page), message_id);
  }

  if (data.startsWith("m:channel:")) {
    const u = data.split(":").slice(2).join(":");
    return showChannelSettings(env, userId, u, message_id);
  }

  if (data === "set:lang") {
    const next: Lang = prefs.lang === "fa" ? "en" : "fa";
    await setPrefs(env.DB, userId, { lang: next });
    return showSettings(env, userId, message_id);
  }

  if (data === "set:rt") {
    const next = prefs.realtime_enabled ? 0 : 1;
    await setPrefs(env.DB, userId, { realtime_enabled: next });
    return showSettings(env, userId, message_id);
  }

  if (data === "set:digest") {
    await setState(env.DB, userId, "await_digest_hours");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).digestAskHours, reply_markup: cancelKb(prefs.lang) });
    return;
  }

  if (data === "set:quiet") {
    await setState(env.DB, userId, "await_quiet_hours");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).quietAsk, reply_markup: cancelKb(prefs.lang) });
    return;
  }

  if (data === "set:dbf") {
    await setState(env.DB, userId, "await_default_backfill");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).backfillAsk, reply_markup: cancelKb(prefs.lang) });
    return;
  }

  if (data === "set:test") {
    const d = await getDestination(env.DB, userId);
    if (!d?.verified) return sendHome(env, userId, message_id);
    await tg(env, "sendMessage", { chat_id: Number(d.chat_id), text: S(prefs.lang).testOk });
    return showSettings(env, userId, message_id);
  }

  if (data.startsWith("c:pause:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("UPDATE user_sources SET paused=1 WHERE user_id=? AND username=?").bind(userId, u).run();
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("c:resume:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("UPDATE user_sources SET paused=0 WHERE user_id=? AND username=?").bind(userId, u).run();
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("c:mode:")) {
    const parts = data.split(":");
    const mode = parts[2];
    const u = parts.slice(3).join(":");
    if (mode !== "realtime" && mode !== "digest") return;
    await env.DB.prepare("UPDATE user_sources SET mode=? WHERE user_id=? AND username=?").bind(mode, userId, u).run();
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("c:unfollow:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("DELETE FROM user_sources WHERE user_id=? AND username=?").bind(userId, u).run();
    return showList(env, userId, 0, message_id);
  }

  if (data.startsWith("f:menu:")) {
    const u = data.split(":").slice(2).join(":");
    return showFilters(env, userId, u, message_id);
  }
  if (data.startsWith("f:clear:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("UPDATE user_sources SET include_keywords='[]', exclude_keywords='[]' WHERE user_id=? AND username=?").bind(userId, u).run();
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("f:set_inc:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_include_keywords", { username: u });
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).incPrompt(u), reply_markup: cancelKb(prefs.lang) });
    return;
  }
  if (data.startsWith("f:set_exc:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_exclude_keywords", { username: u });
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).excPrompt(u), reply_markup: cancelKb(prefs.lang) });
    return;
  }

  if (data.startsWith("bf:menu:")) {
    const u = data.split(":").slice(2).join(":");
    await sendOrEdit(env, { chat_id: userId, message_id, text: t(prefs.lang, `📌 بک‌فیل @${u}\nچند پست آخر هنگام Follow ارسال شود؟`, `📌 Backfill @${u}\nHow many last posts on follow?`), reply_markup: backfillKb(prefs.lang, u) });
    return;
  }
  if (data.startsWith("bf:set:")) {
    const parts = data.split(":");
    const u = parts[2];
    const n = clamp(Number(parts[3] || 3), 0, 10);
    await env.DB.prepare("UPDATE user_sources SET backfill_n=? WHERE user_id=? AND username=?").bind(n, userId, u).run();
    return showChannelSettings(env, userId, u, message_id);
  }

  if (data === "m:cancel") {
    await clearState(env.DB, userId);
    return sendHome(env, userId, message_id);
  }
}

/** ------------------- private messages ------------------- */
async function handlePrivateMessage(env: Env, msg: any) {
  const userId = msg.from.id;
  const text = msg.text || "";

  await upsertUser(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const cmd = parseCmd(text);
  if (cmd) {
    if (cmd.cmd === "/start") return sendHome(env, userId);
    if (cmd.cmd === "/help") return showHelp(env, userId);
    if (cmd.cmd === "/newdest") return createDestToken(env, userId);
    if (cmd.cmd === "/list") return showList(env, userId, 0);
    if (cmd.cmd === "/settings") return showSettings(env, userId);
    if (cmd.cmd === "/follow") return handleFollowInput(env, userId, cmd.args.join(" "));
    if (cmd.cmd === "/cancel") {
      await clearState(env.DB, userId);
      return sendHome(env, userId);
    }
  }

  const st = await getState(env.DB, userId);

  if (st?.state === "await_follow_username") return handleFollowInput(env, userId, text);

  if (st?.state === "await_include_keywords") {
    const u = String(st.data?.username || "");
    const arr = text.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
    await env.DB.prepare("UPDATE user_sources SET include_keywords=? WHERE user_id=? AND username=?").bind(JSON.stringify(arr), userId, u).run();
    await clearState(env.DB, userId);
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "await_exclude_keywords") {
    const u = String(st.data?.username || "");
    const arr = text.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
    await env.DB.prepare("UPDATE user_sources SET exclude_keywords=? WHERE user_id=? AND username=?").bind(JSON.stringify(arr), userId, u).run();
    await clearState(env.DB, userId);
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "await_digest_hours") {
    const n = Number(text.trim());
    if (!Number.isFinite(n) || n < 1 || n > 24) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.invalidNumber, reply_markup: cancelKb(prefs.lang) });
      return;
    }
    await setPrefs(env.DB, userId, { digest_hours: Math.floor(n) });
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: t(prefs.lang, "✅ بازه خلاصه ذخیره شد.", "✅ Digest interval saved.") });
    return showSettings(env, userId);
  }

  if (st?.state === "await_default_backfill") {
    const n = Number(text.trim());
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.invalidNumber, reply_markup: cancelKb(prefs.lang) });
      return;
    }
    await setPrefs(env.DB, userId, { default_backfill_n: Math.floor(n) });
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: t(prefs.lang, "✅ بک‌فیل پیش‌فرض ذخیره شد.", "✅ Default backfill saved.") });
    return showSettings(env, userId);
  }

  if (st?.state === "await_quiet_hours") {
    const low = text.trim().toLowerCase();
    if (low === "off") {
      await setPrefs(env.DB, userId, { quiet_start: -1, quiet_end: -1 });
      await clearState(env.DB, userId);
      await tg(env, "sendMessage", { chat_id: userId, text: t(prefs.lang, "✅ ساعت سکوت خاموش شد.", "✅ Quiet hours disabled.") });
      return showSettings(env, userId);
    }
    const parts = low.split(/\s+/);
    if (parts.length < 2) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.invalidNumber, reply_markup: cancelKb(prefs.lang) });
      return;
    }
    const qs = clamp(Number(parts[0]), 0, 23);
    const qe = clamp(Number(parts[1]), 0, 23);
    await setPrefs(env.DB, userId, { quiet_start: qs, quiet_end: qe });
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: t(prefs.lang, "✅ ساعت سکوت ذخیره شد.", "✅ Quiet hours saved.") });
    return showSettings(env, userId);
  }

  return sendHome(env, userId);
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

async function runScrapeTick(env: Env) {
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

      for (const p of newPosts) {
        await env.DB
          .prepare("INSERT OR IGNORE INTO scraped_posts(username, post_id, text, link, media_json, scraped_at) VALUES(?, ?, ?, ?, ?, ?)")
          .bind(username, p.postId, p.text || "", p.link, JSON.stringify(p.media || []), nowSec())
          .run();
      }

      if (newPosts.length) {
        const subs = await env.DB
          .prepare(
            `SELECT us.user_id, d.chat_id AS dest_chat_id, us.paused, us.mode, us.include_keywords, us.exclude_keywords
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

            await deliverRealtime(env, userId, destChatId, username, post, prefs).catch(() => {});
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

  const digestUsers = await env.DB.prepare("SELECT DISTINCT user_id FROM user_sources WHERE mode='digest' AND paused=0").all<any>();
  for (const r of digestUsers.results || []) {
    await sendDigestForUser(env, Number(r.user_id), false).catch(() => {});
  }
}

async function runScrapeTickLocked(env: Env) {
  const got = await acquireTickLock(env.DB);
  if (!got) return;
  try {
    await runScrapeTick(env);
  } finally {
    await releaseTickLock(env.DB);
  }
}

/** ------------------- updates router ------------------- */
async function processUpdate(env: Env, update: TgUpdate) {
  await ensureDbUpgrades(env.DB);

  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }
  if (update.message && update.message.chat?.type === "private") {
    await handlePrivateMessage(env, update.message);
    return;
  }
  if (update.channel_post) {
    await handleChannelPost(env, update.channel_post);
    return;
  }
}

/** ------------------- durable object ticker ------------------- */
async function ensureTickerStarted(env: Env) {
  const id = env.TICKER.idFromName("global");
  const stub = env.TICKER.get(id);
  await stub.fetch("https://ticker/start", { method: "POST" });
}

export class Ticker {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const cur = await this.state.storage.getAlarm();
      if (!cur) await this.state.storage.setAlarm(Date.now() + 1000);
      return new Response("started");
    }

    if (url.pathname === "/stop") {
      await this.state.storage.deleteAlarm();
      return new Response("stopped");
    }

    if (url.pathname === "/status") {
      const alarm = await this.state.storage.getAlarm();
      return new Response(JSON.stringify({ alarm }), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    try {
      await ensureDbUpgrades(this.env.DB);
      await runScrapeTickLocked(this.env);
    } catch (e) {
      console.log("ticker alarm error:", String(e));
    } finally {
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }
}

/** ------------------- admin auth ------------------- */
function getAdminKey(env: Env) {
  return env.ADMIN_KEY || env.WEBHOOK_SECRET || "";
}
function checkAdmin(c: any) {
  const expected = getAdminKey(c.env);
  if (!expected) return false;
  const auth = c.req.header("Authorization") || "";
  const xkey = c.req.header("X-Admin-Key") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected;
  return xkey === expected;
}

/** ------------------- routes ------------------- */
app.get("/", (c) => c.text("ok"));

app.post("/telegram", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (c.env.WEBHOOK_SECRET && (!secret || secret !== c.env.WEBHOOK_SECRET)) return c.text("forbidden", 403);

  c.executionCtx.waitUntil(ensureTickerStarted(c.env));

  const update = await c.req.json<TgUpdate>();
  c.executionCtx.waitUntil(processUpdate(c.env, update));
  return c.json({ ok: true });
});

app.post("/admin/run-scrape", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  await ensureDbUpgrades(c.env.DB);
  await runScrapeTickLocked(c.env);
  return c.json({ ok: true });
});

app.post("/admin/ticker/start", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  await ensureTickerStarted(c.env);
  return c.json({ ok: true });
});

app.post("/admin/ticker/stop", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  await stub.fetch("https://ticker/stop", { method: "POST" });
  return c.json({ ok: true });
});

app.get("/admin/ticker/status", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  const res = await stub.fetch("https://ticker/status");
  return new Response(await res.text(), { headers: { "content-type": "application/json" } });
});

export default {
  fetch: app.fetch,

  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(ensureTickerStarted(env));
  },
};
