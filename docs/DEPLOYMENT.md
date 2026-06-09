# Deployment Guide

This project is designed for Cloudflare Workers with D1 and Durable Objects.

## 1. Prepare `wrangler.toml`

```bash
cp wrangler.example.toml wrangler.toml
```

Create a D1 database:

```bash
pnpm exec wrangler d1 create uniflyio
```

Copy the returned `database_id` into `wrangler.toml`.

## 2. Initialize remote database schema

For the first production deployment, initialize the base schema:

```bash
pnpm exec wrangler d1 execute uniflyio --remote --file=schema.sql
```

Runtime upgrades in `src/db/schema.ts` are incremental and helpful for deployed instances, but a new database should still be bootstrapped with `schema.sql`.

## 3. Add secrets

```bash
pnpm exec wrangler secret put BOT_TOKEN
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler secret put ADMIN_KEY
pnpm exec wrangler secret put STORE_SCRAPED_POSTS
```

Recommended values:

```text
WEBHOOK_SECRET: long random string
ADMIN_KEY: different long random string
STORE_SCRAPED_POSTS: true
```

## 4. Deploy the Worker

```bash
pnpm exec wrangler deploy
```

After deploy, note your Worker URL, for example:

```text
https://uniflyio.<account>.workers.dev
```

## 5. Register Telegram webhook

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-worker-domain>/telegram",
    "secret_token": "<WEBHOOK_SECRET>",
    "drop_pending_updates": true
  }'
```

## 6. Verify webhook

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Expected signs of success:

- `url` is your Worker `/telegram` URL.
- `last_error_message` is empty or absent.
- `pending_update_count` is not growing continuously.

## 7. Smoke test production

1. Send `/start` to the bot.
2. Set a destination with `/newdest`.
3. Add the bot as admin in the destination channel.
4. Post the `DEST <token>` message in that channel.
5. Follow a public source channel.
6. Open `/admin/stats` to verify activity.

## 8. Admin dashboard

Open:

```text
https://<your-worker-domain>/admin/stats?key=<ADMIN_KEY>
```

For scripts or monitoring tools, prefer the JSON endpoint:

```bash
curl -sS "https://<your-worker-domain>/admin/stats.json" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

## 9. Production maintenance commands

```bash
# Manually trigger one scrape cycle
curl -X POST "https://<your-worker-domain>/admin/run-scrape" \
  -H "Authorization: Bearer <ADMIN_KEY>"

# Start ticker
curl -X POST "https://<your-worker-domain>/admin/ticker/start" \
  -H "Authorization: Bearer <ADMIN_KEY>"

# Stop ticker
curl -X POST "https://<your-worker-domain>/admin/ticker/stop" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```
