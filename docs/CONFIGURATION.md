# Configuration

TG Feed Bot has three configuration layers:

1. Cloudflare bindings in `wrangler.toml`
2. Secrets and environment variables
3. Source-level brand constants in TypeScript

## Cloudflare bindings

Start from the template:

```bash
cp wrangler.example.toml wrangler.toml
```

Required sections:

```toml
name = "tg-feed-bot"
main = "src/index.ts"
compatibility_date = "2026-02-07"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[triggers]
crons = ["*/1 * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "tg_feed_bot"
database_id = "<cloudflare_d1_database_id>"

[[durable_objects.bindings]]
name = "TICKER"
class_name = "Ticker"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Ticker"]
```

### Binding reference

| Binding | Required | Description |
|---|---:|---|
| `DB` | Yes | Cloudflare D1 database used by all persistent state |
| `TICKER` | Yes | Durable Object namespace for the global scrape ticker |
| Cron trigger | Yes | Starts or restarts the Durable Object ticker periodically |

## Environment variables and secrets

### Local development

Use `.dev.vars`:

```env
BOT_TOKEN=<telegram_bot_token>
WEBHOOK_SECRET=<random_webhook_secret>
ADMIN_KEY=<optional_admin_key>
STORE_SCRAPED_POSTS=true
```

### Production

Use Wrangler secrets:

```bash
pnpm exec wrangler secret put BOT_TOKEN
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler secret put ADMIN_KEY
pnpm exec wrangler secret put STORE_SCRAPED_POSTS
```

### Variable reference

| Variable | Required | Accepted values | Description |
|---|---:|---|---|
| `BOT_TOKEN` | Yes | Telegram Bot API token | Used for all Telegram Bot API calls |
| `WEBHOOK_SECRET` | Yes | Any secret string | Must match Telegram webhook `secret_token`; checked on `/telegram` |
| `ADMIN_KEY` | No | Any secret string | Used by admin routes; falls back to `WEBHOOK_SECRET` |
| `STORE_SCRAPED_POSTS` | No | `true`, `1`, `yes` | Enables `scraped_posts` storage, required for digest output |

## Brand constants

Update these values before deploying your own branded bot:

```ts
// src/telegram/postLinks.ts
export const MAIN_CHANNEL_USERNAME = "uniflyio";
export const BOT_USERNAME = "unifly_io_bot";
```

| Constant | Used for |
|---|---|
| `MAIN_CHANNEL_USERNAME` | Main-channel membership gate and branding links |
| `BOT_USERNAME` | Deep links back into the bot, including channel settings links |

## Destination permissions

The bot must be an admin in each destination channel and must be able to post messages. Without this permission, Telegram delivery can fail and the bot may mark the destination as unverified.

## Local script variables

`pnpm run poll` reads:

| Variable | Default | Description |
|---|---|---|
| `LOCAL_ENDPOINT` | `http://127.0.0.1:8787/telegram` | Local Worker endpoint to receive updates |
| `WEBHOOK_SECRET` | empty | Forwarded as `X-Telegram-Bot-Api-Secret-Token` when set |

`pnpm run schedule` reads:

| Variable | Default | Description |
|---|---|---|
| `SCHEDULE_ENDPOINT` | `http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*` | Local scheduled endpoint |
| `SCHEDULE_INTERVAL_MS` | `1000` | Delay between simulated schedule calls |
