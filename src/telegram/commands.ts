import { Env } from "../types";
import { tg } from "./client";

type BotCommand = { command: string; description: string };

const BOT_COMMANDS_VERSION = "2026-02-19-v1";
const BOT_COMMANDS_META_KEY = "bot_commands_version";

const EN_COMMANDS: BotCommand[] = [
  { command: "start", description: "Open home menu" },
  { command: "help", description: "How to use the bot" },
  { command: "commands", description: "Show command list" },
  { command: "newdest", description: "Set destination channel" },
  { command: "changedest", description: "Change destination channel" },
  { command: "follow", description: "Follow a public channel" },
  { command: "import", description: "Import multiple channels" },
  { command: "list", description: "Manage followed channels" },
  { command: "settings", description: "Open bot settings" },
  { command: "cancel", description: "Cancel current step" },
];

const FA_COMMANDS: BotCommand[] = [
  { command: "start", description: "منوی اصلی" },
  { command: "help", description: "راهنما" },
  { command: "commands", description: "لیست دستورات" },
  { command: "newdest", description: "تنظیم مقصد" },
  { command: "changedest", description: "تغییر مقصد" },
  { command: "follow", description: "افزودن کانال" },
  { command: "import", description: "ورود گروهی کانال‌ها" },
  { command: "list", description: "مدیریت کانال‌های من" },
  { command: "settings", description: "تنظیمات ربات" },
  { command: "cancel", description: "لغو مرحله فعلی" },
];

async function setPrivateCommands(env: Env, commands: BotCommand[], languageCode?: string) {
  const params: Record<string, any> = {
    scope: { type: "all_private_chats" },
    commands,
  };
  if (languageCode) params.language_code = languageCode;
  await tg(env, "setMyCommands", params);
}

export async function ensureBotCommands(env: Env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta_kv WHERE key=?").bind(BOT_COMMANDS_META_KEY).first<any>();
    const curVersion = String(row?.value || "");
    if (curVersion === BOT_COMMANDS_VERSION) return;

    // Default + language-specific command menus for Telegram clients.
    await setPrivateCommands(env, EN_COMMANDS);
    await setPrivateCommands(env, EN_COMMANDS, "en");
    await setPrivateCommands(env, FA_COMMANDS, "fa");

    await env.DB
      .prepare("INSERT OR REPLACE INTO meta_kv(key, value) VALUES(?, ?)")
      .bind(BOT_COMMANDS_META_KEY, BOT_COMMANDS_VERSION)
      .run();
  } catch (e: any) {
    console.log("ensureBotCommands error:", String(e?.message || e));
  }
}
