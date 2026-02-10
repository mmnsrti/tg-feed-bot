import { Env, Lang, ScrapedPost } from "../types";
import { tg } from "./client";
import { S, backKeyboard, backfillKeyboard, cancelKeyboard, channelKeyboard, filtersKeyboard, homeKeyboard, settingsKeyboard } from "./ui";
import {
  addUserSource,
  clearState,
  clamp,
  countUserSources,
  deleteUserSource,
  ensurePrefs,
  ensureSource,
  getDestination,
  getState,
  getUserSource,
  listUserSources,
  nowSec,
  setDestinationVerified,
  setPrefs,
  setState,
  updateUserSourceBackfill,
  updateUserSourceFilters,
  updateUserSourceLabel,
  updateUserSourceMode,
  updateUserSourcePaused,
  clearUserSourceFilters,
  upsertUser,
} from "../db/repo";
import { fetchTme, scrapeTmePreview } from "../scraper/tme";
import { deliverRealtime, MIN_POLL_SEC } from "../ticker/do";
import { shouldStoreScrapedPosts } from "../config";

const LIST_PAGE_SIZE = 8;
const MAX_LABEL_LEN = 32;

/** ------------------- helpers ------------------- */
async function sendOrEdit(
  env: Env,
  opts: {
    chat_id: number;
    text: string;
    reply_markup?: any;
    parse_mode?: "HTML";
    disable_web_page_preview?: boolean;
    message_id?: number;
  }
) {
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

function normalizeSearchQuery(input: string) {
  const raw = (input || "").trim();
  if (!raw) return null;

  const looksLikeHandle = raw.startsWith("@") || /t\.me\//i.test(raw);
  if (!looksLikeHandle) return null;

  let s = raw;
  s = s.replace(/^https?:\/\/t\.me\/s\//i, "");
  s = s.replace(/^https?:\/\/t\.me\//i, "");
  s = s.replace(/^t\.me\/s\//i, "");
  s = s.replace(/^t\.me\//i, "");
  if (s.startsWith("@")) s = s.slice(1);

  s = s.trim();
  if (!/^[A-Za-z0-9_]{2,32}$/.test(s)) return null;
  return s;
}

function parseKeywords(raw: any): string[] {
  try {
    if (!raw) return [];
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** ------------------- menus ------------------- */
async function sendHome(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const count = await countUserSources(env.DB, userId);
  const s = S(prefs.lang);

  const destStatus = !dest ? s.destNotSet : dest.verified ? s.destVerified : s.destNotVerified;
  const quiet = prefs.quiet_start < 0 || prefs.quiet_end < 0 ? s.quietOff : s.quietRange(prefs.quiet_start, prefs.quiet_end);

  const text = [
    s.title,
    "",
    `${s.destinationLabel}: ${destStatus}`,
    `${s.realtimeLabel}: ${prefs.realtime_enabled ? s.realtimeOn : s.realtimeOff}`,
    `${s.quietLabel}: ${quiet}`,
    `${s.followedLabel}: ${count}`,
    "",
    s.homeHint,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: homeKeyboard(prefs.lang, !!dest?.verified) });
}

async function showHelp(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  await sendOrEdit(env, { chat_id: userId, message_id, text: S(prefs.lang).helpText, reply_markup: homeKeyboard(prefs.lang, !!dest?.verified) });
}

async function showSettings(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  const quiet = prefs.quiet_start < 0 || prefs.quiet_end < 0 ? s.quietOff : s.quietRange(prefs.quiet_start, prefs.quiet_end);
  const styleName = prefs.post_style === "compact" ? s.styleCompact : s.styleRich;
  const fullStyleName = prefs.full_text_style === "plain" ? s.stylePlain : s.styleQuote;

  const text = [
    s.settingsTitle,
    "",
    `${s.realtime}: ${prefs.realtime_enabled ? s.realtimeOn : s.realtimeOff}`,
    `${s.digest}: ${prefs.digest_hours} ${s.hours}`,
    `${s.quiet}: ${quiet}`,
    `${s.defaultBackfill}: ${prefs.default_backfill_n}`,
    `${s.postStyle}: ${styleName}`,
    `${s.fullTextStyle}: ${fullStyleName}`,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: settingsKeyboard(prefs.lang, prefs, !!dest?.verified) });
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

  const text = [`✅ ${s.destTitle}`, "", s.destSteps, "", s.copyHint].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: backKeyboard(prefs.lang, "m:home") });
  await tg(env, "sendMessage", { chat_id: userId, text: `<pre>${line}</pre>`, parse_mode: "HTML" });
}

async function startFollowFlow(env: Env, userId: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  if (!dest?.verified) {
    await tg(env, "sendMessage", { chat_id: userId, text: s.needDestFirst, reply_markup: homeKeyboard(prefs.lang, false) });
    return;
  }

  await setState(env.DB, userId, "await_follow_username");
  await tg(env, "sendMessage", { chat_id: userId, text: s.sendUsername, reply_markup: cancelKeyboard(prefs.lang) });
}

async function showList(env: Env, userId: number, page: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const total = await countUserSources(env.DB, userId);
  const offset = page * LIST_PAGE_SIZE;

  const list = await listUserSources(env.DB, userId, LIST_PAGE_SIZE, offset);

  if (!list.length) {
    await clearState(env.DB, userId);
    await sendOrEdit(env, {
      chat_id: userId,
      message_id,
      text: `${s.myChannels}\n\n${s.listEmpty}`,
      reply_markup: homeKeyboard(prefs.lang, true),
    });
    return;
  }

  await setState(env.DB, userId, "list_browse", { page });

  const hasPrev = page > 0;
  const hasNext = offset + list.length < total;

  const lines = list.map((r) => {
    const u = String(r.username);
    const paused = Number(r.paused) === 1;
    const statusIcon = paused ? "⏸" : r.mode === "digest" ? "🧾" : "⚡";
    const include = parseKeywords(r.include_keywords);
    const exclude = parseKeywords(r.exclude_keywords);
    const filtersCount = include.length + exclude.length;
    const filtersPart = s.filtersCount(filtersCount);
    const lastPart = r.last_post_id ? `  ${s.lastSeenLabel}: ${r.last_post_id}` : "";
    return `• @${u}  ${statusIcon}  ${filtersPart}${lastPart}`;
  });

  const keyboardRows = list.map((r) => [{ text: `⚙️ @${r.username}`, callback_data: `m:channel:${r.username}` }]);

  const navRow: any[] = [];
  if (hasPrev) navRow.push({ text: "⬅️", callback_data: `m:list:${page - 1}` });
  navRow.push({ text: s.back, callback_data: "m:home" });
  if (hasNext) navRow.push({ text: "➡️", callback_data: `m:list:${page + 1}` });

  await sendOrEdit(env, {
    chat_id: userId,
    message_id,
    text: `${s.myChannels}\n\n${lines.join("\n")}\n\n${s.listHint}\n${s.listSearchHint}`,
    reply_markup: { inline_keyboard: [...keyboardRows, [{ text: s.addChannel, callback_data: "m:follow" }], navRow] },
  });
}

async function showChannelSettings(env: Env, userId: number, username: string, message_id?: number) {
  await clearState(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const sub = await getUserSource(env.DB, userId, username);

  if (!sub) {
    await sendOrEdit(env, { chat_id: userId, message_id, text: s.channelNotFound, reply_markup: backKeyboard(prefs.lang, "m:list:0") });
    return;
  }

  const include = parseKeywords(sub.include_keywords);
  const exclude = parseKeywords(sub.exclude_keywords);
  const label = (sub.label || "").toString().trim() || s.defaultLabel;

  const text = [
    s.chSettingsTitle(username),
    `${s.statusLabel}: ${sub.paused ? s.statusPaused : s.statusActive}`,
    `${s.modeLabel}: ${sub.mode === "digest" ? s.modeDigest : s.modeRealtime}`,
    `${s.labelLabel}: ${label}`,
    `${s.backfill}: ${Number(sub.backfill_n ?? 3)}`,
    "",
    `${s.includeLabel}: ${include.length ? include.join(", ") : "—"}`,
    `${s.excludeLabel}: ${exclude.length ? exclude.join(", ") : "—"}`,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: channelKeyboard(prefs.lang, username, Number(sub.paused), String(sub.mode)) });
}

async function showFilters(env: Env, userId: number, username: string, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  await sendOrEdit(env, { chat_id: userId, message_id, text: S(prefs.lang).filtersTitle(username), reply_markup: filtersKeyboard(prefs.lang, username) });
}

async function handleListSearch(env: Env, userId: number, query: string) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);
  const q = query.toLowerCase();

  const exact = await env.DB
    .prepare("SELECT username FROM user_sources WHERE user_id=? AND lower(username)=?")
    .bind(userId, q)
    .first<any>();

  if (exact?.username) return showChannelSettings(env, userId, String(exact.username));

  const rows = await env.DB
    .prepare("SELECT username FROM user_sources WHERE user_id=? AND lower(username) LIKE ? ORDER BY username ASC LIMIT 8")
    .bind(userId, `%${q}%`)
    .all<any>();

  const matches = (rows.results || []).map((r) => String(r.username));

  await setState(env.DB, userId, "list_browse", { query: q });

  if (!matches.length) {
    await tg(env, "sendMessage", { chat_id: userId, text: `${s.listMatchesTitle}\n\n${s.listNoMatches}`, reply_markup: backKeyboard(prefs.lang, "m:list:0") });
    return;
  }

  const lines = matches.map((u) => `• @${u}`).join("\n");
  const keyboard = {
    inline_keyboard: [...matches.map((u) => [{ text: `@${u}`, callback_data: `m:channel:${u}` }]), [{ text: s.back, callback_data: "m:list:0" }]],
  };

  await tg(env, "sendMessage", { chat_id: userId, text: `${s.listMatchesTitle}\n\n${lines}`, reply_markup: keyboard });
}

/** ------------------- follow input ------------------- */
async function handleFollowInput(env: Env, userId: number, input: string) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  const username = normalizeUsername(input);
  if (!username) {
    await tg(env, "sendMessage", { chat_id: userId, text: s.invalidFormat, reply_markup: cancelKeyboard(prefs.lang) });
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
      await tg(env, "sendMessage", { chat_id: userId, text: s.couldntRead(username), reply_markup: cancelKeyboard(prefs.lang) });
      return;
    }
  } catch {
    await tg(env, "sendMessage", { chat_id: userId, text: s.fetchFailed, reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }

  await ensureSource(env.DB, username, MIN_POLL_SEC);

  const backfillN = clamp(Number(prefs.default_backfill_n ?? 3), 0, 10);
  await addUserSource(env.DB, userId, username, backfillN);

  const backfill = backfillN > 0 ? posts.slice(-backfillN) : [];

  if (shouldStoreScrapedPosts(env) && backfill.length) {
    for (const p of backfill) {
      await env.DB
        .prepare("INSERT OR IGNORE INTO scraped_posts(username, post_id, text, link, media_json, scraped_at) VALUES(?, ?, ?, ?, ?, ?)")
        .bind(username, p.postId, p.text || "", p.link, JSON.stringify(p.media || []), nowSec())
        .run();
    }
  }

  if (prefs.realtime_enabled && backfill.length) {
    for (const p of backfill) {
      await deliverRealtime(env, userId, Number(dest.chat_id), username, null, p, prefs).catch(() => {});
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
    reply_markup: homeKeyboard(prefs.lang, true),
  });
}

/** ------------------- destination claim ------------------- */
function parseDestClaim(text: string): string | null {
  const m = /^DEST\s+([A-Za-z0-9_-]{6,64})$/.exec((text || "").trim());
  return m ? m[1] : null;
}

export async function handleChannelPost(env: Env, msg: any) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";

  const token = parseDestClaim(text);
  if (!token) return;

  const row = await env.DB.prepare("SELECT token, user_id FROM pending_claims WHERE token=? AND kind='dest'").bind(token).first<any>();
  if (!row) return;

  const userId = Number(row.user_id);

  await setDestinationVerified(env.DB, userId, chatId);
  await env.DB.prepare("DELETE FROM pending_claims WHERE token=?").bind(token).run();

  await sendHome(env, userId);
}

/** ------------------- callbacks ------------------- */
export async function handleCallback(env: Env, cq: any) {
  const userId = cq.from.id;
  await upsertUser(env.DB, userId);

  const prefs = await ensurePrefs(env.DB, userId);

  const data = String(cq.data || "");
  const message_id = cq?.message?.message_id as number | undefined;

  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data === "m:home") {
    await clearState(env.DB, userId);
    return sendHome(env, userId, message_id);
  }
  if (data === "m:help") {
    await clearState(env.DB, userId);
    return showHelp(env, userId, message_id);
  }
  if (data === "m:settings") {
    await clearState(env.DB, userId);
    return showSettings(env, userId, message_id);
  }

  if (data === "m:newdest") {
    await clearState(env.DB, userId);
    return createDestToken(env, userId, message_id);
  }
  if (data === "m:follow") {
    await clearState(env.DB, userId);
    return startFollowFlow(env, userId);
  }

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

  if (data === "set:style") {
    const next = prefs.post_style === "compact" ? "rich" : "compact";
    await setPrefs(env.DB, userId, { post_style: next });
    return showSettings(env, userId, message_id);
  }

  if (data === "set:fulltext") {
    const next = prefs.full_text_style === "plain" ? "quote" : "plain";
    await setPrefs(env.DB, userId, { full_text_style: next });
    return showSettings(env, userId, message_id);
  }

  if (data === "set:digest") {
    await setState(env.DB, userId, "await_digest_hours");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).digestAskHours, reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }

  if (data === "set:quiet") {
    await setState(env.DB, userId, "await_quiet_hours");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).quietAsk, reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }

  if (data === "set:dbf") {
    await setState(env.DB, userId, "await_default_backfill");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).backfillAsk, reply_markup: cancelKeyboard(prefs.lang) });
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
    await updateUserSourcePaused(env.DB, userId, u, 1);
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("c:resume:")) {
    const u = data.split(":").slice(2).join(":");
    await updateUserSourcePaused(env.DB, userId, u, 0);
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("c:mode:")) {
    const parts = data.split(":");
    const mode = parts[2];
    const u = parts.slice(3).join(":");
    if (mode !== "realtime" && mode !== "digest") return;
    await updateUserSourceMode(env.DB, userId, u, mode);
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("c:label:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_label", { username: u });
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).labelPrompt(u), reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }
  if (data.startsWith("c:unfollow:")) {
    const u = data.split(":").slice(2).join(":");
    await deleteUserSource(env.DB, userId, u);
    return showList(env, userId, 0, message_id);
  }

  if (data.startsWith("f:menu:")) {
    const u = data.split(":").slice(2).join(":");
    return showFilters(env, userId, u, message_id);
  }
  if (data.startsWith("f:clear:")) {
    const u = data.split(":").slice(2).join(":");
    await clearUserSourceFilters(env.DB, userId, u);
    return showChannelSettings(env, userId, u, message_id);
  }
  if (data.startsWith("f:set_inc:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_include_keywords", { username: u });
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).incPrompt(u), reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }
  if (data.startsWith("f:set_exc:")) {
    const u = data.split(":").slice(2).join(":");
    await setState(env.DB, userId, "await_exclude_keywords", { username: u });
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).excPrompt(u), reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }

  if (data.startsWith("bf:menu:")) {
    const u = data.split(":").slice(2).join(":");
    await sendOrEdit(env, { chat_id: userId, message_id, text: S(prefs.lang).backfillMenu(u), reply_markup: backfillKeyboard(prefs.lang, u) });
    return;
  }
  if (data.startsWith("bf:set:")) {
    const parts = data.split(":");
    const u = parts[2];
    const n = clamp(Number(parts[3] || 3), 0, 10);
    await updateUserSourceBackfill(env.DB, userId, u, n);
    return showChannelSettings(env, userId, u, message_id);
  }

  if (data === "m:cancel") {
    await clearState(env.DB, userId);
    return sendHome(env, userId, message_id);
  }
}

/** ------------------- private messages ------------------- */
export async function handlePrivateMessage(env: Env, msg: any) {
  const userId = msg.from.id;
  const text = msg.text || "";

  await upsertUser(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const cmd = parseCmd(text);
  if (cmd) {
    if (cmd.cmd === "/start") {
      await clearState(env.DB, userId);
      return sendHome(env, userId);
    }
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
    const sub = await getUserSource(env.DB, userId, u);
    const exclude = sub ? parseKeywords(sub.exclude_keywords) : [];
    await updateUserSourceFilters(env.DB, userId, u, arr, exclude);
    await clearState(env.DB, userId);
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "await_exclude_keywords") {
    const u = String(st.data?.username || "");
    const arr = text.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
    const sub = await getUserSource(env.DB, userId, u);
    const include = sub ? parseKeywords(sub.include_keywords) : [];
    await updateUserSourceFilters(env.DB, userId, u, include, arr);
    await clearState(env.DB, userId);
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "await_digest_hours") {
    const n = Number(text.trim());
    if (!Number.isFinite(n) || n < 1 || n > 24) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.invalidNumber, reply_markup: cancelKeyboard(prefs.lang) });
      return;
    }
    await setPrefs(env.DB, userId, { digest_hours: Math.floor(n) });
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: s.digestSaved });
    return showSettings(env, userId);
  }

  if (st?.state === "await_default_backfill") {
    const n = Number(text.trim());
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.invalidNumber, reply_markup: cancelKeyboard(prefs.lang) });
      return;
    }
    await setPrefs(env.DB, userId, { default_backfill_n: Math.floor(n) });
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: s.backfillSaved });
    return showSettings(env, userId);
  }

  if (st?.state === "await_quiet_hours") {
    const low = text.trim().toLowerCase();
    if (low === "off") {
      await setPrefs(env.DB, userId, { quiet_start: -1, quiet_end: -1 });
      await clearState(env.DB, userId);
      await tg(env, "sendMessage", { chat_id: userId, text: s.quietDisabled });
      return showSettings(env, userId);
    }
    const parts = low.split(/\s+/);
    if (parts.length < 2) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.invalidNumber, reply_markup: cancelKeyboard(prefs.lang) });
      return;
    }
    const qs = clamp(Number(parts[0]), 0, 23);
    const qe = clamp(Number(parts[1]), 0, 23);
    await setPrefs(env.DB, userId, { quiet_start: qs, quiet_end: qe });
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: s.quietSaved });
    return showSettings(env, userId);
  }

  if (st?.state === "await_label") {
    const u = String(st.data?.username || "");
    const raw = text.replace(/\s+/g, " ").trim();
    const lower = raw.toLowerCase();
    const shouldClear = !raw || raw === "-" || lower === "off" || lower === "clear";

    if (shouldClear) {
      await updateUserSourceLabel(env.DB, userId, u, null);
      await clearState(env.DB, userId);
      await tg(env, "sendMessage", { chat_id: userId, text: s.labelCleared });
      return showChannelSettings(env, userId, u);
    }

    if (raw.length > MAX_LABEL_LEN) {
      await tg(env, "sendMessage", { chat_id: userId, text: s.labelTooLong, reply_markup: cancelKeyboard(prefs.lang) });
      return;
    }

    await updateUserSourceLabel(env.DB, userId, u, raw);
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: s.labelSaved });
    return showChannelSettings(env, userId, u);
  }

  if (st?.state === "list_browse") {
    const q = normalizeSearchQuery(text);
    if (q) return handleListSearch(env, userId, q);
    return showList(env, userId, Number(st.data?.page ?? 0) || 0);
  }

  return sendHome(env, userId);
}
