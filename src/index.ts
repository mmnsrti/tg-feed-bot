/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";

type Env = {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TICKER: DurableObjectNamespace;
};

type TgUpdate = any;

const app = new Hono<{ Bindings: Env }>();

const TME_BASE = "https://t.me/s/";
const FOLLOW_BACKFILL_N = 3;
const FIRST_SYNC_LIMIT = 5;

/** ---- 5s scheduler settings ---- */
const TICK_MS = 5000; // ~5 seconds
const LOCK_NAME = "scrape_tick";
const LOCK_TTL_SEC = 20;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/* ------------------------- Telegram helpers ------------------------- */

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

  throw new Error(`${method} failed: ${JSON.stringify(data)}`);
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

  if (!/^[A-Za-z0-9_]{5,64}$/.test(s)) return null;
  return s;
}

/* ------------------------- DB helpers ------------------------- */

async function upsertUser(db: D1Database, userId: number) {
  await db.prepare("INSERT OR IGNORE INTO users(user_id, created_at) VALUES(?, ?)").bind(userId, nowSec()).run();
}

async function getDestination(db: D1Database, userId: number) {
  return db.prepare("SELECT chat_id, verified FROM destinations WHERE user_id=?").bind(userId).first<any>();
}

type Lang = "fa" | "en";

async function ensurePrefs(db: D1Database, userId: number) {
  await db
    .prepare("INSERT OR IGNORE INTO user_prefs(user_id, lang, digest_hours, last_digest_at, updated_at) VALUES(?, 'fa', 6, 0, ?)")
    .bind(userId, nowSec())
    .run();

  const row = await db
    .prepare("SELECT lang, digest_hours, last_digest_at, realtime_enabled FROM user_prefs WHERE user_id=?")
    .bind(userId)
    .first<any>();

  if (!row) return { lang: "fa", digest_hours: 6, last_digest_at: 0, realtime_enabled: 1 };
  return {
    lang: (row.lang as Lang) || "fa",
    digest_hours: Number(row.digest_hours ?? 6),
    last_digest_at: Number(row.last_digest_at ?? 0),
    realtime_enabled: Number(row.realtime_enabled ?? 1),
  };
}

async function setPrefs(
  db: D1Database,
  userId: number,
  patch: Partial<{ lang: Lang; digest_hours: number; last_digest_at: number; realtime_enabled: number }>
) {
  const current = await ensurePrefs(db, userId);

  const lang = patch.lang ?? current.lang;
  const digestHours = patch.digest_hours ?? current.digest_hours;
  const lastDigestAt = patch.last_digest_at ?? current.last_digest_at;
  const realtimeEnabled = patch.realtime_enabled ?? current.realtime_enabled;

  await db
    .prepare("UPDATE user_prefs SET lang=?, digest_hours=?, last_digest_at=?, realtime_enabled=?, updated_at=? WHERE user_id=?")
    .bind(lang, digestHours, lastDigestAt, realtimeEnabled, nowSec(), userId)
    .run();
}

/* ------------------------- State (UX flows) ------------------------- */

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

/* ------------------------- i18n helpers ------------------------- */

function t(lang: Lang, fa: string, en: string) {
  return lang === "fa" ? `${fa}\n\n(${en})` : `${en}\n\n(${fa})`;
}

function btn(lang: Lang, fa: string, en: string) {
  return lang === "fa" ? fa : en;
}

/* ------------------------- Keyboards ------------------------- */

function mainMenu(lang: Lang, hasDest: boolean, realtimeEnabled: boolean) {
  const row1 = hasDest
    ? [{ text: btn(lang, "➕ دنبال کردن کانال", "➕ Follow Channel"), callback_data: "menu:follow" }]
    : [{ text: btn(lang, "🎯 تنظیم کانال مقصد", "🎯 Set Destination"), callback_data: "menu:newdest" }];

  const row2 = [
    { text: btn(lang, "📋 کانال‌های من", "📋 My Channels"), callback_data: "menu:list" },
    { text: btn(lang, "🧾 خلاصه (Digest)", "🧾 Digest"), callback_data: "menu:digest" },
  ];

  const row3 = [
    {
      text: realtimeEnabled ? btn(lang, "⚡ ریل‌تایم: روشن", "⚡ Realtime: ON") : btn(lang, "⚡ ریل‌تایم: خاموش", "⚡ Realtime: OFF"),
      callback_data: "menu:toggle_realtime",
    },
  ];

  const row4 = [
    { text: btn(lang, "🌐 زبان", "🌐 Language"), callback_data: "menu:lang" },
    { text: btn(lang, "❓ راهنما", "❓ Help"), callback_data: "menu:help" },
  ];

  const row5 = hasDest ? [{ text: btn(lang, "✅ تست ارسال", "✅ Test Delivery"), callback_data: "menu:testdest" }] : [];

  const inline_keyboard: any[] = [row1, row2, row3, row4];
  if (row5.length) inline_keyboard.push(row5);
  return { inline_keyboard };
}

function cancelKeyboard(lang: Lang) {
  return { inline_keyboard: [[{ text: btn(lang, "✖️ لغو", "✖️ Cancel"), callback_data: "menu:cancel" }]] };
}

function backKeyboard(lang: Lang) {
  return { inline_keyboard: [[{ text: btn(lang, "⬅️ برگشت", "⬅️ Back"), callback_data: "menu:back" }]] };
}

function digestMenuKeyboard(lang: Lang) {
  return {
    inline_keyboard: [
      [
        { text: btn(lang, "⚙️ تنظیم بازه", "⚙️ Set Interval"), callback_data: "digest:set_hours" },
        { text: btn(lang, "📤 ارسال همین الان", "📤 Send Now"), callback_data: "digest:send_now" },
      ],
      [{ text: btn(lang, "⬅️ برگشت", "⬅️ Back"), callback_data: "menu:back" }],
    ],
  };
}

function channelRowKeyboard(lang: Lang, u: string, paused: number, mode: string) {
  const pauseBtn = paused
    ? { text: btn(lang, "▶️ ادامه", "▶️ Resume"), callback_data: `ch:resume:${u}` }
    : { text: btn(lang, "⏸ توقف", "⏸ Pause"), callback_data: `ch:pause:${u}` };

  const modeBtn =
    mode === "digest"
      ? { text: btn(lang, "⚡ لحظه‌ای", "⚡ Realtime"), callback_data: `ch:mode:realtime:${u}` }
      : { text: btn(lang, "🧾 خلاصه", "🧾 Digest"), callback_data: `ch:mode:digest:${u}` };

  return {
    inline_keyboard: [
      [pauseBtn, modeBtn],
      [
        { text: btn(lang, "🔎 فیلترها", "🔎 Filters"), callback_data: `ch:filters:${u}` },
        { text: btn(lang, "🗑 حذف", "🗑 Unfollow"), callback_data: `ch:unfollow:${u}` },
      ],
      [{ text: btn(lang, "⬅️ برگشت", "⬅️ Back"), callback_data: "menu:list" }],
    ],
  };
}

function filtersKeyboard(lang: Lang, u: string) {
  return {
    inline_keyboard: [
      [
        { text: btn(lang, "➕ کلمات شامل", "➕ Include"), callback_data: `f:set_include:${u}` },
        { text: btn(lang, "➖ کلمات حذف", "➖ Exclude"), callback_data: `f:set_exclude:${u}` },
      ],
      [
        { text: btn(lang, "🧹 پاک کردن فیلترها", "🧹 Clear Filters"), callback_data: `f:clear:${u}` },
        { text: btn(lang, "⬅️ برگشت", "⬅️ Back"), callback_data: `menu:channel:${u}` },
      ],
    ],
  };
}

/* ------------------------- Scraper ------------------------- */

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

type ScrapedPost = { postId: number; text: string; link: string };

async function fetchTme(username: string): Promise<string> {
  const url = `${TME_BASE}${username}`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!res.ok) throw new Error(`t.me fetch failed ${res.status} for ${username}`);
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
    const slice = html.slice(start, start + 50000);

    const textMatch =
      /<div class="tgme_widget_message_text[^"]*">([\s\S]*?)<\/div>/.exec(slice) ||
      /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(slice);

    const raw = textMatch ? textMatch[1] : "";
    const text = raw ? stripHtml(raw) : "";

    posts.push({ postId, text, link: `https://t.me/${username}/${postId}` });
  }

  if (!posts.length) {
    const re2 = /href="https:\/\/t\.me\/([^"\/]+)\/(\d+)"/g;
    while ((m = re2.exec(html)) !== null) {
      if (m[1].toLowerCase() !== wanted) continue;
      const postId = Number(m[2]);
      if (!Number.isFinite(postId)) continue;
      posts.push({ postId, text: "", link: `https://t.me/${m[1]}/${postId}` });
    }
  }

  const uniq = new Map<number, ScrapedPost>();
  for (const p of posts) uniq.set(p.postId, p);
  return [...uniq.values()].sort((a, b) => a.postId - b.postId);
}

/* ------------------------- Filters ------------------------- */

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

/* ------------------------- Realtime delivery (atomic lock) ------------------------- */

async function deliverRealtime(env: Env, userId: number, destChatId: number, username: string, post: ScrapedPost, lang: Lang) {
  const lock = await env.DB
    .prepare("INSERT OR IGNORE INTO deliveries(user_id, username, post_id, created_at) VALUES(?, ?, ?, ?)")
    .bind(userId, username, post.postId, nowSec())
    .run();

  if ((lock as any)?.meta?.changes === 0) return;

  const header = `@${username}`;
  const body = post.text ? post.text : lang === "fa" ? "(بدون متن)" : "(no text)";
  const msg = `${header}\n${post.link}\n\n${body}`.slice(0, 3900);

  try {
    await tg(env, "sendMessage", { chat_id: destChatId, text: msg });
  } catch (e) {
    await env.DB.prepare("DELETE FROM deliveries WHERE user_id=? AND username=? AND post_id=?").bind(userId, username, post.postId).run();
    throw e;
  }
}

/* ------------------------- UX text ------------------------- */

function startText(lang: Lang, hasDest: boolean, realtimeEnabled: boolean, digestHours: number) {
  return t(
    lang,
    ["👋 سلام!", hasDest ? "✅ کانال مقصد تنظیم شده." : "⚠️ هنوز کانال مقصد رو تنظیم نکردی.", realtimeEnabled ? "⚡ ارسال لحظه‌ای: روشن" : "⚡ ارسال لحظه‌ای: خاموش (فقط خلاصه)", `🧾 بازه خلاصه: هر ${digestHours} ساعت`, "", "از دکمه‌ها استفاده کن 👇"].join("\n"),
    ["👋 Hey!", hasDest ? "✅ Destination is set." : "⚠️ You haven’t set a destination yet.", realtimeEnabled ? "⚡ Realtime forwarding: ON" : "⚡ Realtime forwarding: OFF (digest only)", `🧾 Digest interval: every ${digestHours} hours`, "", "Use the buttons below 👇"].join("\n")
  );
}

function helpText(lang: Lang) {
  return t(
    lang,
    ["❓ راهنما", "", "Realtime (لحظه‌ای): هر پست جدید فوراً فوروارد می‌شود.", "Digest (خلاصه): پست‌ها جمع می‌شوند و هر X ساعت یکجا ارسال می‌شوند.", "", "⚡ اگر «ریل‌تایم: خاموش» باشد، هیچ چیز لحظه‌ای ارسال نمی‌شود (حتی کانال‌های realtime).", "", "📌 این نسخه از پیش‌نمایش وب t.me/s استفاده می‌کند (فقط کانال‌های عمومی)."].join("\n"),
    ["❓ Help", "", "Realtime: forwards new posts immediately.", "Digest: batches posts and sends a summary every X hours.", "", "⚡ If “Realtime: OFF”, nothing is forwarded instantly (even realtime channels).", "", "Note: This version scrapes t.me/s (public channels only)."].join("\n")
  );
}

/* ------------------------- Menus ------------------------- */

async function sendMenu(env: Env, userId: number) {
  const dest = await getDestination(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);
  const hasDest = !!dest?.verified;

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: startText(prefs.lang, hasDest, !!prefs.realtime_enabled, prefs.digest_hours),
    reply_markup: mainMenu(prefs.lang, hasDest, !!prefs.realtime_enabled),
  });
}

async function createDestToken(env: Env, userId: number) {
  const prefs = await ensurePrefs(env.DB, userId);

  const token = makeToken();
  await env.DB
    .prepare("INSERT OR REPLACE INTO pending_claims(token, user_id, kind, created_at) VALUES(?, ?, 'dest', ?)")
    .bind(token, userId, nowSec())
    .run();

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: t(
      prefs.lang,
      `🔑 توکن مقصد: ${token}\n\n۱) کانال مقصد رو بساز.\n۲) ربات رو ادمین کن.\n۳) همین متن رو داخل کانال ارسال کن:\nDEST ${token}`,
      `🔑 DEST token: ${token}\n\n1) Create destination channel.\n2) Add bot as admin.\n3) Post this in the channel:\nDEST ${token}`
    ),
    reply_markup: backKeyboard(prefs.lang),
  });
}

async function startFollowFlow(env: Env, userId: number) {
  const dest = await getDestination(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);

  if (!dest?.verified) {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, "⚠️ اول کانال مقصد رو تنظیم کن.", "⚠️ Set destination first."),
      reply_markup: mainMenu(prefs.lang, false, !!prefs.realtime_enabled),
    });
    return;
  }

  await setState(env.DB, userId, "await_follow_username");
  await tg(env, "sendMessage", {
    chat_id: userId,
    text: t(prefs.lang, "نام کاربری یا لینک کانال عمومی رو بفرست:\nمثلاً @khabarfuri", "Send a public channel username/link:\nExample: @khabarfuri"),
    reply_markup: cancelKeyboard(prefs.lang),
  });
}

async function digestMenu(env: Env, userId: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  await tg(env, "sendMessage", {
    chat_id: userId,
    text: t(
      prefs.lang,
      `🧾 خلاصه (Digest)\n\nبازه فعلی: هر ${prefs.digest_hours} ساعت\n\nمی‌تونی بازه رو تغییر بدی یا همین الان خلاصه بگیری.`,
      `🧾 Digest\n\nCurrent interval: every ${prefs.digest_hours} hours\n\nChange interval or send digest now.`
    ),
    reply_markup: digestMenuKeyboard(prefs.lang),
  });
}

async function showList(env: Env, userId: number) {
  const prefs = await ensurePrefs(env.DB, userId);

  const rows = await env.DB
    .prepare("SELECT username, paused, mode FROM user_sources WHERE user_id=? ORDER BY username ASC")
    .bind(userId)
    .all<any>();

  if (!rows.results.length) {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, "هیچ کانالی دنبال نمی‌کنی.", "You aren’t following any channels."),
      reply_markup: mainMenu(prefs.lang, true, !!prefs.realtime_enabled),
    });
    return;
  }

  const lines = rows.results.map((r: any) => {
    const u = String(r.username);
    const paused = Number(r.paused) ? "⏸" : "▶️";
    const mode = r.mode === "digest" ? "🧾" : "⚡";
    return `• @${u}  ${paused} ${mode}`;
  });

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: t(
      prefs.lang,
      `📋 کانال‌های تو:\n\n${lines.join("\n")}\n\nبرای مدیریت هر کانال «تنظیمات» رو بزن.`,
      `📋 Your channels:\n\n${lines.join("\n")}\n\nTap “Settings” to manage a channel.`
    ),
    reply_markup: {
      inline_keyboard: [
        ...rows.results.slice(0, 20).map((r: any) => [
          { text: btn(prefs.lang, `⚙️ تنظیمات @${r.username}`, `⚙️ Settings @${r.username}`), callback_data: `menu:channel:${r.username}` },
        ]),
        [{ text: btn(prefs.lang, "⬅️ برگشت", "⬅️ Back"), callback_data: "menu:back" }],
      ],
    },
  });
}

async function showChannelSettings(env: Env, userId: number, username: string) {
  const prefs = await ensurePrefs(env.DB, userId);

  const sub = await env.DB
    .prepare("SELECT paused, mode, include_keywords, exclude_keywords FROM user_sources WHERE user_id=? AND username=?")
    .bind(userId, username)
    .first<any>();

  if (!sub) {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, "این کانال پیدا نشد.", "Channel not found."),
      reply_markup: backKeyboard(prefs.lang),
    });
    return;
  }

  const include = safeParseKeywords(sub.include_keywords);
  const exclude = safeParseKeywords(sub.exclude_keywords);

  const text = t(
    prefs.lang,
    [
      `⚙️ تنظیمات @${username}`,
      `وضعیت: ${sub.paused ? "⏸ متوقف" : "▶️ فعال"}`,
      `حالت ارسال: ${sub.mode === "digest" ? "🧾 خلاصه" : "⚡ لحظه‌ای"}`,
      `شامل: ${include.length ? include.join(", ") : "—"}`,
      `حذف: ${exclude.length ? exclude.join(", ") : "—"}`,
      "",
      prefs.realtime_enabled ? "⚡ ریل‌تایم کلی: روشن" : "⚡ ریل‌تایم کلی: خاموش (فقط خلاصه)",
    ].join("\n"),
    [
      `⚙️ Settings @${username}`,
      `Status: ${sub.paused ? "⏸ paused" : "▶️ active"}`,
      `Mode: ${sub.mode === "digest" ? "🧾 digest" : "⚡ realtime"}`,
      `Include: ${include.length ? include.join(", ") : "—"}`,
      `Exclude: ${exclude.length ? exclude.join(", ") : "—"}`,
      "",
      prefs.realtime_enabled ? "⚡ Global realtime: ON" : "⚡ Global realtime: OFF (digest only)",
    ].join("\n")
  );

  await tg(env, "sendMessage", {
    chat_id: userId,
    text,
    reply_markup: channelRowKeyboard(prefs.lang, username, Number(sub.paused), String(sub.mode)),
  });
}

async function showFilters(env: Env, userId: number, username: string) {
  const prefs = await ensurePrefs(env.DB, userId);

  const sub = await env.DB
    .prepare("SELECT include_keywords, exclude_keywords FROM user_sources WHERE user_id=? AND username=?")
    .bind(userId, username)
    .first<any>();

  if (!sub) return;

  const include = safeParseKeywords(sub.include_keywords);
  const exclude = safeParseKeywords(sub.exclude_keywords);

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: t(
      prefs.lang,
      `🔎 فیلترهای @${username}\n\nشامل: ${include.length ? include.join(", ") : "—"}\nحذف: ${exclude.length ? exclude.join(", ") : "—"}`,
      `🔎 Filters for @${username}\n\nInclude: ${include.length ? include.join(", ") : "—"}\nExclude: ${exclude.length ? exclude.join(", ") : "—"}`
    ),
    reply_markup: filtersKeyboard(prefs.lang, username),
  });
}

/* ------------------------- Follow input (+ backfill rules) ------------------------- */

async function handleFollowInput(env: Env, userId: number, input: string) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);

  const username = normalizeUsername(input);
  if (!username) {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, "فرمت اشتباهه. مثل @name بفرست.", "Invalid format. Send @name."),
      reply_markup: cancelKeyboard(prefs.lang),
    });
    return;
  }

  if (!dest?.verified) {
    await sendMenu(env, userId);
    return;
  }

  let posts: ScrapedPost[] = [];
  try {
    const html = await fetchTme(username);
    posts = scrapeTmePreview(username, html);
    if (!posts.length) {
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: t(prefs.lang, `از @${username} چیزی نتونستم بخونم. عمومی هست؟`, `Couldn’t read @${username}. Is it public?`),
        reply_markup: cancelKeyboard(prefs.lang),
      });
      return;
    }
  } catch {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, "الان نتونستم دریافت کنم. چند دقیقه دیگه امتحان کن.", "Fetch failed. Try again in a minute."),
      reply_markup: cancelKeyboard(prefs.lang),
    });
    return;
  }

  await env.DB.prepare("INSERT OR IGNORE INTO sources(username, last_post_id, updated_at) VALUES(?, 0, ?)").bind(username, nowSec()).run();

  await env.DB
    .prepare("INSERT OR IGNORE INTO user_sources(user_id, username, created_at, paused, mode, include_keywords, exclude_keywords) VALUES(?, ?, ?, 0, 'realtime', '[]', '[]')")
    .bind(userId, username, nowSec())
    .run();

  const backfill = posts.slice(-FOLLOW_BACKFILL_N);
  for (const p of backfill) {
    await env.DB
      .prepare("INSERT OR IGNORE INTO scraped_posts(username, post_id, text, link, scraped_at) VALUES(?, ?, ?, ?, ?)")
      .bind(username, p.postId, p.text || "", p.link, nowSec())
      .run();
  }

  if (prefs.realtime_enabled) {
    for (const p of backfill) {
      await deliverRealtime(env, userId, Number(dest.chat_id), username, p, prefs.lang).catch(() => {});
    }
  }

  const latestId = posts[posts.length - 1].postId;
  await env.DB.prepare("UPDATE sources SET last_post_id=?, updated_at=? WHERE username=?").bind(latestId, nowSec(), username).run();

  await clearState(env.DB, userId);

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: prefs.realtime_enabled
      ? t(prefs.lang, `✅ @${username} اضافه شد. (۳ پست آخر ارسال شد)`, `✅ Followed @${username}. (Sent last 3 posts)`)
      : t(prefs.lang, `✅ @${username} اضافه شد. (ریل‌تایم خاموش است؛ فقط خلاصه)`, `✅ Followed @${username}. (Realtime is OFF; digest only)`),
    reply_markup: mainMenu(prefs.lang, true, !!prefs.realtime_enabled),
  });
}

/* ------------------------- Digest sending ------------------------- */

async function sendDigestForUser(env: Env, userId: number, force = false) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  if (!dest?.verified) return;

  const subs = await env.DB
    .prepare("SELECT username, include_keywords, exclude_keywords FROM user_sources WHERE user_id=? AND mode='digest' AND paused=0")
    .bind(userId)
    .all<any>();

  if (!subs.results.length) {
    if (force) {
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: t(prefs.lang, "هیچ کانالی در حالت خلاصه نداری.", "You have no digest-mode channels."),
        reply_markup: mainMenu(prefs.lang, true, !!prefs.realtime_enabled),
      });
    }
    return;
  }

  const digestHours = Number(prefs.digest_hours ?? 6);
  const last = Number(prefs.last_digest_at ?? 0);
  const due = force || last === 0 || nowSec() - last >= digestHours * 3600;
  if (!due) return;

  const since = last || nowSec() - digestHours * 3600;

  const items: { username: string; post_id: number; link: string; text: string; scraped_at: number }[] = [];

  for (const s of subs.results) {
    const u = String(s.username);
    const include = safeParseKeywords(s.include_keywords);
    const exclude = safeParseKeywords(s.exclude_keywords);

    const rows = await env.DB
      .prepare("SELECT username, post_id, link, text, scraped_at FROM scraped_posts WHERE username=? AND scraped_at > ? ORDER BY post_id DESC LIMIT 10")
      .bind(u, since)
      .all<any>();

    for (const r of rows.results) {
      const txt = String(r.text || "");
      if (!textPassesFilters(txt, include, exclude)) continue;
      items.push({
        username: String(r.username),
        post_id: Number(r.post_id),
        link: String(r.link),
        text: txt,
        scraped_at: Number(r.scraped_at),
      });
    }
  }

  items.sort((a, b) => b.post_id - a.post_id);
  const top = items.slice(0, 20);

  if (!top.length) {
    if (force) {
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: t(prefs.lang, "چیزی برای خلاصه پیدا نشد.", "Nothing to include in digest."),
        reply_markup: mainMenu(prefs.lang, true, !!prefs.realtime_enabled),
      });
    }
    await setPrefs(env.DB, userId, { last_digest_at: nowSec() });
    return;
  }

  const lines = top.map((it, i) => {
    const snippet = (it.text || "").replace(/\s+/g, " ").slice(0, 120);
    const sn = snippet ? ` — ${snippet}` : "";
    return `${i + 1}) @${it.username}\n${it.link}${sn ? `\n${sn}` : ""}`;
  });

  const title = t(prefs.lang, `🧾 خلاصه‌ی ${digestHours} ساعت اخیر`, `🧾 Digest for last ${digestHours} hours`);
  const msg = `${title}\n\n${lines.join("\n\n")}`.slice(0, 3900);

  await tg(env, "sendMessage", { chat_id: Number(dest.chat_id), text: msg });
  await setPrefs(env.DB, userId, { last_digest_at: nowSec() });
}

/* ------------------------- Destination claim ------------------------- */

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

  await sendMenu(env, userId);
}

/* ------------------------- Callbacks ------------------------- */

async function handleCallback(env: Env, cq: any) {
  const userId = cq.from.id;
  await upsertUser(env.DB, userId);

  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const hasDest = !!dest?.verified;

  const data = String(cq.data || "");
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data === "menu:back") return sendMenu(env, userId);

  if (data === "menu:help") {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: helpText(prefs.lang),
      reply_markup: mainMenu(prefs.lang, hasDest, !!prefs.realtime_enabled),
    });
    return;
  }

  if (data === "menu:newdest") return createDestToken(env, userId);
  if (data === "menu:follow") return startFollowFlow(env, userId);
  if (data === "menu:list") return showList(env, userId);
  if (data === "menu:digest") return digestMenu(env, userId);

  if (data === "menu:cancel") {
    await clearState(env.DB, userId);
    await sendMenu(env, userId);
    return;
  }

  if (data === "menu:lang") {
    const newLang: Lang = prefs.lang === "fa" ? "en" : "fa";
    await setPrefs(env.DB, userId, { lang: newLang });
    await sendMenu(env, userId);
    return;
  }

  if (data === "menu:toggle_realtime") {
    const next = prefs.realtime_enabled ? 0 : 1;
    await setPrefs(env.DB, userId, { realtime_enabled: next });
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: next
        ? t(prefs.lang, "⚡ ارسال لحظه‌ای روشن شد.", "⚡ Realtime forwarding enabled.")
        : t(prefs.lang, "⚡ ارسال لحظه‌ای خاموش شد. فقط خلاصه ارسال می‌شود.", "⚡ Realtime forwarding disabled. Digest only."),
      reply_markup: mainMenu(prefs.lang, hasDest, !!next),
    });
    return;
  }

  if (data === "menu:testdest") {
    if (!dest?.verified) {
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: t(prefs.lang, "⚠️ اول مقصد رو تنظیم کن.", "⚠️ Set destination first."),
        reply_markup: mainMenu(prefs.lang, false, !!prefs.realtime_enabled),
      });
      return;
    }
    await tg(env, "sendMessage", { chat_id: Number(dest.chat_id), text: t(prefs.lang, "✅ تست ارسال انجام شد.", "✅ Delivery test succeeded.") });
    await sendMenu(env, userId);
    return;
  }

  if (data.startsWith("menu:channel:")) {
    const u = data.split(":").slice(2).join(":");
    return showChannelSettings(env, userId, u);
  }

  if (data.startsWith("ch:pause:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("UPDATE user_sources SET paused=1 WHERE user_id=? AND username=?").bind(userId, u).run();
    return showChannelSettings(env, userId, u);
  }

  if (data.startsWith("ch:resume:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("UPDATE user_sources SET paused=0 WHERE user_id=? AND username=?").bind(userId, u).run();
    return showChannelSettings(env, userId, u);
  }

  if (data.startsWith("ch:mode:")) {
    const parts = data.split(":");
    const mode = parts[2];
    const u = parts.slice(3).join(":");
    if (mode !== "realtime" && mode !== "digest") return;
    await env.DB.prepare("UPDATE user_sources SET mode=? WHERE user_id=? AND username=?").bind(mode, userId, u).run();
    return showChannelSettings(env, userId, u);
  }

  if (data.startsWith("ch:unfollow:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("DELETE FROM user_sources WHERE user_id=? AND username=?").bind(userId, u).run();
    await sendMenu(env, userId);
    return;
  }

  if (data.startsWith("ch:filters:")) {
    const u = data.split(":").slice(2).join(":");
    return showFilters(env, userId, u);
  }

  if (data.startsWith("f:clear:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("UPDATE user_sources SET include_keywords='[]', exclude_keywords='[]' WHERE user_id=? AND username=?").bind(userId, u).run();
    return showChannelSettings(env, userId, u);
  }

  if (data.startsWith("f:set_include:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_include_keywords", { username: u });
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, `کلمات شامل برای @${u} رو بفرست (با کاما جدا کن).`, `Send include keywords for @${u} (comma-separated).`),
      reply_markup: cancelKeyboard(prefs.lang),
    });
    return;
  }

  if (data.startsWith("f:set_exclude:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_exclude_keywords", { username: u });
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, `کلمات حذف برای @${u} رو بفرست (با کاما جدا کن).`, `Send exclude keywords for @${u} (comma-separated).`),
      reply_markup: cancelKeyboard(prefs.lang),
    });
    return;
  }

  if (data === "digest:set_hours") {
    await setState(env.DB, userId, "await_digest_hours");
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: t(prefs.lang, "عدد بازه خلاصه رو بفرست (ساعت، ۱ تا ۲۴).", "Send digest interval in hours (1..24)."),
      reply_markup: cancelKeyboard(prefs.lang),
    });
    return;
  }

  if (data === "digest:send_now") {
    await sendDigestForUser(env, userId, true);
    await sendMenu(env, userId);
    return;
  }
}

/* ------------------------- Private messages (states) ------------------------- */

async function handlePrivateMessage(env: Env, msg: any) {
  const userId = msg.from.id;
  const text = msg.text || "";

  await upsertUser(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);

  const cmd = parseCmd(text);
  if (cmd) {
    if (cmd.cmd === "/start") return sendMenu(env, userId);
    if (cmd.cmd === "/help") {
      const dest = await getDestination(env.DB, userId);
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: helpText(prefs.lang),
        reply_markup: mainMenu(prefs.lang, !!dest?.verified, !!prefs.realtime_enabled),
      });
      return;
    }
    if (cmd.cmd === "/newdest") return createDestToken(env, userId);
    if (cmd.cmd === "/list") return showList(env, userId);
    if (cmd.cmd === "/follow") return handleFollowInput(env, userId, cmd.args.join(" "));
    if (cmd.cmd === "/cancel") {
      await clearState(env.DB, userId);
      return sendMenu(env, userId);
    }
  }

  const st = await getState(env.DB, userId);

  if (st?.state === "await_follow_username") return handleFollowInput(env, userId, text);

  if (st?.state === "await_include_keywords") {
    const u = String(st.data?.username || "");
    const arr = text.split(",").map((x) => x.trim()).filter(Boolean);
    await env.DB.prepare("UPDATE user_sources SET include_keywords=? WHERE user_id=? AND username=?").bind(JSON.stringify(arr), userId, u).run();
    await clearState(env.DB, userId);
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "await_exclude_keywords") {
    const u = String(st.data?.username || "");
    const arr = text.split(",").map((x) => x.trim()).filter(Boolean);
    await env.DB.prepare("UPDATE user_sources SET exclude_keywords=? WHERE user_id=? AND username=?").bind(JSON.stringify(arr), userId, u).run();
    await clearState(env.DB, userId);
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "await_digest_hours") {
    const n = Number(text.trim());
    if (!Number.isFinite(n) || n < 1 || n > 24) {
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: t(prefs.lang, "عدد بین ۱ تا ۲۴ بفرست.", "Send a number between 1 and 24."),
        reply_markup: cancelKeyboard(prefs.lang),
      });
      return;
    }
    await setPrefs(env.DB, userId, { digest_hours: Math.floor(n) });
    await clearState(env.DB, userId);
    return digestMenu(env, userId);
  }

  return sendMenu(env, userId);
}

/* ------------------------- D1 lock (prevents overlaps) ------------------------- */

async function acquireTickLock(db: D1Database): Promise<boolean> {
  await db.prepare("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, acquired_at INTEGER NOT NULL);").run();

  const now = nowSec();
  const ins = await db.prepare("INSERT OR IGNORE INTO locks(name, acquired_at) VALUES(?, ?)").bind(LOCK_NAME, now).run();
  if ((ins as any)?.meta?.changes === 1) return true;

  const row = await db.prepare("SELECT acquired_at FROM locks WHERE name=?").bind(LOCK_NAME).first<any>();
  const acquiredAt = Number(row?.acquired_at ?? 0);

  if (!acquiredAt || now - acquiredAt > LOCK_TTL_SEC) {
    const upd = await db
      .prepare("UPDATE locks SET acquired_at=? WHERE name=? AND acquired_at=?")
      .bind(now, LOCK_NAME, acquiredAt)
      .run();
    if ((upd as any)?.meta?.changes === 1) return true;
  }

  return false;
}

async function releaseTickLock(db: D1Database) {
  await db.prepare("DELETE FROM locks WHERE name=?").bind(LOCK_NAME).run();
}

/* ------------------------- Scheduled work (scrape + store + realtime + digest) ------------------------- */

async function runScrapeTick(env: Env) {
  const followed = await env.DB.prepare("SELECT DISTINCT username FROM user_sources").all<any>();

  for (const row of followed.results) {
    const username = String(row.username);

    try {
      const source = await env.DB.prepare("SELECT last_post_id FROM sources WHERE username=?").bind(username).first<any>();
      const lastSeen = Number(source?.last_post_id ?? 0);

      const html = await fetchTme(username);
      const posts = scrapeTmePreview(username, html);
      if (!posts.length) continue;

      let newPosts = posts.filter((p) => p.postId > lastSeen);
      if (lastSeen === 0 && newPosts.length > FIRST_SYNC_LIMIT) newPosts = newPosts.slice(-FIRST_SYNC_LIMIT);

      if (!newPosts.length) {
        await env.DB.prepare("UPDATE sources SET updated_at=? WHERE username=?").bind(nowSec(), username).run();
        continue;
      }

      for (const p of newPosts) {
        await env.DB
          .prepare("INSERT OR IGNORE INTO scraped_posts(username, post_id, text, link, scraped_at) VALUES(?, ?, ?, ?, ?)")
          .bind(username, p.postId, p.text || "", p.link, nowSec())
          .run();
      }

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

          await deliverRealtime(env, userId, destChatId, username, post, prefs.lang).catch(() => {});
        }
      }

      const maxId = newPosts[newPosts.length - 1].postId;
      await env.DB.prepare("UPDATE sources SET last_post_id=?, updated_at=? WHERE username=?").bind(maxId, nowSec(), username).run();
    } catch {
      continue;
    }
  }

  const usersWithDigest = await env.DB.prepare("SELECT DISTINCT user_id FROM user_sources WHERE mode='digest' AND paused=0").all<any>();
  for (const r of usersWithDigest.results) {
    await sendDigestForUser(env, Number(r.user_id), false);
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

/* ------------------------- Process updates ------------------------- */

async function processUpdate(env: Env, update: TgUpdate) {
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

/* ------------------------- Durable Object Scheduler (5s) ------------------------- */

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
      if (!cur) await this.state.storage.setAlarm(Date.now() + 1000); // start quickly
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
    // Run the work
    try {
      await runScrapeTickLocked(this.env);
    } catch (e) {
      console.log("ticker alarm error:", String(e));
    } finally {
      // Schedule next tick
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }
}

/* ------------------------- Routes ------------------------- */

app.get("/", (c) => c.text("ok"));

app.post("/telegram", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (c.env.WEBHOOK_SECRET && secret && secret !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);

  // Make sure our 5s ticker is running (best effort)
  c.executionCtx.waitUntil(ensureTickerStarted(c.env));

  const update = await c.req.json<TgUpdate>();
  c.executionCtx.waitUntil(processUpdate(c.env, update));
  return c.json({ ok: true });
});

// Manual scrape (protected)
app.post("/admin/run-scrape", async (c) => {
  const key = c.req.query("key");
  if (key !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  await runScrapeTickLocked(c.env);
  return c.json({ ok: true });
});

// Start/Stop/Status ticker (protected)
app.post("/admin/ticker/start", async (c) => {
  const key = c.req.query("key");
  if (key !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  await ensureTickerStarted(c.env);
  return c.json({ ok: true });
});

app.post("/admin/ticker/stop", async (c) => {
  const key = c.req.query("key");
  if (key !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  await stub.fetch("https://ticker/stop", { method: "POST" });
  return c.json({ ok: true });
});

app.get("/admin/ticker/status", async (c) => {
  const key = c.req.query("key");
  if (key !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  const res = await stub.fetch("https://ticker/status");
  return new Response(await res.text(), { headers: { "content-type": "application/json" } });
});

export default {
  fetch: app.fetch,

  // Cron can't do 5s, but it can "kick" the ticker to ensure it starts within a minute after deploy.
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(ensureTickerStarted(env));
  },
};
