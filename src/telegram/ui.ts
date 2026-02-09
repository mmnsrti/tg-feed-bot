import { Lang, PostStyle, UserPrefs } from "../types";

export function t(lang: Lang, fa: string, en: string) {
  return lang === "fa" ? fa : en;
}

export function S(lang: Lang) {
  const L = (fa: string, en: string) => (lang === "fa" ? fa : en);
  return {
    title: L("📡 فید کانال‌ها", "📡 Channel Feeds"),
    homeHint: L("از دکمه‌ها استفاده کن 👇", "Use the buttons below 👇"),

    destinationLabel: L("مقصد", "Destination"),
    realtimeLabel: L("ریِل‌تایم", "Realtime"),
    quietLabel: L("ساعت سکوت", "Quiet hours"),
    followedLabel: L("تعداد کانال‌ها", "Followed channels"),
    settingsTitle: L("⚙️ تنظیمات", "⚙️ Settings"),

    destNotSet: L("تنظیم نشده", "Not set"),
    destNotVerified: L("تنظیم شده (تأیید نشده)", "Set (not verified)"),
    destVerified: L("تأیید شده", "Verified"),

    setDest: L("🎯 تنظیم کانال مقصد", "🎯 Set Destination"),
    addChannel: L("➕ افزودن کانال", "➕ Add Channel"),
    myChannels: L("📋 کانال‌های من", "📋 My Channels"),
    settings: L("⚙️ تنظیمات", "⚙️ Settings"),
    help: L("❓ راهنما", "❓ Help"),

    back: L("⬅️ برگشت", "⬅️ Back"),
    cancel: L("✖️ لغو", "✖️ Cancel"),

    language: L("🌐 زبان", "🌐 Language"),
    realtime: L("⚡ ریل‌تایم", "⚡ Realtime"),
    digest: L("🧾 خلاصه", "🧾 Digest"),
    quiet: L("🌙 ساعت سکوت", "🌙 Quiet Hours"),
    defaultBackfill: L("📌 بک‌فیل پیش‌فرض", "📌 Default Backfill"),
    testDelivery: L("✅ تست ارسال", "✅ Test Delivery"),
    postStyle: L("🧩 سبک پست", "🧩 Post Style"),
    styleCompact: L("فشرده", "Compact"),
    styleRich: L("کامل", "Rich"),
    hours: L("ساعت", "hours"),

    realtimeOn: L("روشن ✅", "ON ✅"),
    realtimeOff: L("خاموش ❌", "OFF ❌"),

    openOriginal: L("🔗 پست اصلی", "🔗 Original post"),
    openChannel: L("📣 کانال", "📣 Channel"),
    noText: L("(بدون متن)", "(no text)"),

    needDestFirst: L("⚠️ اول کانال مقصد را تنظیم کن.", "⚠️ Set destination first."),
    sendUsername: L("نام کاربری یا لینک کانال عمومی را بفرست:\nمثلا @khabarfuri", "Send a public channel username/link:\nExample: @khabarfuri"),
    invalidFormat: L("فرمت اشتباه است. مثل @name بفرست.", "Invalid format. Send @name."),
    fetchFailed: L("الان امکان دریافت ندارم. چند دقیقه بعد دوباره امتحان کن.", "Couldn’t reach it right now. Try again in a minute."),
    couldntRead: (u: string) => L(`از @${u} چیزی نتونستم بخونم. عمومی هست؟`, `Couldn’t read @${u}. Is it public?`),

    followed: (u: string, n: number) => L(`✅ @${u} اضافه شد. (${n} پست آخر ارسال شد)`, `✅ Followed @${u}. (Sent last ${n} posts)`),
    followedNoRealtime: (u: string) => L(`✅ @${u} اضافه شد. (ریِل‌تایم خاموش است؛ فقط خلاصه)`, `✅ Followed @${u}. (Realtime is OFF; digest only)`),

    helpText: L(
      [
        "❓ راهنما",
        "",
        "✅ این ربات پست‌های کانال‌های عمومی را به کانال مقصد شما می‌فرستد.",
        "",
        "⚡ ریِل‌تایم: هر پست جدید سریع ارسال می‌شود.",
        "🧾 خلاصه: هر X ساعت یک پیام خلاصه ارسال می‌شود.",
        "",
        "📌 پست‌ها داخل تلگرام خوانا هستند و لینک اصلی هم برای پیش‌نمایش می‌آید.",
      ].join("\n"),
      [
        "❓ Help",
        "",
        "✅ This bot forwards public channel posts into your destination channel.",
        "",
        "⚡ Realtime: each new post is sent quickly.",
        "🧾 Digest: a summary is sent every X hours.",
        "",
        "📌 Posts are readable inside Telegram and still include the original link preview.",
      ].join("\n")
    ),

    destTitle: L("🎯 تنظیم کانال مقصد", "🎯 Set Destination"),
    destSteps: L(
      "1) یک کانال مقصد بساز\n2) ربات را ادمین کن\n3) این خط را در کانال بفرست:",
      "1) Create a destination channel\n2) Add the bot as admin\n3) Post this line in the channel:"
    ),
    copyHint: L("برای کپی، روی متن کادر لمس طولانی کن.", "Long-press the code block to copy."),

    digestAskHours: L("عدد بازه خلاصه را بفرست (۱ تا ۲۴).", "Send digest interval in hours (1..24)."),
    invalidNumber: L("عدد معتبر نیست.", "Invalid number."),
    quietAsk: L("برای تنظیم ساعت سکوت (UTC):\nمثال: 1 8\nبرای خاموش کردن: off", "Set quiet hours (UTC):\nExample: 1 8\nDisable: off"),
    backfillAsk: L("عدد بک‌فیل پیش‌فرض را بفرست (۰ تا ۱۰).", "Send default backfill (0..10)."),
    digestSaved: L("✅ بازه خلاصه ذخیره شد.", "✅ Digest interval saved."),
    backfillSaved: L("✅ بک‌فیل پیش‌فرض ذخیره شد.", "✅ Default backfill saved."),
    quietSaved: L("✅ ساعت سکوت ذخیره شد.", "✅ Quiet hours saved."),
    quietDisabled: L("✅ ساعت سکوت خاموش شد.", "✅ Quiet hours disabled."),

    chSettingsTitle: (u: string) => L(`⚙️ تنظیمات @${u}`, `⚙️ Settings @${u}`),
    statusLabel: L("وضعیت", "Status"),
    modeLabel: L("حالت", "Mode"),
    labelLabel: L("برچسب", "Label"),
    includeLabel: L("شامل", "Include"),
    excludeLabel: L("حذف", "Exclude"),

    statusActive: L("فعال ▶️", "active ▶️"),
    statusPaused: L("متوقف ⏸", "paused ⏸"),

    pause: L("⏸ توقف", "⏸ Pause"),
    resume: L("▶️ ادامه", "▶️ Resume"),
    modeRealtime: L("⚡ ریِل‌تایم", "⚡ Realtime"),
    modeDigest: L("🧾 خلاصه", "🧾 Digest"),
    filters: L("🔎 فیلترها", "🔎 Filters"),
    backfill: L("📌 بک‌فیل", "📌 Backfill"),
    unfollow: L("🗑 حذف", "🗑 Unfollow"),
    renameLabel: L("🏷 تغییر برچسب", "🏷 Rename label"),

    setInclude: L("➕ شامل", "➕ Include"),
    setExclude: L("➖ حذف", "➖ Exclude"),
    clearFilters: L("🧹 پاک کردن فیلترها", "🧹 Clear filters"),
    incPrompt: (u: string) => L(`کلمات شامل برای @${u} را بفرست (با کاما جدا کن).`, `Send include keywords for @${u} (comma-separated).`),
    excPrompt: (u: string) => L(`کلمات حذف برای @${u} را بفرست (با کاما جدا کن).`, `Send exclude keywords for @${u} (comma-separated).`),

    testOk: L("✅ تست ارسال انجام شد.", "✅ Delivery test succeeded."),

    labelPrompt: (u: string) => L(`برچسب جدید برای @${u} را بفرست (یا "-" برای پاک‌کردن).`, `Send a new label for @${u} (or "-" to clear).`),
    labelSaved: L("✅ برچسب ذخیره شد.", "✅ Label saved."),
    labelCleared: L("✅ برچسب پاک شد.", "✅ Label cleared."),
    labelTooLong: L("برچسب خیلی طولانی است. حداکثر ۳۲ کاراکتر.", "Label is too long. Max 32 characters."),

    listEmpty: L("هیچ کانالی دنبال نمی‌کنی.", "You aren’t following any channels."),
    listHint: L("برای مدیریت، روی دکمه هر کانال بزن.", "Tap a channel button to manage."),
    listSearchHint: L("برای جست‌وجو، @name را تایپ کن.", "Type @name to search."),
    listNoMatches: L("چیزی پیدا نشد.", "No matches found."),
    listMatchesTitle: L("نتایج جست‌وجو", "Search results"),
    channelNotFound: L("کانال پیدا نشد.", "Channel not found."),
    filtersTitle: (u: string) => L(`🔎 فیلترهای @${u}`, `🔎 Filters for @${u}`),
    backfillMenu: (u: string) => L(`📌 بک‌فیل @${u}\nچند پست آخر هنگام Follow ارسال شود؟`, `📌 Backfill @${u}\nHow many last posts on follow?`),

    filtersCount: (n: number) => L(`🔎 ${n}`, `🔎 ${n}`),
    lastSeenLabel: L("آخرین", "Last"),

    defaultLabel: L("فید", "Feed"),
    via: L("از", "via"),
    quietOff: L("خاموش", "OFF"),
    quietRange: (qs: number, qe: number) => `${qs}:00 → ${qe}:00 (UTC)`,
  };
}

function escapeHtml(s: string) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateText(s: string, max: number) {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  if (max <= 3) return t.slice(0, max);
  return t.slice(0, Math.max(0, max - 3)).trimEnd() + "...";
}

function oneLine(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function metaLine(lang: Lang, username: string) {
  const s = S(lang);
  return `${s.via} @${escapeHtml(username)}`;
}

function badgeText(lang: Lang, label?: string | null) {
  const s = S(lang);
  const clean = (label || "").toString().replace(/\s+/g, " ").trim();
  const text = clean || s.defaultLabel;
  return `🏷 ${escapeHtml(text)}`;
}

function headerLine(lang: Lang, username: string, label?: string | null) {
  return `📰 @${escapeHtml(username)} • ${badgeText(lang, label)}`;
}

type RenderedMessage = { text: string; reply_markup: any };

export function postButtons(lang: Lang, username: string, link: string) {
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

// Pure renderer: (lang, channelUsername, channelLabel, postText, postLink, time)
export function renderCompactPost(
  lang: Lang,
  channelUsername: string,
  channelLabel: string | null,
  postText: string,
  postLink: string,
  timeSec?: number
): RenderedMessage {
  const s = S(lang);
  const header = headerLine(lang, channelUsername, channelLabel);
  const raw = (postText || "").trim();
  const snippetSource = raw || s.noText;
  const snippet = truncateText(oneLine(snippetSource), 160);
  const safeSnippet = escapeHtml(snippet);
  const meta = metaLine(lang, channelUsername);

  const lines = [header, safeSnippet];
  if (meta) lines.push(meta);
  lines.push(postLink);

  return { text: lines.join("\n"), reply_markup: postButtons(lang, channelUsername, postLink) };
}

// Pure renderer: (lang, channelUsername, channelLabel, postText, postLink, time)
export function renderRichPost(
  lang: Lang,
  channelUsername: string,
  channelLabel: string | null,
  postText: string,
  postLink: string,
  timeSec?: number
): RenderedMessage {
  const s = S(lang);
  const header = headerLine(lang, channelUsername, channelLabel);

  const raw = (postText || "").trim() || s.noText;
  const short = truncateText(oneLine(raw), 320);
  const shortBlock = `<blockquote>${escapeHtml(short)}</blockquote>`;

  const fullNeeded = oneLine(raw).length > short.length + 40;
  let fullBlock = "";
  if (fullNeeded) {
    const full = truncateText(raw, 1800);
    if (full && full !== short) fullBlock = `<blockquote expandable>${escapeHtml(full)}</blockquote>`;
  }

  const meta = metaLine(lang, channelUsername);

  const parts = [header, shortBlock];
  if (fullBlock) parts.push(fullBlock);
  if (meta) parts.push(meta);
  parts.push(postLink);

  return { text: parts.join("\n\n"), reply_markup: postButtons(lang, channelUsername, postLink) };
}

export function renderDestinationPost(
  style: PostStyle,
  lang: Lang,
  channelUsername: string,
  channelLabel: string | null,
  postText: string,
  postLink: string,
  timeSec?: number
): RenderedMessage {
  return style === "compact"
    ? renderCompactPost(lang, channelUsername, channelLabel, postText, postLink, timeSec)
    : renderRichPost(lang, channelUsername, channelLabel, postText, postLink, timeSec);
}

/** ------------------- keyboards ------------------- */
export function backKeyboard(lang: Lang, data = "m:home") {
  const s = S(lang);
  return { inline_keyboard: [[{ text: s.back, callback_data: data }]] };
}

export function cancelKeyboard(lang: Lang) {
  const s = S(lang);
  return { inline_keyboard: [[{ text: s.cancel, callback_data: "m:cancel" }]] };
}

export function homeKeyboard(lang: Lang, hasDest: boolean) {
  const s = S(lang);
  const rows: any[] = [];

  if (!hasDest) rows.push([{ text: s.setDest, callback_data: "m:newdest" }]);

  rows.push([
    { text: s.addChannel, callback_data: "m:follow" },
    { text: s.myChannels, callback_data: "m:list:0" },
  ]);
  rows.push([
    { text: s.settings, callback_data: "m:settings" },
    { text: s.help, callback_data: "m:help" },
  ]);

  return { inline_keyboard: rows };
}

export function settingsKeyboard(lang: Lang, prefs: UserPrefs, hasDest: boolean) {
  const s = S(lang);
  const styleName = prefs.post_style === "compact" ? s.styleCompact : s.styleRich;
  const rows: any[] = [];

  rows.push([
    { text: s.language, callback_data: "set:lang" },
    { text: `${s.realtime}: ${prefs.realtime_enabled ? s.realtimeOn : s.realtimeOff}`, callback_data: "set:rt" },
  ]);

  rows.push([{ text: `${s.postStyle}: ${styleName}`, callback_data: "set:style" }]);
  rows.push([{ text: s.digest, callback_data: "set:digest" }]);
  rows.push([{ text: s.quiet, callback_data: "set:quiet" }]);
  rows.push([{ text: s.defaultBackfill, callback_data: "set:dbf" }]);

  if (hasDest) rows.push([{ text: s.testDelivery, callback_data: "set:test" }]);

  rows.push([{ text: s.back, callback_data: "m:home" }]);
  return { inline_keyboard: rows };
}

export function channelKeyboard(lang: Lang, u: string, paused: number, mode: string) {
  const s = S(lang);
  const pauseBtn = paused ? { text: s.resume, callback_data: `c:resume:${u}` } : { text: s.pause, callback_data: `c:pause:${u}` };
  const modeBtn = mode === "digest" ? { text: s.modeRealtime, callback_data: `c:mode:realtime:${u}` } : { text: s.modeDigest, callback_data: `c:mode:digest:${u}` };

  return {
    inline_keyboard: [
      [pauseBtn, modeBtn],
      [{ text: s.renameLabel, callback_data: `c:label:${u}` }],
      [{ text: s.filters, callback_data: `f:menu:${u}` }, { text: s.backfill, callback_data: `bf:menu:${u}` }],
      [{ text: s.unfollow, callback_data: `c:unfollow:${u}` }],
      [{ text: s.back, callback_data: "m:list:0" }],
    ],
  };
}

export function filtersKeyboard(lang: Lang, u: string) {
  const s = S(lang);
  return {
    inline_keyboard: [
      [{ text: s.setInclude, callback_data: `f:set_inc:${u}` }, { text: s.setExclude, callback_data: `f:set_exc:${u}` }],
      [{ text: s.clearFilters, callback_data: `f:clear:${u}` }],
      [{ text: s.back, callback_data: `m:channel:${u}` }],
    ],
  };
}

export function backfillKeyboard(lang: Lang, u: string) {
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
