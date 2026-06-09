# Troubleshooting

## Webhook returns `403 forbidden`

Cause: the request is missing or using the wrong Telegram webhook secret.

Fix:

1. Confirm production secret:

```bash
pnpm exec wrangler secret put WEBHOOK_SECRET
```

2. Register webhook with the same value:

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-worker-domain>/telegram",
    "secret_token": "<WEBHOOK_SECRET>",
    "drop_pending_updates": true
  }'
```

## Bot does not respond locally

Check these items:

- `pnpm run dev` is running.
- `.dev.vars` contains `BOT_TOKEN` and `WEBHOOK_SECRET`.
- `pnpm run poll` is running in a second terminal.
- `LOCAL_ENDPOINT` points to your local Worker `/telegram` URL.
- Local D1 schema was initialized with `schema.sql`.

## Destination verification does not complete

Common causes:

- The `DEST <token>` message was posted in the wrong channel.
- The token was changed or partially copied.
- The bot is not an admin in the destination channel.
- The bot lacks message posting permission.

Fix:

1. Add the bot as admin to the destination channel.
2. Give it permission to post messages.
3. Run `/changedest`.
4. Post the newly generated `DEST <token>` line exactly as provided.

## Destination becomes unverified later

The bot marks a destination unverified when Telegram returns access or rights errors.

Fix:

1. Re-add the bot to the channel if removed.
2. Restore admin/posting rights.
3. Run `/changedest` or `/newdest` again.

## No new posts are delivered

Check:

- Source channel is public and visible at `https://t.me/s/<username>`.
- Destination is verified.
- User/global realtime setting is enabled.
- Channel is not paused.
- Filters are not blocking posts.
- Quiet hours are not active.
- `/admin/ticker/status` shows an active alarm.
- `/admin/stats.json` does not show persistent source failures.

Manual test:

```bash
curl -sS -X POST "https://<your-worker-domain>/admin/run-scrape" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

## Digest does not arrive

Check:

- `STORE_SCRAPED_POSTS=true` is set in production.
- The channel mode is `digest`.
- The channel is not paused.
- Destination is verified.
- Digest interval has elapsed.
- Matching posts exist after filters are applied.

## Follow fails with “couldn’t read”

Likely causes:

- Channel is private.
- Channel username is wrong.
- Telegram preview page has no readable posts.
- Telegram preview HTML changed and scraper needs adjustment.

Try opening:

```text
https://t.me/s/<username>
```

If it is not publicly readable, the bot cannot scrape it.

## Admin dashboard is forbidden

Use one of the supported auth methods:

```bash
curl -sS "https://<your-worker-domain>/admin/stats.json" \
  -H "Authorization: Bearer <ADMIN_KEY>"
```

If `ADMIN_KEY` was not configured, use `WEBHOOK_SECRET`.

## Duplicate messages appear

The bot uses the `deliveries` table to deduplicate by user, source, and post ID. Duplicates can still happen if:

- the database was wiped
- the source post ID changed unexpectedly
- multiple deployments point to different databases
- delivery records older than retention were pruned and old posts were reprocessed

## Media does not copy perfectly

The bot tries high-fidelity Telegram operations first, then falls back to media URLs or text. Some native Telegram media cannot be fully reconstructed from public preview pages.

Expected fallback order:

1. copy message
2. forward message
3. direct media send
4. text with original link
