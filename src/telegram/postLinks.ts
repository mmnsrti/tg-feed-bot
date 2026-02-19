const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
const CHANNEL_SETTINGS_PREFIX = "settings_";

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

export function buildChannelSettingsStartPayload(channelUsername: string): string | null {
  const username = normalizeUsername(channelUsername);
  if (!username) return null;
  return `${CHANNEL_SETTINGS_PREFIX}${username.toLowerCase()}`;
}

export function buildChannelSettingsDeepLink(channelUsername: string): string {
  const payload = buildChannelSettingsStartPayload(channelUsername);
  if (!payload) return channelUrl(BOT_USERNAME);
  return `${channelUrl(BOT_USERNAME)}?start=${encodeURIComponent(payload)}`;
}

export function parseChannelSettingsStartPayload(payload: string): string | null {
  const raw = String(payload || "").trim();
  if (!raw.startsWith(CHANNEL_SETTINGS_PREFIX)) return null;
  return normalizeUsername(raw.slice(CHANNEL_SETTINGS_PREFIX.length));
}
