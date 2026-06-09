const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
const CHANNEL_SETTINGS_PREFIX = "settings_";
const CHANNEL_SETTINGS_CHAT_SEP = "-";
const CHANNEL_CHAT_POSITIVE = "p";
const CHANNEL_CHAT_NEGATIVE = "n";

export const MAIN_CHANNEL_USERNAME = "uniflyio";
export const BOT_USERNAME = "unifly_io_bot";

function normalizeUsername(raw: string): string | null {
  const clean = String(raw || "").trim().replace(/^@+/, "");
  if (!USERNAME_RE.test(clean)) return null;
  return clean;
}

export function channelUrl(username: string): string {
  return `https://t.me/${username}`;
}

function encodeDestinationChatId(chatId: number): string | null {
  if (!Number.isFinite(chatId) || !Number.isInteger(chatId) || chatId === 0) return null;
  if (chatId > 0) return `${CHANNEL_CHAT_POSITIVE}${chatId}`;
  return `${CHANNEL_CHAT_NEGATIVE}${Math.abs(chatId)}`;
}

function decodeDestinationChatId(encoded: string): number | null {
  const raw = String(encoded || "").trim();
  if (!raw) return null;

  if (raw.startsWith(CHANNEL_CHAT_POSITIVE)) {
    const n = Number(raw.slice(CHANNEL_CHAT_POSITIVE.length));
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
    return null;
  }
  if (raw.startsWith(CHANNEL_CHAT_NEGATIVE)) {
    const n = Number(raw.slice(CHANNEL_CHAT_NEGATIVE.length));
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return -n;
    return null;
  }
  return null;
}

export function buildChannelSettingsStartPayload(channelUsername: string, destinationChatId?: number | null): string | null {
  const username = normalizeUsername(channelUsername);
  if (!username) return null;

  const encodedChatId = encodeDestinationChatId(Number(destinationChatId));
  if (!encodedChatId) return `${CHANNEL_SETTINGS_PREFIX}${username.toLowerCase()}`;
  return `${CHANNEL_SETTINGS_PREFIX}${username.toLowerCase()}${CHANNEL_SETTINGS_CHAT_SEP}${encodedChatId}`;
}

export function buildChannelSettingsDeepLink(channelUsername: string, destinationChatId?: number | null): string {
  const payload = buildChannelSettingsStartPayload(channelUsername, destinationChatId);
  if (!payload) return channelUrl(BOT_USERNAME);
  return `${channelUrl(BOT_USERNAME)}?start=${encodeURIComponent(payload)}`;
}

export function parseChannelSettingsStartPayload(payload: string): { username: string; destinationChatId: number | null } | null {
  const raw = String(payload || "").trim();
  if (!raw.startsWith(CHANNEL_SETTINGS_PREFIX)) return null;

  const rest = raw.slice(CHANNEL_SETTINGS_PREFIX.length);
  const sepIdx = rest.indexOf(CHANNEL_SETTINGS_CHAT_SEP);
  const usernamePart = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
  const username = normalizeUsername(usernamePart);
  if (!username) return null;

  if (sepIdx < 0) return { username, destinationChatId: null };

  const encodedChatId = rest.slice(sepIdx + CHANNEL_SETTINGS_CHAT_SEP.length);
  const destinationChatId = decodeDestinationChatId(encodedChatId);
  if (destinationChatId === null) return null;
  return { username, destinationChatId };
}
