# Operations Guide

This guide covers runtime monitoring, admin actions, queue behavior, and maintenance.

## Admin authentication

Admin routes accept any of these methods:

```http
Authorization: Bearer <ADMIN_KEY>
X-Admin-Key: <ADMIN_KEY>
```

Or a query key:

```text
?key=<ADMIN_KEY>
```

If `ADMIN_KEY` is not configured, the Worker falls back to `WEBHOOK_SECRET`.

## Admin endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/stats` | HTML dashboard for humans |
| `GET` | `/admin/stats.json` | JSON metrics for scripts and monitoring |
| `POST` | `/admin/run-scrape` | Run one scrape cycle through the Durable Object |
| `POST` | `/admin/ticker/start` | Ensure the ticker alarm is active |
| `POST` | `/admin/ticker/stop` | Stop the ticker alarm |
| `GET` | `/admin/ticker/status` | Read the current alarm timestamp |

## Common admin calls

```bash
# Dashboard JSON
curl -sS "https://<your-worker-domain>/admin/stats.json" \
  -H "Authorization: Bearer <ADMIN_KEY>"

# Trigger one scrape cycle
curl -sS -X POST "https://<your-worker-domain>/admin/run-scrape" \
  -H "Authorization: Bearer <ADMIN_KEY>"

# Ticker status
curl -sS "https://<your-worker-domain>/admin/ticker/status" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

## What to monitor

The JSON stats endpoint is the best single source for operations. Important groups include:

| Signal | Why it matters |
|---|---|
| total users and subscriptions | Growth and usage |
| verified versus unverified destinations | Delivery readiness |
| failing sources | Scrape health |
| due sources | Whether the ticker is falling behind |
| queued realtime count | Quiet-hours backlog or delivery problems |
| deliveries in last 5 minutes/hour/day | Output activity |
| scraped posts in last 5 minutes/hour/day | Scraper activity |
| digest users due | Digest backlog |
| ticker alarm timestamp | Whether the DO alarm is active |

## Ticker behavior

The global Durable Object ticker:

- runs every 5 seconds after started
- prevents overlapping runs with a DO storage lock
- processes up to a capped number of due sources per tick
- uses limited fetch concurrency
- backs off inactive or failing sources
- periodically prunes old delivery dedupe rows

## Manual scrape trigger

Use this when users report missing posts or after fixing source issues:

```bash
curl -sS -X POST "https://<your-worker-domain>/admin/run-scrape" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

Responses:

| Status | Meaning |
|---|---|
| `200` | Scrape cycle completed |
| `409` | Another scrape cycle is already running |
| `500` | The scrape cycle threw an error |

## Queue maintenance

`queued_realtime` stores posts deferred by quiet hours. A large queue can mean:

- many users are in quiet hours
- destinations are unverified or inaccessible
- delivery is failing
- the ticker is stopped or behind

Use `/admin/stats.json` to identify queue hotspots by source and affected users.

## Destination health

Telegram delivery errors can mark a destination as unverified. Common causes:

- bot removed from channel
- bot lacks admin rights
- bot cannot post messages
- destination channel is no longer accessible

Recovery:

1. Re-add the bot as channel admin.
2. Ensure it can post messages.
3. Ask the user to run `/changedest` and verify again.

## Delivery retention

The `deliveries` table prevents duplicate delivery and is pruned periodically. Current retention is 14 days.

## Digest requirements

Digest mode requires:

```env
STORE_SCRAPED_POSTS=true
```

When disabled, the bot can still run realtime delivery, but digest summaries may be empty or skipped.

## Safe production checklist

Before going live:

- `wrangler.toml` has the correct D1 `database_id`.
- Remote schema has been initialized with `schema.sql`.
- `BOT_TOKEN`, `WEBHOOK_SECRET`, and `ADMIN_KEY` are set as secrets.
- Telegram webhook uses the same `WEBHOOK_SECRET`.
- The bot is admin in the destination channel used for smoke testing.
- `/admin/stats.json` is reachable only with the admin key.
- `STORE_SCRAPED_POSTS=true` if digest mode is expected.
