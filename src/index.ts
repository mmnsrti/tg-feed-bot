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
const FIRST_SYNC_LIMIT = 5; // only send last 5 posts on first follow

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeUsername(input: string) {
  let s = (input || "").trim();
  if (!s) return null;

  // Accept @name, t.me/name, https://t.me/name, https://t.me/s/name
  s = s.replace(/^https?:\/\/t\.me\/s\//i, "");
  s = s.replace(/^https?:\/\/t\.me\//i, "");
  s = s.replace(/^t\.me\/s\//i, "");
  s = s.replace(/^t\.me\//i, "");
  if (s.startsWith("@")) s = s.slice(1);

  if (!/^[A-Za-z0-9_]{5,64}$/.test(s)) return null;
  return s;
}

/**
 * Telegram API caller with 429 retry_after support.
 */
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

/** ---------- HTML helpers for scraping ---------- **/

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
  text: string; // might be empty if no text or fallback-only
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

/**
 * Robust scraper:
 * - Primary: scan all data-post="SomeCase/123", match username case-insensitively.
 * - Extract text from tgme_widget_message_text near each post container.
 * - Fallback: scan href="https://t.me/<chan>/<id>" links if data-post parsing yields 0.
 */
function scrapeTmePreview(username: string, html: string): ScrapedPost[] {
  const wanted = username.toLowerCase();
  const posts: ScrapedPost[] = [];

  // Primary: data-post="ChannelName/123"
  const re = /data-post="([^"\/]+)\/(\d+)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const chan = m[1].toLowerCase();
    if (chan !== wanted) continue;

    const postId = Number(m[2]);
    if (!Number.isFinite(postId)) continue;

    const start = m.index;

    // Find the message container start to constrain to one post:
    const slice = html.slice(start, start + 50000);

    // Text block usually present; if absent, we’ll keep it empty and rely on link.
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

  // Fallback if Telegram changes data-post format
  if (!posts.length) {
    const re2 = /href="https:\/\/t\.me\/([^"\/]+)\/(\d+)"/g;
    while ((m = re2.exec(html)) !== null) {
      if (m[1].toLowerCase() !== wanted) continue;
      const postId = Number(m[2]);
      if (!Number.isFinite(postId)) continue;
      posts.push({
        postId,
        text: "",
        link: `https://t.me/${m[1]}/${postId}`,
      });
    }
  }

  // De-dupe + sort
  const uniq = new Map<number, ScrapedPost>();
  for (const p of posts) uniq.set(p.postId, p);
  return [...uniq.values()].sort((a, b) => a.postId - b.postId);
}

/** ---------- Delivery ---------- **/

async function sendPostToDestination(env: Env, destChatId: number, username: string, post: ScrapedPost) {
  // Keep it plain text (no parse_mode)
  const header = `@${username}`;
  const body = post.text ? post.text : "(no text)";
  const msg = `${header}\n${post.link}\n\n${body}`.slice(0, 3900); // keep < 4096
  await tg(env, "sendMessage", { chat_id: destChatId, text: msg });
}

/** ---------- Bot DM commands ---------- **/

async function handlePrivateMessage(env: Env, msg: any) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  await upsertUser(env.DB, userId);

  const send = (t: string) => tg(env, "sendMessage", { chat_id: chatId, text: t });
  const parsed = parseCmd(text);
  if (!parsed) return;

  if (parsed.cmd === "/start") {
    return send(
      [
        "Commands:",
        "/newdest → verify your destination channel (I must be admin there).",
        "/follow @username → follow a public channel by username (scrapes t.me/s).",
        "/unfollow @username",
        "/list",
        "",
        "Local cron test: run wrangler with --test-scheduled then call /__scheduled",
      ].join("\n")
    );
  }

  if (parsed.cmd === "/newdest") {
    const token = makeToken();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO pending_claims(token, user_id, kind, created_at) VALUES(?, ?, 'dest', ?)"
    )
      .bind(token, userId, nowSec())
      .run();

    return send(
      [
        `DEST token: ${token}`,
        "",
        "1) Create your destination channel.",
        "2) Add this bot as ADMIN in that channel.",
        "3) Post this exact message in that channel:",
        `DEST ${token}`,
      ].join("\n")
    );
  }

  if (parsed.cmd === "/follow") {
    const u = normalizeUsername(parsed.args[0] || "");
    if (!u) return send("Usage: /follow @channelusername");

    await env.DB.prepare(
      "INSERT OR IGNORE INTO sources(username, last_post_id, updated_at) VALUES(?, 0, ?)"
    )
      .bind(u, nowSec())
      .run();

    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_sources(user_id, username, created_at) VALUES(?, ?, ?)"
    )
      .bind(userId, u, nowSec())
      .run();

    return send(`✅ Following @${u}. I’ll check it on the schedule.`);
  }

  if (parsed.cmd === "/unfollow") {
    const u = normalizeUsername(parsed.args[0] || "");
    if (!u) return send("Usage: /unfollow @channelusername");

    await env.DB.prepare("DELETE FROM user_sources WHERE user_id=? AND username=?")
      .bind(userId, u)
      .run();

    return send(`🧹 Unfollowed @${u}.`);
  }

  if (parsed.cmd === "/list") {
    const dest = await env.DB.prepare("SELECT chat_id, verified FROM destinations WHERE user_id=?")
      .bind(userId)
      .first<any>();

    const follows = await env.DB.prepare(
      "SELECT username FROM user_sources WHERE user_id=? ORDER BY username ASC"
    )
      .bind(userId)
      .all<any>();

    return send(
      [
        `Destination: ${dest ? `${dest.chat_id} (verified=${dest.verified})` : "not set"}`,
        `Following: ${
          follows.results.length ? follows.results.map((r: any) => `@${r.username}`).join(", ") : "none"
        }`,
      ].join("\n")
    );
  }

  return send("Unknown command. Try /start");
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

  const row = await env.DB.prepare(
    "SELECT token, user_id FROM pending_claims WHERE token=? AND kind='dest'"
  )
    .bind(token)
    .first<any>();

  if (!row) return;

  const userId = row.user_id;

  await env.DB.prepare(
    "INSERT OR REPLACE INTO destinations(user_id, chat_id, verified, created_at) VALUES(?, ?, 1, ?)"
  )
    .bind(userId, chatId, nowSec())
    .run();

  await env.DB.prepare("DELETE FROM pending_claims WHERE token=?")
    .bind(token)
    .run();

  await tg(env, "sendMessage", { chat_id: userId, text: `✅ Destination verified: ${chatId}` });
}

async function processUpdate(env: Env, update: TgUpdate) {
  if (update.message && update.message.chat?.type === "private") {
    await handlePrivateMessage(env, update.message);
    return;
  }
  if (update.channel_post) {
    await handleChannelPost(env, update.channel_post);
    return;
  }
}

/** ---------- Cron: poll followed usernames and deliver new posts ---------- **/

async function runScrapeTick(env: Env) {
  const followed = await env.DB.prepare("SELECT DISTINCT username FROM user_sources").all<any>();

  for (const row of followed.results) {
    const username = String(row.username);

    try {
      const source = await env.DB.prepare("SELECT last_post_id FROM sources WHERE username=?")
        .bind(username)
        .first<any>();

      const lastSeen = Number(source?.last_post_id ?? 0);

      const html = await fetchTme(username);
      const posts = scrapeTmePreview(username, html);

      if (!posts.length) {
        // If t.me served something unexpected (block, empty, etc.)
        await env.DB.prepare("UPDATE sources SET updated_at=? WHERE username=?")
          .bind(nowSec(), username)
          .run();
        continue;
      }

      let newPosts = posts.filter((p) => p.postId > lastSeen);

      // First sync: avoid flooding + 429s
      if (lastSeen === 0 && newPosts.length > FIRST_SYNC_LIMIT) {
        newPosts = newPosts.slice(-FIRST_SYNC_LIMIT);
      }

      if (!newPosts.length) {
        await env.DB.prepare("UPDATE sources SET updated_at=? WHERE username=?")
          .bind(nowSec(), username)
          .run();
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

      // Deliver in order
      for (const post of newPosts) {
        for (const sub of subs.results) {
          const userId = Number(sub.user_id);
          const destChatId = Number(sub.dest_chat_id);

          // per-user dedupe
          const exists = await env.DB.prepare(
            "SELECT 1 FROM deliveries WHERE user_id=? AND username=? AND post_id=?"
          )
            .bind(userId, username, post.postId)
            .first();

          if (exists) continue;

          try {
            await sendPostToDestination(env, destChatId, username, post);

            // Only mark delivered AFTER successful send
            await env.DB.prepare(
              "INSERT INTO deliveries(user_id, username, post_id, created_at) VALUES(?, ?, ?, ?)"
            )
              .bind(userId, username, post.postId, nowSec())
              .run();
          } catch (e) {
            console.log("send failed", username, post.postId, String(e));
            // Don't insert deliveries row -> it will retry next tick
          }
        }
      }

      // Advance source cursor so we don’t reprocess forever
      const maxId = newPosts[newPosts.length - 1].postId;
      await env.DB.prepare("UPDATE sources SET last_post_id=?, updated_at=? WHERE username=?")
        .bind(maxId, nowSec(), username)
        .run();
    } catch (e) {
      console.log("scrape tick error", username, String(e));
      // move on to next username
      continue;
    }
  }
}

/** ---------- Routes ---------- **/

app.get("/", (c) => c.text("ok"));

app.post("/telegram", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (c.env.WEBHOOK_SECRET && secret && secret !== c.env.WEBHOOK_SECRET) {
    return c.text("forbidden", 403);
  }

  const update = await c.req.json<TgUpdate>();
  c.executionCtx.waitUntil(processUpdate(c.env, update));
  return c.json({ ok: true });
});

// Manual trigger for dev/testing
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
