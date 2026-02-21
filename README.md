# TG Feed Bot

A Telegram bot that mirrors posts from public Telegram channels into a destination channel.

The bot runs on Cloudflare Workers + Durable Objects + D1.

## Table of Contents

1. Overview
2. Features
3. Architecture
4. Tech Stack
5. Project Structure
6. Prerequisites
7. Configurationa
8. Database Setup
9. Local Development
10. Deploy to Cloudflare
11. Telegram Webhook Setup
12. Bot Usage Guide
13. Filter Syntax
14. Admin Endpoints
15. Data Model
16. Operations and Maintenance
17. Troubleshooting
18. Known Limitations

## Overview

This service watches public channels on `t.me`, scrapes new posts, and sends them to each user's configured destination channel.

Key behavior:
- Realtime mode: send posts shortly after they appear.
- Digest mode: send periodic summary messages.
- Per-channel and global include/exclude keyword filters.
- Quiet hours queueing.
- Per-channel backfill on follow.
- Destination verification flow using a one-time claim token.

## Features

- Multi-user support with isolated preferences.
- Destination channel ownership/verification flow (`DEST <token>` message in channel).
- Public channel follow/import from `@handle` and `t.me/...` links.
- Per-channel settings include pause/resume, realtime/digest mode, label, include/exclude filters, and backfill count.
- Global settings include language (`fa` / `en`), realtime on/off, digest interval, quiet hours (UTC), default backfill, and global include/exclude filters.
- Post style (`rich` / `compact`) and full-text style (`quote` / `plain`).
- Admin dashboard and JSON stats endpoints.

## Architecture

1. Telegram sends updates to `POST /telegram`.
2. Worker processes private messages, callbacks, and channel posts.
3. Worker ensures a global Durable Object ticker is running.
4. Ticker alarm runs every 5 seconds.
5. Ticker scrapes due sources from `https://t.me/s/<username>`.
6. New posts are filtered and delivered to subscribed destinations.
7. Quiet-hour posts are queued and flushed later.
8. Digest users receive summary messages on schedule.

### Delivery strategy

For each post, the bot tries in this order:
1. `copyMessage` (best fidelity)
2. `forwardMessage`
3. Fallback to direct media send (`sendPhoto`, `sendVideo`, etc.)
4. Fallback to text message

Duplicate sends are prevented with the `deliveries` table.

## Tech Stack

- Cloudflare Workers (Hono router)
- Cloudflare Durable Objects (`Ticker`)
- Cloudflare D1 (SQLite)
- Telegram Bot API
- TypeScript
- pnpm

## Project Structure

- `src/index.ts`: Worker entrypoint, routes, ticker DO, admin routes.
- `src/ticker/do.ts`: scrape loop, delivery logic, digest logic.
- `src/scraper/tme.ts`: `t.me/s` scraper + media extraction.
- `src/telegram/handlers.ts`: bot conversation and callback handling.
- `src/telegram/ui.ts`: localized text and keyboards.
- `src/telegram/client.ts`: Telegram API client with rate-limit retry.
- `src/db/repo.ts`: DB helpers.
- `src/db/schema.ts`: runtime schema upgrades (`schema_v` in `meta_kv`).
- `src/admin/stats.ts`: admin metrics and HTML dashboard.
- `schema.sql`: full base schema.
- `wipe.sql`: data wipe script (keeps tables).
- `scripts/poll.ts`: local polling bridge (Telegram getUpdates -> local `/telegram`).
- `scripts/schedule.ts`: local scheduled trigger loop.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Cloudflare account
- Telegram bot token from BotFather

## Configuration

### Cloudflare bindings (`wrangler.toml`)

Configured bindings:
- D1 binding: `DB`
- Durable Object binding: `TICKER` class `Ticker`
- Cron trigger: every minute (used to ensure ticker is started)

Ticker actual scrape cadence is every 5 seconds via Durable Object alarm.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | Yes | Telegram Bot API token |
| `WEBHOOK_SECRET` | Yes | Secret token checked on `/telegram` requests |
| `ADMIN_KEY` | No | Admin route key (falls back to `WEBHOOK_SECRET` if missing) |
| `STORE_SCRAPED_POSTS` | No | `true/1/yes` enables storing scraped posts (required for digest output) |

### Bot/channel identity constants

`src/telegram/postLinks.ts` includes:
- `BOT_USERNAME`: used in deep links.
- `MAIN_CHANNEL_USERNAME`: used in branding/footer links and destination photo copy source.

If you run your own bot/brand, update both constants.

### Local `.dev.vars` example

```env
BOT_TOKEN=<your_bot_token>
WEBHOOK_SECRET=<random_secret>
ADMIN_KEY=<optional_admin_key>
STORE_SCRAPED_POSTS=true
```

## Database Setup

Important: `ensureDbUpgrades()` applies incremental upgrades, but it is not a full bootstrap for an empty database. Initialize base tables from `schema.sql` first.

### Initialize local D1

```bash
pnpm exec wrangler d1 execute tg_feed_bot --local --file=schema.sql
```

### Initialize remote D1

```bash
pnpm exec wrangler d1 execute tg_feed_bot --remote --file=schema.sql
```

### Wipe data (keep schema)

```bash
pnpm exec wrangler d1 execute tg_feed_bot --local --file=wipe.sql
# or --remote
```

## Local Development

1. Install dependencies:

```bash
pnpm install
```

2. Set local env vars in `.dev.vars`.

3. Initialize local DB:

```bash
pnpm exec wrangler d1 execute tg_feed_bot --local --file=schema.sql
```

4. Start worker:

```bash
pnpm run dev
```

5. For local update ingestion without public webhook, run polling bridge in a second terminal:

```bash
pnpm run poll
```

6. Optional local scheduler simulator in a third terminal:

```bash
pnpm run schedule
```

## Deploy to Cloudflare

1. Set secrets:

```bash
pnpm exec wrangler secret put BOT_TOKEN
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler secret put ADMIN_KEY
pnpm exec wrangler secret put STORE_SCRAPED_POSTS
```

2. Initialize remote DB (first deployment):

```bash
pnpm exec wrangler d1 execute tg_feed_bot --remote --file=schema.sql
```

3. Deploy:

```bash
pnpm exec wrangler deploy
```

## Telegram Webhook Setup

After deploy, register Telegram webhook to the Worker URL.

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-worker-domain>/telegram",
    "secret_token": "<WEBHOOK_SECRET>",
    "drop_pending_updates": true
  }'
```

Verify:

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## Bot Usage Guide

### Supported commands

- `/start`: Home menu
- `/help`: Help text
- `/commands`: Command list
- `/newdest`: Start destination setup
- `/changedest`: Change destination
- `/follow`: Follow a channel (single or batch input)
- `/import`: Bulk import flow
- `/list`: List and manage followed channels
- `/settings`: Global settings
- `/cancel`: Cancel current step
- `/done`: Exit batch add flow

### Destination setup flow

1. Use `/newdest`.
2. Bot sends `DEST <token>`.
3. Post that line in destination channel where bot is admin.
4. Bot verifies destination and links it to your account.

### Follow channels

Accepted input forms:
- `@channelname`
- `https://t.me/channelname`
- Forwarded message from channel

Only public channels are supported.

### Backfill

When following a channel, bot can send last `N` posts (default from global setting, per-channel override available).

### Quiet hours

Quiet hours are UTC-based.
Input format in settings:
- `start end` (example `1 8`)
- `off` to disable

## Filter Syntax

Applies to both per-channel and global include/exclude editors.

- Replace full list: `foo, bar, baz`
- Patch existing list: `+foo, -bar`
- Clear list: `clear`

Notes:
- Matching is case-insensitive substring.
- Duplicate keywords are removed automatically.
- Per-channel limit: 40 keywords per list.
- Global limit: 80 keywords per list.

Filter evaluation order:
1. If any exclude keyword matches, post is blocked.
2. If include list is empty, post passes.
3. Otherwise at least one include keyword must match.

## Admin Endpoints

Auth methods:
- `Authorization: Bearer <ADMIN_KEY>`
- `X-Admin-Key: <ADMIN_KEY>`
- `?key=<ADMIN_KEY>`

If `ADMIN_KEY` is unset, `WEBHOOK_SECRET` is used.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/stats` | HTML dashboard |
| `GET` | `/admin/stats.json` | Raw JSON stats |
| `POST` | `/admin/run-scrape` | Trigger one scrape cycle |
| `POST` | `/admin/ticker/start` | Ensure ticker alarm is running |
| `POST` | `/admin/ticker/stop` | Stop ticker alarm |
| `GET` | `/admin/ticker/status` | Ticker alarm status |

### Example admin call

```bash
curl -sS "https://<your-worker-domain>/admin/stats.json" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

## Data Model

Main tables:
- `users`: Telegram users known to bot.
- `pending_claims`: one-time destination claim tokens.
- `destinations`: user destination channel and verification flag.
- `sources`: tracked channel scrape state and health.
- `user_sources`: subscriptions + per-channel settings.
- `user_prefs`: global preferences and filters.
- `scraped_posts`: cached scraped posts (for digest/backfill/queue rendering).
- `queued_realtime`: deferred posts during quiet hours.
- `user_state`: current conversational step.
- `deliveries`: delivery de-duplication records.
- `meta_kv`: schema version and misc metadata.

Source of truth for full schema: `schema.sql`.

## Operations and Maintenance

### Runtime schema upgrades

`src/db/schema.ts` tracks upgrades via `meta_kv.schema_v` and applies migrations up to v7.

### Ticker behavior

- Scrapes up to 30 due sources per tick.
- Fetch concurrency is capped at 6.
- Poll interval per source adapts.
- Success with new posts: reset to 5s.
- Success without new posts: back off up to 240s.
- Errors: exponential backoff up to 240s.

### Delivery retention

`deliveries` records older than 14 days are periodically pruned by ticker.

### Required setting for digest

Digest sending is skipped unless `STORE_SCRAPED_POSTS` is enabled.

## Troubleshooting

### Webhook returns `403 forbidden`

- Check `WEBHOOK_SECRET` in Worker env.
- Check Telegram webhook `secret_token` matches exactly.

### Destination suddenly becomes unverified

If Telegram returns destination access errors (bot removed, no rights, etc.), bot marks destination `verified=0`.

Fix:
1. Re-add bot as admin in destination channel.
2. Use `/changedest` or `/newdest` and re-verify.

### Digest not arriving

- Ensure `STORE_SCRAPED_POSTS=true`.
- Ensure channel mode is `digest` and not paused.
- Ensure destination is verified.
- Ensure digest interval has elapsed.

### No new posts delivered

- Check `/admin/stats.json` for source failures and queue buildup.
- Trigger `/admin/run-scrape` manually.
- Verify source channel is public and readable from `t.me/s/<username>`.

## Known Limitations

- Only public channels are supported for scraping.
- Filter matching is substring-only.
- Quiet hours use UTC.
- No automated test suite is currently included.

## Security Notes

- Never commit real `BOT_TOKEN` or other secrets.
- Keep `.dev.vars` local.
- Prefer setting production secrets via `wrangler secret put`.
