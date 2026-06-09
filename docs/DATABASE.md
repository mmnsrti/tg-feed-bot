# Database Guide

TG Feed Bot uses Cloudflare D1. The base schema is in `schema.sql`, and incremental runtime upgrades are handled by `src/db/schema.ts` using the `meta_kv` table.

## Bootstrap a new database

Local:

```bash
pnpm exec wrangler d1 execute tg_feed_bot --local --file=schema.sql
```

Remote:

```bash
pnpm exec wrangler d1 execute tg_feed_bot --remote --file=schema.sql
```

Important: runtime upgrades are not a full replacement for base schema initialization on an empty database.

## Main tables

| Table | Purpose |
|---|---|
| `meta_kv` | Schema version and other metadata |
| `users` | Telegram users who interacted with the bot |
| `pending_claims` | One-time destination claim tokens |
| `destinations` | Verified or unverified destination channel per user |
| `sources` | Public Telegram channels being monitored |
| `user_sources` | User subscriptions and per-channel settings |
| `user_prefs` | Global user preferences and filters |
| `scraped_posts` | Stored post cache for digest/backfill/queue rendering |
| `queued_realtime` | Quiet-hours realtime queue |
| `user_state` | Conversation state for multi-step bot flows |
| `deliveries` | Per-user delivery deduplication |
| `locks` | Legacy/general lock table in base schema |

## Schema initialization versus upgrades

### Base schema

Use `schema.sql` for a fresh database.

### Runtime upgrades

`ensureDbUpgrades()` applies incremental migrations and stores the current version in:

```text
meta_kv.schema_v
```

Current upgrade areas include:

- media JSON storage
- UI/preferences fields
- channel labels
- source photo metadata
- full-text style
- global filters
- user profile metadata

The `migrations/` directory contains historical SQL files that mirror these schema changes.

## Data wipe

To delete runtime data while keeping tables:

```bash
pnpm exec wrangler d1 execute tg_feed_bot --local --file=wipe.sql
```

Remote wipe:

```bash
pnpm exec wrangler d1 execute tg_feed_bot --remote --file=wipe.sql
```

Use remote wipe carefully. It removes users, destinations, subscriptions, queues, deliveries, and cached posts.

## Delivery deduplication

The `deliveries` table uses this primary key:

```text
(user_id, username, post_id)
```

The ticker periodically deletes delivery rows older than 14 days to keep the table from growing forever.

## Digest storage

The `scraped_posts` table is populated only when:

```env
STORE_SCRAPED_POSTS=true
```

Without this setting, digest mode may not have content to send.

## Useful inspection queries

```sql
-- Total users
SELECT COUNT(*) AS users_total FROM users;

-- Verified destinations
SELECT COUNT(*) AS verified_destinations FROM destinations WHERE verified = 1;

-- Top followed sources
SELECT username, COUNT(*) AS subscribers
FROM user_sources
GROUP BY username
ORDER BY subscribers DESC
LIMIT 20;

-- Failing sources
SELECT username, fail_count, last_error, last_error_at
FROM sources
WHERE fail_count > 0
ORDER BY fail_count DESC, last_error_at DESC
LIMIT 20;

-- Queue size
SELECT COUNT(*) AS queued_total FROM queued_realtime;
```
