# Development Guide

This guide explains the local workflow and the main code areas.

## Install

```bash
pnpm install
```

## Local environment

```bash
cp .dev.example.vars .dev.vars
```

Required local values:

```env
BOT_TOKEN=<telegram_bot_token>
WEBHOOK_SECRET=<random_webhook_secret>
ADMIN_KEY=<optional_admin_key>
STORE_SCRAPED_POSTS=true
```

## Local database

Initialize:

```bash
pnpm exec wrangler d1 execute uniflyio --local --file=schema.sql
```

Wipe data:

```bash
pnpm exec wrangler d1 execute uniflyio --local --file=wipe.sql
```

## Run locally

Terminal 1:

```bash
pnpm run dev
```

Terminal 2:

```bash
pnpm run poll
```

Optional terminal 3:

```bash
pnpm run schedule
```

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `wrangler dev --test-scheduled` | Start local Cloudflare Worker |
| `poll` | `tsx -r dotenv/config scripts/poll.ts` | Poll Telegram and forward updates to local Worker |
| `schedule` | `tsx scripts/schedule.ts` | Simulate scheduled events locally |

## Code map

| File | Responsibility |
|---|---|
| `src/index.ts` | Worker entrypoint, Hono routes, Durable Object class, scheduled handler |
| `src/telegram/handlers.ts` | Commands, conversation state, callback actions, destination flow, follow/import flow |
| `src/telegram/ui.ts` | Bilingual strings and inline keyboard builders |
| `src/telegram/client.ts` | Telegram Bot API wrapper with retry on rate limit |
| `src/telegram/commands.ts` | Registers Telegram slash commands in English and Persian |
| `src/telegram/postLinks.ts` | Bot/channel constants and deep-link helpers |
| `src/ticker/do.ts` | Scrape loop, filters, quiet queue, digest, delivery strategy |
| `src/scraper/tme.ts` | Public `t.me/s` HTML fetcher and parser |
| `src/db/repo.ts` | Database helper functions |
| `src/db/schema.ts` | Runtime schema upgrades |
| `src/admin/stats.ts` | Admin stats data and HTML rendering |
| `src/types.ts` | Shared types |
| `src/config.ts` | Environment parsing helpers |

## Safe change workflow

1. Update TypeScript code.
2. Update or add matching docs in `docs/`.
3. Run local Worker and polling bridge.
4. Test `/start`, `/newdest`, `/follow`, `/list`, `/settings`.
5. Test `/admin/stats.json`.
6. Deploy to a staging Worker before production when possible.

## Adding a new setting

Typical files to update:

1. `schema.sql` for new installations
2. `src/db/schema.ts` for existing deployments
3. `src/types.ts` for TypeScript shape
4. `src/db/repo.ts` for read/write helpers
5. `src/telegram/ui.ts` for labels/buttons
6. `src/telegram/handlers.ts` for state/callback handling
7. documentation in `docs/`

## Adding a new Telegram command

1. Add command metadata in `src/telegram/commands.ts`.
2. Bump `BOT_COMMANDS_VERSION`.
3. Add command handling in `handlePrivateMessage()`.
4. Add UI/help text in `src/telegram/ui.ts`.
5. Update [Bot Usage](./BOT_USAGE.md).

## Scraper changes

The scraper depends on Telegram public preview HTML. When changing it:

- Keep parsing resilient to missing fields.
- Deduplicate media URLs.
- Preserve text-only fallback behavior.
- Avoid treating emoji assets as message media.
- Test with text, photo, video, document, sticker, and location posts where possible.
