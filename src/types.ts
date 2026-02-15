/// <reference types="@cloudflare/workers-types" />

export type Env = {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_KEY?: string;
  TICKER: DurableObjectNamespace;
  STORE_SCRAPED_POSTS?: string;
};

export type TgUpdate = any;

export type Lang = "fa" | "en";
export type PostStyle = "compact" | "rich";
export type FullTextStyle = "quote" | "plain";
export type ChannelMode = "realtime" | "digest";

export type MediaKind = "photo" | "video" | "document";
export type MediaItem = { kind: MediaKind; url: string };

export type ScrapedPost = {
  postId: number;
  text: string;
  link: string;
  media: MediaItem[];
};

export type UserPrefs = {
  lang: Lang;
  digest_hours: number;
  last_digest_at: number;
  realtime_enabled: number;
  default_backfill_n: number;
  quiet_start: number;
  quiet_end: number;
  post_style: PostStyle;
  full_text_style: FullTextStyle;
};

export type DestinationRow = {
  chat_id: number;
  verified: number;
};

export type UserState = {
  state: string;
  data: any;
};

export type UserSourceRow = {
  username: string;
  paused: number;
  mode: ChannelMode;
  include_keywords: string;
  exclude_keywords: string;
  backfill_n: number;
  label?: string | null;
  last_post_id?: number | null;
};
