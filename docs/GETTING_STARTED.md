# Getting Started

This guide gets UniflyIO from a fresh project checkout to a working local bot.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Cloudflare account with Workers, D1, and Durable Objects enabled
- Telegram bot token from BotFather
- A Telegram channel where your bot can be added as admin

## 1. Install dependencies

```bash
pnpm install
```

## 2. Create local environment file

```bash
cp .dev.example.vars .dev.vars
```

Fill it in:

```env
BOT_TOKEN=<telegram_bot_token>
WEBHOOK_SECRET=<random_webhook_secret>
ADMIN_KEY=<optional_admin_key>
STORE_SCRAPED_POSTS=true
```

Notes:

- `WEBHOOK_SECRET` can be any long random string.
- `ADMIN_KEY` is optional. If it is missing, admin routes use `WEBHOOK_SECRET`.
- `STORE_SCRAPED_POSTS=true` is required for digest summaries.

## 3. Create Cloudflare config

```bash
cp wrangler.example.toml wrangler.toml
```

Create a D1 database:

```bash
pnpm exec wrangler d1 create uniflyio
```

Copy the returned database ID into `wrangler.toml`.

## 4. Initialize local D1 schema

The runtime upgrade function is incremental, but it is not a full empty-database bootstrap. Initialize the base schema first:

```bash
pnpm exec wrangler d1 execute uniflyio --local --file=schema.sql
```

## 5. Start the local Worker

```bash
pnpm run dev
```

The Worker listens on Wrangler’s local development URL, usually:

```text
http://127.0.0.1:8787
```

## 6. Start local Telegram polling bridge

In a second terminal:

```bash
pnpm run poll
```

This script calls Telegram `getUpdates`, then forwards each update to your local `/telegram` endpoint with the configured webhook secret header.

## 7. Try the bot in Telegram

1. Open your bot.
2. Send `/start`.
3. Use the setup wizard to create a destination.
4. Add the bot as admin to your destination channel.
5. Post the generated `DEST <token>` line into the destination channel.
6. Follow a public source channel with `/follow @channelname`.

## 8. Verify delivery

Use `/list` to confirm the channel was added. Use `/settings` to send a test message to your destination channel.

If posts are not arriving, open the troubleshooting guide: [Troubleshooting](./TROUBLESHOOTING.md).
