# Bot Usage Guide

TG Feed Bot is operated mainly through Telegram private chat menus and inline buttons.

## Setup wizard

Send:

```text
/start
```

The bot shows a quick setup flow:

1. Set and verify a destination channel.
2. Follow the first public source channel.
3. Receive the first delivered post.

## Main channel gate

The bot checks whether a user follows the configured main channel:

```ts
MAIN_CHANNEL_USERNAME
```

If the user is not a member, the bot asks them to join before using the rest of the bot.

## Destination flow

A destination is the channel where mirrored posts are delivered.

### Create or change destination

Use either command:

```text
/newdest
/changedest
```

Then:

1. Create or choose a Telegram channel.
2. Add the bot as admin with posting permission.
3. The bot sends a code-only message like:

```text
DEST abc123...
```

4. Post that exact line in the destination channel.
5. The bot verifies the channel and links it to your account.

### Destination verification behavior

When Telegram reports access errors such as missing rights, removed bot, private channel access failure, or bot kick, the destination can be marked unverified. Re-run `/changedest` after fixing permissions.

## Follow channels

Use:

```text
/follow @channelname
```

Supported input formats:

```text
@channelname
https://t.me/channelname
channelname
```

You can also forward a message from a public channel to the bot. If Telegram exposes the forwarded channel username, the bot will use it automatically.

### Batch follow

You can send several channels separated by spaces, commas, or new lines:

```text
/follow @first @second https://t.me/third
```

The bot previews detected channels and asks for confirmation before adding them.

## Bulk import

Use:

```text
/import
```

Then paste a list like:

```text
@channel_one
@channel_two
https://t.me/channel_three
```

## Channel management

Use:

```text
/list
```

Each followed channel has a settings menu with:

| Setting | Description |
|---|---|
| Pause / Resume | Temporarily stop or resume delivery for a source |
| Mode | Choose realtime or digest delivery |
| Filters | Include/exclude keywords for that source |
| Backfill | Number of previous posts to send when following |
| Label | Custom display label for the source |
| Unfollow | Remove the source from your account |

## Delivery modes

### Realtime

New matching posts are delivered shortly after the source is scraped.

### Digest

Posts are grouped into a summary and sent every `digest_hours`. Digest mode depends on stored scraped posts, so production should set:

```env
STORE_SCRAPED_POSTS=true
```

### Quiet hours

Quiet hours pause realtime sends during a UTC hour window and queue matching posts for later.

Examples:

```text
1 8
```

Means quiet from 01:00 UTC up to, but not including, 08:00 UTC.

```text
off
```

Disables quiet hours.

## Filter syntax

Filters exist at two levels:

1. Global user filters from `/settings`
2. Per-channel filters from `/list` → channel settings

### Replace the full list

```text
bitcoin, ai, launch
```

### Patch the current list

```text
+cloudflare, -oldkeyword
```

### Clear the list

```text
clear
```

### Filter rules

1. Exclude filters win first. If any exclude keyword matches, the post is blocked.
2. If the include list is empty, the post passes.
3. If the include list is not empty, at least one include keyword must match.
4. Matching is case-insensitive substring matching.

### Limits

| Filter level | Limit per include/exclude list |
|---|---:|
| Per-channel | 40 keywords |
| Global | 80 keywords |

## Global settings

Open settings:

```text
/settings
```

Available global settings include:

| Setting | Description |
|---|---|
| Language | Persian or English UI |
| Realtime toggle | Enable or disable realtime delivery globally |
| Post style | Rich or compact output format |
| Full-text style | Quote or plain body rendering |
| Digest interval | 1 to 24 hours |
| Quiet hours | UTC quiet window |
| Default backfill | 0 to 10 posts |
| Global filters | Include/exclude filters across all sources |
| Test destination | Sends a test message to the verified destination |

## Commands reference

| Command | Description |
|---|---|
| `/start` | Open setup wizard or home menu |
| `/help` | Show help |
| `/commands` | Show command list |
| `/newdest` | Set destination channel |
| `/changedest` | Change destination channel |
| `/follow` | Add a public channel |
| `/import` | Bulk import channels |
| `/list` | Manage followed channels |
| `/settings` | Open settings |
| `/cancel` | Cancel current flow |
| `/done` | Exit batch add flow |
