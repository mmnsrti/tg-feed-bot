import { Env, Lang, ScrapedPost, UserPrefs } from "../types";
import { TelegramError, tg } from "./client";
import {
  S,
  backKeyboard,
  backfillKeyboard,
  cancelKeyboard,
  channelKeyboard,
  destinationManageKeyboard,
  filtersKeyboard,
  followMoreKeyboard,
  globalFiltersKeyboard,
  homeKeyboard,
  settingsKeyboard,
} from "./ui";
import { MAIN_CHANNEL_USERNAME, channelUrl, parseChannelSettingsStartPayload } from "./postLinks";
import {
  addUserSource,
  clearDestination,
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

function extractForwardedUsername(msg: any): string | null {
  const direct = msg?.forward_from_chat?.username || msg?.forward_from?.username;
  if (direct) return normalizeUsername(String(direct));
  const origin = msg?.forward_origin;
  const originChat = origin?.chat?.username;
  if (originChat) return normalizeUsername(String(originChat));
  return null;
}

async function isChannelAdmin(env: Env, channelChatId: number, userId: number): Promise<boolean> {
  if (!Number.isFinite(channelChatId) || !Number.isInteger(channelChatId) || channelChatId === 0) return false;
  try {
    const member = await tg(env, "getChatMember", { chat_id: channelChatId, user_id: userId });
    const status = String(member?.status || "").toLowerCase();
    return status === "creator" || status === "administrator";
  } catch {
    return false;
  }
}

type MainChannelFollowState = "member" | "not_member" | "unknown";

function parseMainChannelFollowState(status: string): MainChannelFollowState {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "creator" || normalized === "administrator" || normalized === "member" || normalized === "restricted") {
    return "member";
  }
  if (normalized === "left" || normalized === "kicked") return "not_member";
  return "unknown";
}

async function getMainChannelFollowState(env: Env, userId: number): Promise<MainChannelFollowState> {
  try {
    const member = await tg(env, "getChatMember", { chat_id: `@${MAIN_CHANNEL_USERNAME}`, user_id: userId });
    return parseMainChannelFollowState(String(member?.status || ""));
  } catch (e: any) {
    if (e instanceof TelegramError) {
      console.log("main-channel follow check failed", userId, e.code, e.description);
    } else {
      console.log("main-channel follow check failed", userId, String(e?.message || e));
    }
    return "unknown";
  }
}

function mainChannelRequiredKeyboard(lang: Lang) {
  const s = S(lang);
  return {
    inline_keyboard: [
      [{ text: s.joinMainChannel, url: channelUrl(MAIN_CHANNEL_USERNAME) }],
      [{ text: s.checkMainChannelFollow, callback_data: "gate:check" }],
    ],
  };
}

async function ensureMainChannelFollow(env: Env, userId: number, lang: Lang): Promise<boolean> {
  const followState = await getMainChannelFollowState(env, userId);
  if (followState === "member") return true;
  // Fail-open on unknown lookup errors to avoid false negatives.
  if (followState === "unknown") return true;

  const s = S(lang);
  await tg(env, "sendMessage", {
    chat_id: userId,
    text: s.mustJoinMainChannel,
    reply_markup: mainChannelRequiredKeyboard(lang),
  });
  return false;
}

function getChatPhotoFileId(chat: any): string | null {
  const big = String(chat?.photo?.big_file_id || "").trim();
  if (big) return big;
  const small = String(chat?.photo?.small_file_id || "").trim();
  if (small) return small;
  return null;
}

async function setDestinationPhotoFromMainChannelIfMissing(env: Env, destinationChatId: number): Promise<boolean> {
  if (!Number.isFinite(destinationChatId) || !Number.isInteger(destinationChatId) || destinationChatId === 0) return false;

  try {
    const destination = await tg(env, "getChat", { chat_id: destinationChatId });
    if (getChatPhotoFileId(destination)) return false;

    const mainChannel = await tg(env, "getChat", { chat_id: `@${MAIN_CHANNEL_USERNAME}` });
    const mainPhotoFileId = getChatPhotoFileId(mainChannel);
    if (!mainPhotoFileId) return false;

    const file = await tg(env, "getFile", { file_id: mainPhotoFileId });
    const path = String(file?.file_path || "").trim();
    if (!path) return false;

    const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
    if (!fileRes.ok) return false;

    const arrayBuffer = await fileRes.arrayBuffer();
    if (!arrayBuffer.byteLength) return false;

    const form = new FormData();
    form.append("chat_id", String(destinationChatId));
    form.append("photo", new Blob([arrayBuffer], { type: fileRes.headers.get("content-type") || "image/jpeg" }), "channel-photo.jpg");

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setChatPhoto`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) return false;

    const data = await res.json<any>();
    return data?.ok === true;
  } catch {
    return false;
  }
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
  return s.toLowerCase();
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

function normalizeKeyword(input: string) {
  return String(input || "").trim().replace(/\s+/g, " ");
}

function dedupeKeywords(keywords: string[], limit = Number.POSITIVE_INFINITY) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    const kw = normalizeKeyword(raw);
    if (!kw) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= limit) break;
  }
  return out;
}

function parseKeywords(raw: any): string[] {
  try {
    if (!raw) return [];
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return dedupeKeywords(arr.map((x) => String(x)));
  } catch {
    return [];
  }
}

type KeywordEdit = {
  mode: "replace" | "patch";
  add: string[];
  remove: string[];
  clear: boolean;
};

function splitKeywordTokens(input: string) {
  return String(input || "")
    .split(/[,\n،;]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseKeywordEditInput(input: string): KeywordEdit {
  const raw = String(input || "").trim();
  if (!raw || /^(?:clear|پاک)$/i.test(raw)) {
    return { mode: "replace", add: [], remove: [], clear: true };
  }

  const tokens = splitKeywordTokens(raw);
  const addRaw: string[] = [];
  const removeRaw: string[] = [];
  let hasPrefixedOps = false;

  for (const token of tokens) {
    if (token.startsWith("+") || token.startsWith("-")) {
      hasPrefixedOps = true;
      const body = normalizeKeyword(token.slice(1));
      if (!body) continue;
      if (token.startsWith("+")) addRaw.push(body);
      else removeRaw.push(body);
      continue;
    }
    addRaw.push(token);
  }

  if (!hasPrefixedOps) {
    return { mode: "replace", add: dedupeKeywords(addRaw), remove: [], clear: false };
  }

  return {
    mode: "patch",
    add: dedupeKeywords(addRaw),
    remove: dedupeKeywords(removeRaw),
    clear: false,
  };
}

function applyKeywordEdit(current: string[], input: string, limit: number): string[] {
  const edit = parseKeywordEditInput(input);
  if (edit.mode === "replace") {
    if (edit.clear) return [];
    return dedupeKeywords(edit.add, limit);
  }

  const base = dedupeKeywords(current);
  const removeSet = new Set(edit.remove.map((x) => x.toLowerCase()));
  const out = base.filter((x) => !removeSet.has(x.toLowerCase()));
  const seen = new Set(out.map((x) => x.toLowerCase()));

  for (const kw of edit.add) {
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function extractUsernamesFromText(input: string): { usernames: string[]; invalid: string[] } {
  const raw = (input || "").trim();
  const usernames = new Set<string>();
  const invalid = new Set<string>();
  const seen = new Set<string>();

  const consider = (token: string) => {
    const t = (token || "").trim();
    if (!t) return;
    if (seen.has(t)) return;
    seen.add(t);
    const u = normalizeUsername(t);
    if (u) usernames.add(u);
    else if (t.includes("t.me") || t.startsWith("@")) invalid.add(t);
  };

  for (const m of raw.matchAll(/https?:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]{2,32})/gi)) consider(m[0]);
  for (const m of raw.matchAll(/t\.me\/(?:s\/)?([A-Za-z0-9_]{2,32})/gi)) consider(m[0]);
  for (const m of raw.matchAll(/@([A-Za-z0-9_]{2,32})/g)) consider(`@${m[1]}`);
  for (const token of raw.split(/[\s,;]+/)) consider(token);

  return { usernames: Array.from(usernames), invalid: Array.from(invalid) };
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

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: homeKeyboard(prefs.lang, !!dest) });
}

async function showHelp(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  await sendOrEdit(env, { chat_id: userId, message_id, text: S(prefs.lang).helpText, reply_markup: homeKeyboard(prefs.lang, !!dest) });
}

async function showSettings(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  const quiet = prefs.quiet_start < 0 || prefs.quiet_end < 0 ? s.quietOff : s.quietRange(prefs.quiet_start, prefs.quiet_end);
  const styleName = prefs.post_style === "compact" ? s.styleCompact : s.styleRich;
  const fullStyleName = prefs.full_text_style === "plain" ? s.stylePlain : s.styleQuote;
  const globalInclude = parseKeywords(prefs.global_include_keywords);
  const globalExclude = parseKeywords(prefs.global_exclude_keywords);

  const text = [
    s.settingsTitle,
    "",
    `${s.realtime}: ${prefs.realtime_enabled ? s.realtimeOn : s.realtimeOff}`,
    `${s.digest}: ${prefs.digest_hours} ${s.hours}`,
    `${s.quiet}: ${quiet}`,
    `${s.defaultBackfill}: ${prefs.default_backfill_n}`,
    `${s.globalFilters}: ${s.globalFiltersSummary(globalInclude.length, globalExclude.length)}`,
    `${s.postStyle}: ${styleName}`,
    `${s.fullTextStyle}: ${fullStyleName}`,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: settingsKeyboard(prefs.lang, prefs, !!dest, !!dest?.verified) });
}

async function startDestinationFlow(env: Env, userId: number, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);
  const dest = await getDestination(env.DB, userId);

  if (!dest) return createDestToken(env, userId, message_id);

  const status = dest.verified ? s.destVerified : s.destNotVerified;
  const text = [s.destManageTitle, "", `${s.destinationLabel}: ${status}`, s.destCurrent(Number(dest.chat_id)), "", s.destManageHint].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: destinationManageKeyboard(prefs.lang) });
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
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: s.needDestFirst, reply_markup: homeKeyboard(prefs.lang, !!dest) });
    return;
  }

  await setState(env.DB, userId, "await_follow_username", { batch: true });
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
    const dest = await getDestination(env.DB, userId);
    await sendOrEdit(env, {
      chat_id: userId,
      message_id,
      text: `${s.myChannels}\n\n${s.listEmpty}`,
      reply_markup: homeKeyboard(prefs.lang, !!dest),
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

  const sourceUsername = String(sub.username || username);

  const include = parseKeywords(sub.include_keywords);
  const exclude = parseKeywords(sub.exclude_keywords);
  const label = (sub.label || "").toString().trim() || sourceUsername;

  const text = [
    s.chSettingsTitle(sourceUsername),
    `${s.statusLabel}: ${sub.paused ? s.statusPaused : s.statusActive}`,
    `${s.modeLabel}: ${sub.mode === "digest" ? s.modeDigest : s.modeRealtime}`,
    `${s.labelLabel}: ${label}`,
    `${s.backfill}: ${Number(sub.backfill_n ?? 3)}`,
    "",
    `${s.includeLabel}: ${include.length ? include.join(", ") : "—"}`,
    `${s.excludeLabel}: ${exclude.length ? exclude.join(", ") : "—"}`,
  ].join("\n");

  await sendOrEdit(env, {
    chat_id: userId,
    message_id,
    text,
    reply_markup: channelKeyboard(prefs.lang, sourceUsername, Number(sub.paused), String(sub.mode)),
  });
}

async function showFilters(env: Env, userId: number, username: string, message_id?: number) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);
  const sub = await getUserSource(env.DB, userId, username);
  const include = parseKeywords(sub?.include_keywords);
  const exclude = parseKeywords(sub?.exclude_keywords);
  const text = [
    s.filtersTitle(username),
    "",
    `${s.includeLabel}: ${include.length ? include.join(", ") : "—"}`,
    `${s.excludeLabel}: ${exclude.length ? exclude.join(", ") : "—"}`,
    "",
    s.filtersEditHint,
  ].join("\n");
  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: filtersKeyboard(prefs.lang, username) });
}

async function showGlobalFilters(env: Env, userId: number, message_id?: number) {
  await clearState(env.DB, userId);
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);
  const include = parseKeywords(prefs.global_include_keywords);
  const exclude = parseKeywords(prefs.global_exclude_keywords);

  const text = [
    s.globalFiltersTitle,
    "",
    `${s.globalFiltersSummary(include.length, exclude.length)}`,
    `${s.includeLabel}: ${include.length ? include.join(", ") : "—"}`,
    `${s.excludeLabel}: ${exclude.length ? exclude.join(", ") : "—"}`,
    "",
    s.filtersEditHint,
  ].join("\n");

  await sendOrEdit(env, { chat_id: userId, message_id, text, reply_markup: globalFiltersKeyboard(prefs.lang) });
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
type FollowResultStatus = "ok" | "already" | "fetch_failed" | "couldnt_read";
type FollowResult = { username: string; status: FollowResultStatus };

type FollowOpts = { batch?: boolean; mode?: "follow" | "import" };

type FollowConfirmState = {
  usernames: string[];
  invalid?: string[];
  batch?: boolean;
  mode?: "follow" | "import";
};

async function followOneChannel(env: Env, userId: number, username: string, prefs: UserPrefs, destChatId: number): Promise<FollowResult> {
  const existing = await getUserSource(env.DB, userId, username);
  if (existing) return { username, status: "already" };

  let posts: ScrapedPost[] = [];
  try {
    const html = await fetchTme(username);
    posts = scrapeTmePreview(username, html);
    if (!posts.length) return { username, status: "couldnt_read" };
  } catch {
    return { username, status: "fetch_failed" };
  }

  await ensureSource(env.DB, username, MIN_POLL_SEC);

  const backfillN = clamp(Number(prefs.default_backfill_n ?? 0), 0, 10);
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
      await deliverRealtime(env, userId, destChatId, username, null, p, prefs).catch(() => {});
    }
  }

  const latestId = posts[posts.length - 1].postId;
  await env.DB
    .prepare(
      "UPDATE sources SET last_post_id=?, updated_at=?, next_check_at=?, check_every_sec=?, fail_count=0, last_error=NULL, last_error_at=0, last_success_at=? WHERE username=?"
    )
    .bind(latestId, nowSec(), nowSec() + MIN_POLL_SEC, MIN_POLL_SEC, nowSec(), username)
    .run();

  return { username, status: "ok" };
}

async function processFollowUsernames(env: Env, userId: number, usernames: string[], invalid: string[] = [], opts: FollowOpts = {}) {
  const prefs = await ensurePrefs(env.DB, userId);
  const dest = await getDestination(env.DB, userId);
  const s = S(prefs.lang);

  if (!dest?.verified) {
    await clearState(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: s.needDestFirst, reply_markup: homeKeyboard(prefs.lang, !!dest) });
    return;
  }

  const unique = Array.from(new Set(usernames));
  const ok: string[] = [];
  const already: string[] = [];
  const failed: string[] = [];

  const destChatId = Number(dest.chat_id);
  for (const u of unique) {
    const res = await followOneChannel(env, userId, u, prefs, destChatId);
    if (res.status === "ok") ok.push(u);
    else if (res.status === "already") already.push(u);
    else failed.push(u);
  }

  const lines: string[] = [s.followSummaryTitle(ok.length, unique.length)];
  if (ok.length) lines.push(`${s.addedLabel}: ${ok.map((u) => `@${u}`).join(", ")}`);
  if (already.length) lines.push(`${s.alreadyLabel}: ${already.map((u) => `@${u}`).join(", ")}`);
  if (failed.length) lines.push(`${s.failedLabel}: ${failed.map((u) => `@${u}`).join(", ")}`);
  if (invalid.length) lines.push(`${s.invalidLabel}: ${invalid.slice(0, 10).join(", ")}`);
  if (opts.batch) lines.push("", s.followMoreHint);

  await tg(env, "sendMessage", { chat_id: userId, text: lines.join("\n"), reply_markup: followMoreKeyboard(prefs.lang) });

  if (opts.batch) {
    await setState(env.DB, userId, "await_follow_username", { batch: true });
  } else {
    await clearState(env.DB, userId);
  }
}

async function promptFollowConfirm(env: Env, userId: number, usernames: string[], invalid: string[] = [], opts: FollowOpts = {}) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const data: FollowConfirmState = { usernames, invalid, batch: opts.batch, mode: opts.mode || "follow" };
  await setState(env.DB, userId, "await_follow_confirm", data);

  const lines = [s.followPreviewTitle, "", ...usernames.map((u) => `- @${u}`)];
  if (invalid.length) lines.push("", `${s.invalidLabel}: ${invalid.slice(0, 10).join(", ")}`);

  const confirm = data.mode === "import" ? "m:import_confirm" : "m:follow_confirm";
  const cancel = data.mode === "import" ? "m:import_cancel" : "m:follow_cancel";

  const keyboard = { inline_keyboard: [[{ text: s.addAll, callback_data: confirm }, { text: s.cancel, callback_data: cancel }]] };
  await tg(env, "sendMessage", { chat_id: userId, text: lines.join("\n"), reply_markup: keyboard });
}

async function handleFollowInput(env: Env, userId: number, input: string, opts: FollowOpts = {}) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const { usernames, invalid } = extractUsernamesFromText(input);
  if (!usernames.length) {
    await tg(env, "sendMessage", { chat_id: userId, text: s.invalidFormat, reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }

  if (opts.mode === "import") {
    await promptFollowConfirm(env, userId, usernames, invalid, opts);
    return;
  }

  if (usernames.length > 1) {
    await promptFollowConfirm(env, userId, usernames, invalid, { ...opts, mode: "follow" });
    return;
  }

  await processFollowUsernames(env, userId, usernames, invalid, opts);
}

async function handleImportInput(env: Env, userId: number, input: string) {
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  const { usernames, invalid } = extractUsernamesFromText(input);
  if (!usernames.length) {
    await tg(env, "sendMessage", { chat_id: userId, text: s.invalidFormat, reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }

  await promptFollowConfirm(env, userId, usernames, invalid, { mode: "import" });
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
  const prefs = await ensurePrefs(env.DB, userId);

  if (!(await ensureMainChannelFollow(env, userId, prefs.lang))) return;

  await setDestinationVerified(env.DB, userId, chatId);
  await setDestinationPhotoFromMainChannelIfMissing(env, Number(chatId));
  await env.DB.prepare("DELETE FROM pending_claims WHERE token=?").bind(token).run();

  await sendHome(env, userId);
}

/** ------------------- callbacks ------------------- */
export async function handleCallback(env: Env, cq: any) {
  const userId = cq.from.id;
  await upsertUser(env.DB, userId, {
    username: cq?.from?.username,
    first_name: cq?.from?.first_name,
    last_name: cq?.from?.last_name,
  });

  const prefs = await ensurePrefs(env.DB, userId);

  const data = String(cq.data || "");
  const message_id = cq?.message?.message_id as number | undefined;

  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data === "gate:check") {
    if (!(await ensureMainChannelFollow(env, userId, prefs.lang))) return;
    await clearState(env.DB, userId);
    return sendHome(env, userId, message_id);
  }

  if (!(await ensureMainChannelFollow(env, userId, prefs.lang))) return;

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
    return startDestinationFlow(env, userId, message_id);
  }
  if (data === "m:dest:change") {
    await clearState(env.DB, userId);
    return createDestToken(env, userId, message_id);
  }
  if (data === "m:dest:delete") {
    await clearState(env.DB, userId);
    await clearDestination(env.DB, userId);
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).destDeleted });
    return sendHome(env, userId, message_id);
  }
  if (data === "m:follow") {
    await clearState(env.DB, userId);
    return startFollowFlow(env, userId);
  }
  if (data === "m:follow_confirm" || data === "m:import_confirm") {
    const st = await getState(env.DB, userId);
    if (!st || st.state !== "await_follow_confirm") return sendHome(env, userId, message_id);

    const payload = st.data || {};
    const usernames = Array.isArray(payload.usernames) ? payload.usernames.map((u: any) => String(u)) : [];
    const invalid = Array.isArray(payload.invalid) ? payload.invalid.map((u: any) => String(u)) : [];
    const batch = !!payload.batch;

    await clearState(env.DB, userId);
    if (!usernames.length) return sendHome(env, userId, message_id);

    await processFollowUsernames(env, userId, usernames, invalid, { batch, mode: data === "m:import_confirm" ? "import" : "follow" });
    return;
  }
  if (data === "m:follow_cancel" || data === "m:import_cancel") {
    const st = await getState(env.DB, userId);
    const batch = !!st?.data?.batch && data === "m:follow_cancel";
    await clearState(env.DB, userId);
    if (batch) {
      await setState(env.DB, userId, "await_follow_username", { batch: true });
      return tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).sendUsername, reply_markup: cancelKeyboard(prefs.lang) });
    }
    return sendHome(env, userId, message_id);
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
  if (data === "set:gfilters") {
    return showGlobalFilters(env, userId, message_id);
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

  if (data === "gf:clear") {
    await setPrefs(env.DB, userId, { global_include_keywords: "[]", global_exclude_keywords: "[]" });
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).globalFiltersCleared });
    return showGlobalFilters(env, userId, message_id);
  }
  if (data === "gf:set_inc") {
    await setState(env.DB, userId, "await_global_include_keywords");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).globalIncPrompt, reply_markup: cancelKeyboard(prefs.lang) });
    return;
  }
  if (data === "gf:set_exc") {
    await setState(env.DB, userId, "await_global_exclude_keywords");
    await tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).globalExcPrompt, reply_markup: cancelKeyboard(prefs.lang) });
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

  await upsertUser(env.DB, userId, {
    username: msg?.from?.username,
    first_name: msg?.from?.first_name,
    last_name: msg?.from?.last_name,
  });
  const prefs = await ensurePrefs(env.DB, userId);
  const s = S(prefs.lang);

  if (!(await ensureMainChannelFollow(env, userId, prefs.lang))) return;

  const cmd = parseCmd(text);
  if (cmd) {
    if (cmd.cmd === "/start") {
      await clearState(env.DB, userId);
      const startArg = String(cmd.args?.[0] || "").trim();
      const settingsPayload = parseChannelSettingsStartPayload(startArg);
      if (settingsPayload) {
        const { username, destinationChatId } = settingsPayload;
        if (destinationChatId !== null) {
          const allowed = await isChannelAdmin(env, destinationChatId, userId);
          if (!allowed) {
            const dest = await getDestination(env.DB, userId);
            await tg(env, "sendMessage", {
              chat_id: userId,
              text: s.settingsAdminsOnly,
              reply_markup: homeKeyboard(prefs.lang, !!dest),
            });
            return;
          }
        }
        return showChannelSettings(env, userId, username);
      }
      return sendHome(env, userId);
    }
    if (cmd.cmd === "/help") return showHelp(env, userId);
    if (cmd.cmd === "/commands") {
      const dest = await getDestination(env.DB, userId);
      return tg(env, "sendMessage", { chat_id: userId, text: s.commandsText, reply_markup: homeKeyboard(prefs.lang, !!dest) });
    }
    if (cmd.cmd === "/newdest") {
      await clearState(env.DB, userId);
      return startDestinationFlow(env, userId);
    }
    if (cmd.cmd === "/changedest") {
      await clearState(env.DB, userId);
      return createDestToken(env, userId);
    }
    if (cmd.cmd === "/list") return showList(env, userId, 0);
    if (cmd.cmd === "/settings") return showSettings(env, userId);
    if (cmd.cmd === "/follow") {
      await clearState(env.DB, userId);
      if (cmd.args.length) return handleFollowInput(env, userId, cmd.args.join(" "), { batch: false, mode: "follow" });
      return startFollowFlow(env, userId);
    }
    if (cmd.cmd === "/import") {
      await clearState(env.DB, userId);
      if (cmd.args.length) return handleImportInput(env, userId, cmd.args.join(" "));
      await setState(env.DB, userId, "await_import_list");
      return tg(env, "sendMessage", { chat_id: userId, text: S(prefs.lang).importPrompt, reply_markup: cancelKeyboard(prefs.lang) });
    }
    if (cmd.cmd === "/cancel") {
      await clearState(env.DB, userId);
      return sendHome(env, userId);
    }
    if (cmd.cmd === "/done") {
      await clearState(env.DB, userId);
      return sendHome(env, userId);
    }
  }

  const st = await getState(env.DB, userId);

  const forwarded = extractForwardedUsername(msg);
  if (forwarded) {
    const fwdText = `@${forwarded}`;
    if (st?.state === "await_import_list") return handleImportInput(env, userId, fwdText);
    if (st?.state === "await_follow_username") return handleFollowInput(env, userId, fwdText, { batch: !!st.data?.batch, mode: "follow" });
    return handleFollowInput(env, userId, fwdText, { batch: false, mode: "follow" });
  }

  if (st?.state === "await_follow_username") return handleFollowInput(env, userId, text, { batch: !!st.data?.batch, mode: "follow" });
  if (st?.state === "await_import_list") return handleImportInput(env, userId, text);

  if (st?.state === "await_include_keywords") {
    const u = String(st.data?.username || "");
    const sub = await getUserSource(env.DB, userId, u);
    const include = parseKeywords(sub?.include_keywords);
    const exclude = sub ? parseKeywords(sub.exclude_keywords) : [];
    const nextInclude = applyKeywordEdit(include, text, 40);
    await updateUserSourceFilters(env.DB, userId, u, nextInclude, exclude);
    await clearState(env.DB, userId);
    return showFilters(env, userId, u);
  }

  if (st?.state === "await_exclude_keywords") {
    const u = String(st.data?.username || "");
    const sub = await getUserSource(env.DB, userId, u);
    const include = parseKeywords(sub?.include_keywords);
    const exclude = parseKeywords(sub?.exclude_keywords);
    const nextExclude = applyKeywordEdit(exclude, text, 40);
    await updateUserSourceFilters(env.DB, userId, u, include, nextExclude);
    await clearState(env.DB, userId);
    return showFilters(env, userId, u);
  }

  if (st?.state === "await_global_include_keywords") {
    const cur = await ensurePrefs(env.DB, userId);
    const include = parseKeywords(cur.global_include_keywords);
    const exclude = parseKeywords(cur.global_exclude_keywords);
    const nextInclude = applyKeywordEdit(include, text, 80);
    await setPrefs(env.DB, userId, {
      global_include_keywords: JSON.stringify(nextInclude),
      global_exclude_keywords: JSON.stringify(exclude),
    });
    await clearState(env.DB, userId);
    return showGlobalFilters(env, userId);
  }

  if (st?.state === "await_global_exclude_keywords") {
    const cur = await ensurePrefs(env.DB, userId);
    const include = parseKeywords(cur.global_include_keywords);
    const exclude = parseKeywords(cur.global_exclude_keywords);
    const nextExclude = applyKeywordEdit(exclude, text, 80);
    await setPrefs(env.DB, userId, {
      global_include_keywords: JSON.stringify(include),
      global_exclude_keywords: JSON.stringify(nextExclude),
    });
    await clearState(env.DB, userId);
    return showGlobalFilters(env, userId);
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
