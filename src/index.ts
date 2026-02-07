/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";

type Env = {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
};

type TgUpdate = any;

const app = new Hono<{ Bindings: Env }>();

const TME_BASE = "https://t.me/s/";
const FIRST_SYNC_LIMIT = 5;

// --- UX strings ---
const TXT = {
  start: (hasDest: boolean) =>
    [
      "👋 Welcome!",
      "",
      hasDest
        ? "✅ Destination is set. You can follow channels now."
        : "⚠️ You haven’t set your destination channel yet.",
      "",
      "Use the buttons below 👇",
    ].join("\n"),

  help: [
    "ℹ️ How it works",
    "",
    "1) You set a destination channel (a channel YOU own).",
    "2) You follow public channels by @username (we scrape t.me/s/<username>).",
    "3) On schedule, we forward new posts into your destination.",
    "",
    "Destination setup requires:",
    "- Create a channel",
    "- Add the bot as Admin",
    "- Post: DEST <token>",
  ].join("\n"),

  askFollow: "Send a public channel username/link, e.g.\n@khabarfuri\nor\nhttps://t.me/khabarfuri",
  invalidUsername: "That doesn’t look like a valid channel username/link. Try @name or https://t.me/name",
  followOk: (u: string) => `✅ Now following @${u}.`,
  unfollowOk: (u: string) => `🧹 Unfollowed @${u}.`,
  noFollows: "You’re not following any channels yet.",
  destMissing: "⚠️ Set your destination first (tap “Set Destination”).",
  destToken: (token: string) =>
    [
      `🔑 DEST token: ${token}`,
      "",
      "Steps:",
      "1) Create your destination channel.",
      "2) Add this bot as ADMIN in that channel.",
      "3) Post this exact message in that channel:",
      `DEST ${token}`,
    ].join("\n"),
  destVerified: (chatId: number) => `✅ Destination verified: ${chatId}`,
  testSent: "✅ Sent a test message to your destination.",
  cancelOk: "✅ Cancelled.",
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
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

/** Telegram API caller with 429 retry_after support. */
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

async function upsertUser(db: D1Database, userId: number) {
  await db
    .prepare("INSERT OR IGNORE INTO users(user_id, created_at) VALUES(?, ?)")
    .bind(userId, nowSec())
    .run();
}

// --- State helpers ---
async function setState(db: D1Database, userId: number, state: string, data: any = null) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO user_state(user_id, state, data, updated_at) VALUES(?, ?, ?, ?)"
    )
    .bind(userId, state, data ? JSON.stringify(data) : null, nowSec())
    .run();
}

async function getState(db: D1Database, userId: number): Promise<{ state: string; data: any } | null> {
  const row = await db
    .prepare("SELECT state, data FROM user_state WHERE user_id=?")
    .bind(userId)
    .first<any>();
  if (!row) return null;
  return { state: row.state, data: row.data ? JSON.parse(row.data) : null };
}

async function clearState(db: D1Database, userId: number) {
  await db.prepare("DELETE FROM user_state WHERE user_id=?").bind(userId).run();
}

async function getDestination(db: D1Database, userId: number) {
  return db
    .prepare("SELECT chat_id, verified FROM destinations WHERE user_id=?")
    .bind(userId)
    .first<any>();
}

// --- Keyboards ---
function mainMenu(hasDest: boolean) {
  const row1 = hasDest
    ? [{ text: "➕ Follow Channel", callback_data: "menu:follow" }]
    : [{ text: "🎯 Set Destination", callback_data: "menu:newdest" }];

  const row2 = hasDest
    ? [
        { text: "📋 My Channels", callback_data: "menu:list" },
        { text: "✅ Test Destination", callback_data: "menu:testdest" },
      ]
    : [{ text: "📋 My Channels", callback_data: "menu:list" }];

  return {
    inline_keyboard: [row1, row2, [{ text: "❓ Help", callback_data: "menu:help" }]],
  };
}

function followKeyboard() {
  return {
    inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "menu:cancel" }]],
  };
}

function listKeyboard(usernames: string[]) {
  const rows = usernames.map((u) => [{ text: `🗑 Unfollow @${u}`, callback_data: `act:unfollow:${u}` }]);
  rows.push([{ text: "⬅️ Back", callback_data: "menu:back" }]);
  return { inline_keyboard: rows.slice(0, 80) }; // keep it reasonable
}

/** ---------- Scraping ---------- **/

function decodeHtmlEntities(s: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
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

type ScrapedPost = {
  postId: number;
  text: string;
  link: string;
};

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

    posts.push({
      postId,
      text,
      link: `https://t.me/${username}/${postId}`,
    });
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

/** ---------- Delivery ---------- **/

async function sendPostToDestination(env: Env, destChatId: number, username: string, post: ScrapedPost) {
  const header = `@${username}`;
  const body = post.text ? post.text : "(no text)";
  const msg = `${header}\n${post.link}\n\n${body}`.slice(0, 3900);
  await tg(env, "sendMessage", { chat_id: destChatId, text: msg });
}

/** ---------- UX Actions ---------- **/

async function sendMenu(env: Env, userId: number, text: string) {
  const dest = await getDestination(env.DB, userId);
  const hasDest = !!dest?.verified;
  await tg(env, "sendMessage", {
    chat_id: userId,
    text,
    reply_markup: mainMenu(hasDest),
  });
}

async function showList(env: Env, userId: number) {
  const follows = await env.DB
    .prepare("SELECT username FROM user_sources WHERE user_id=? ORDER BY username ASC")
    .bind(userId)
    .all<any>();

  if (!follows.results.length) {
    return sendMenu(env, userId, TXT.noFollows);
  }

  const usernames = follows.results.map((r: any) => String(r.username));
  const lines = ["📋 Your followed channels:", "", ...usernames.map((u) => `• @${u}`)].join("\n");

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: lines,
    reply_markup: listKeyboard(usernames),
  });
}

async function createDestToken(env: Env, userId: number) {
  const token = makeToken();
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO pending_claims(token, user_id, kind, created_at) VALUES(?, ?, 'dest', ?)"
    )
    .bind(token, userId, nowSec())
    .run();

  await tg(env, "sendMessage", {
    chat_id: userId,
    text: TXT.destToken(token),
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:back" }]] },
  });
}

async function startFollowFlow(env: Env, userId: number) {
  const dest = await getDestination(env.DB, userId);
  if (!dest?.verified) return sendMenu(env, userId, TXT.destMissing);

  await setState(env.DB, userId, "await_follow_username");
  await tg(env, "sendMessage", {
    chat_id: userId,
    text: TXT.askFollow,
    reply_markup: followKeyboard(),
  });
}

/** ---------- Bot updates ---------- **/

async function handlePrivateMessage(env: Env, msg: any) {
  const userId = msg.from.id;
  const text = msg.text || "";

  await upsertUser(env.DB, userId);

  const dest = await getDestination(env.DB, userId);
  const hasDest = !!dest?.verified;

  // Commands still work
  const parsed = parseCmd(text);
  if (parsed) {
    if (parsed.cmd === "/start") return sendMenu(env, userId, TXT.start(hasDest));
    if (parsed.cmd === "/help") return sendMenu(env, userId, TXT.help);
    if (parsed.cmd === "/list") return showList(env, userId);
    if (parsed.cmd === "/newdest") return createDestToken(env, userId);
    if (parsed.cmd === "/cancel") {
      await clearState(env.DB, userId);
      return sendMenu(env, userId, TXT.cancelOk);
    }
    if (parsed.cmd === "/follow") {
      const u = normalizeUsername(parsed.args[0] || "");
      if (!u) return tg(env, "sendMessage", { chat_id: userId, text: TXT.invalidUsername });
      if (!hasDest) return sendMenu(env, userId, TXT.destMissing);
      // quick add (validate via fetch below)
      await handleFollowInput(env, userId, u);
      return;
    }
    if (parsed.cmd === "/unfollow") {
      const u = normalizeUsername(parsed.args[0] || "");
      if (!u) return tg(env, "sendMessage", { chat_id: userId, text: "Usage: /unfollow @username" });
      await env.DB.prepare("DELETE FROM user_sources WHERE user_id=? AND username=?").bind(userId, u).run();
      return sendMenu(env, userId, TXT.unfollowOk(u));
    }

    // Unknown command -> show menu
    return sendMenu(env, userId, "Unknown command. Use the buttons below.");
  }

  // Non-command: check user state
  const st = await getState(env.DB, userId);
  if (st?.state === "await_follow_username") {
    const u = normalizeUsername(text);
    if (!u) {
      return tg(env, "sendMessage", { chat_id: userId, text: TXT.invalidUsername, reply_markup: followKeyboard() });
    }
    await handleFollowInput(env, userId, u);
    return;
  }

  // default: show menu
  return sendMenu(env, userId, TXT.start(hasDest));
}

async function handleFollowInput(env: Env, userId: number, username: string) {
  // Validate by fetching and ensuring we can parse at least 1 post
  try {
    const html = await fetchTme(username);
    const posts = scrapeTmePreview(username, html);
    if (!posts.length) {
      await tg(env, "sendMessage", {
        chat_id: userId,
        text: `I couldn’t read posts from @${username}. Is it public and has https://t.me/s/${username}?`,
        reply_markup: followKeyboard(),
      });
      return;
    }
  } catch (e) {
    await tg(env, "sendMessage", {
      chat_id: userId,
      text: `Couldn’t fetch @${username} right now. Try again in a minute.`,
      reply_markup: followKeyboard(),
    });
    return;
  }

  await env.DB
    .prepare("INSERT OR IGNORE INTO sources(username, last_post_id, updated_at) VALUES(?, 0, ?)")
    .bind(username, nowSec())
    .run();

  await env.DB
    .prepare("INSERT OR IGNORE INTO user_sources(user_id, username, created_at) VALUES(?, ?, ?)")
    .bind(userId, username, nowSec())
    .run();

  await clearState(env.DB, userId);
  await sendMenu(env, userId, TXT.followOk(username));
}

async function handleCallback(env: Env, cq: any) {
  const userId = cq.from.id;
  const data = String(cq.data || "");

  // remove loading spinner
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data === "menu:back") {
    const dest = await getDestination(env.DB, userId);
    return sendMenu(env, userId, TXT.start(!!dest?.verified));
  }

  if (data === "menu:help") return sendMenu(env, userId, TXT.help);
  if (data === "menu:list") return showList(env, userId);
  if (data === "menu:cancel") {
    await clearState(env.DB, userId);
    return sendMenu(env, userId, TXT.cancelOk);
  }

  if (data === "menu:newdest") return createDestToken(env, userId);
  if (data === "menu:follow") return startFollowFlow(env, userId);

  if (data === "menu:testdest") {
    const dest = await getDestination(env.DB, userId);
    if (!dest?.verified) return sendMenu(env, userId, TXT.destMissing);

    await tg(env, "sendMessage", { chat_id: dest.chat_id, text: "✅ Test: bot can post here." });
    return sendMenu(env, userId, TXT.testSent);
  }

  if (data.startsWith("act:unfollow:")) {
    const u = data.split(":").slice(2).join(":");
    await env.DB.prepare("DELETE FROM user_sources WHERE user_id=? AND username=?").bind(userId, u).run();
    return sendMenu(env, userId, TXT.unfollowOk(u));
  }

  return sendMenu(env, userId, "Unsupported action.");
}

/** ---------- Destination claim via channel_post: DEST <token> ---------- **/

function parseDestClaim(text: string): string | null {
  const t = (text || "").trim();
  const m = /^DEST\s+([A-Za-z0-9_-]{6,64})$/.exec(t);
  return m ? m[1] : null;
}

async function handleChannelPost(env: Env, msg: any) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";

  const token = parseDestClaim(text);
  if (!token) return;

  const row = await env.DB
    .prepare("SELECT token, user_id FROM pending_claims WHERE token=? AND kind='dest'")
    .bind(token)
    .first<any>();

  if (!row) return;

  const userId = row.user_id;

  await env.DB
    .prepare("INSERT OR REPLACE INTO destinations(user_id, chat_id, verified, created_at) VALUES(?, ?, 1, ?)")
    .bind(userId, chatId, nowSec())
    .run();

  await env.DB.prepare("DELETE FROM pending_claims WHERE token=?").bind(token).run();

  await sendMenu(env, userId, TXT.destVerified(chatId));
}

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

/** ---------- Cron: poll + atomic dedupe lock ---------- **/

async function runScrapeTick(env: Env) {
  const followed = await env.DB.prepare("SELECT DISTINCT username FROM user_sources").all<any>();
  console.log("tick usernames:", followed.results.map((r: any) => r.username));

  for (const row of followed.results) {
    const username = String(row.username);

    try {
      const source = await env.DB
        .prepare("SELECT last_post_id FROM sources WHERE username=?")
        .bind(username)
        .first<any>();

      const lastSeen = Number(source?.last_post_id ?? 0);

      const html = await fetchTme(username);
      const posts = scrapeTmePreview(username, html);

      if (!posts.length) {
        await env.DB.prepare("UPDATE sources SET updated_at=? WHERE username=?").bind(nowSec(), username).run();
        continue;
      }

      let newPosts = posts.filter((p) => p.postId > lastSeen);
      if (lastSeen === 0 && newPosts.length > FIRST_SYNC_LIMIT) newPosts = newPosts.slice(-FIRST_SYNC_LIMIT);
      if (!newPosts.length) {
        await env.DB.prepare("UPDATE sources SET updated_at=? WHERE username=?").bind(nowSec(), username).run();
        continue;
      }

      const subs = await env.DB.prepare(
        `SELECT us.user_id, d.chat_id AS dest_chat_id
         FROM user_sources us
         JOIN destinations d ON d.user_id = us.user_id
         WHERE us.username=? AND d.verified=1`
      )
        .bind(username)
        .all<any>();

      for (const post of newPosts) {
        for (const sub of subs.results) {
          const userId = Number(sub.user_id);
          const destChatId = Number(sub.dest_chat_id);

          // atomic dedupe lock: prevents duplicates even if ticks overlap
          const lock = await env.DB
            .prepare("INSERT OR IGNORE INTO deliveries(user_id, username, post_id, created_at) VALUES(?, ?, ?, ?)")
            .bind(userId, username, post.postId, nowSec())
            .run();

          if ((lock as any)?.meta?.changes === 0) continue;

          try {
            await sendPostToDestination(env, destChatId, username, post);
          } catch (e) {
            // allow retry later
            await env.DB
              .prepare("DELETE FROM deliveries WHERE user_id=? AND username=? AND post_id=?")
              .bind(userId, username, post.postId)
              .run();
            console.log("send failed", username, post.postId, String(e));
          }
        }
      }

      const maxId = newPosts[newPosts.length - 1].postId;
      await env.DB
        .prepare("UPDATE sources SET last_post_id=?, updated_at=? WHERE username=?")
        .bind(maxId, nowSec(), username)
        .run();
    } catch (e) {
      console.log("scrape tick error", username, String(e));
    }
  }
}

/** ---------- Routes ---------- **/

app.get("/", (c) => c.text("ok"));

app.post("/telegram", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (c.env.WEBHOOK_SECRET && secret && secret !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);

  const update = await c.req.json<TgUpdate>();
  c.executionCtx.waitUntil(processUpdate(c.env, update));
  return c.json({ ok: true });
});

// Optional local dev endpoint
app.post("/admin/run-scrape", async (c) => {
  const key = c.req.query("key");
  if (key !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  await runScrapeTick(c.env);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScrapeTick(env));
  },
};
