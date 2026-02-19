/// <reference types="@cloudflare/workers-types" />

import { Env } from "../types";

type SourceRow = {
  username: string;
  fail_count: number;
  check_every_sec: number;
  next_check_at: number;
  last_error: string | null;
  last_error_at: number;
  last_success_at: number;
};

type SourceSubscribersRow = {
  username: string;
  subs_total: number;
  subs_realtime: number;
  subs_digest: number;
  subs_paused: number;
};

type UserSubscriptionsRow = {
  user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  subs_total: number;
  subs_active: number;
  subs_realtime: number;
  subs_digest: number;
  destination_verified: number;
};

type RecentUserRow = {
  user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: number;
  updated_at: number;
};

type QueueHotspotRow = {
  username: string;
  queued_count: number;
  affected_users: number;
  oldest_queued_at: number;
  newest_queued_at: number;
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toSec(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isoFromSec(sec: number): string | null {
  if (!sec) return null;
  return new Date(sec * 1000).toISOString();
}

function isoFromMs(ms: number): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

async function countBy(db: D1Database, sql: string, binds: any[] = []): Promise<number> {
  const stmt = db.prepare(sql);
  const row = binds.length ? await stmt.bind(...binds).first<any>() : await stmt.first<any>();
  return Number(row?.n ?? 0);
}

async function readTickerAlarmMs(env: Env): Promise<number | null> {
  try {
    const id = env.TICKER.idFromName("global");
    const stub = env.TICKER.get(id);
    const res = await stub.fetch("https://ticker/status");
    if (!res.ok) return null;
    const body = await res.json<any>();
    return typeof body?.alarm === "number" ? body.alarm : null;
  } catch {
    return null;
  }
}

export async function buildAdminStats(env: Env) {
  const now = nowSec();
  const tickerAlarmMs = await readTickerAlarmMs(env);

  const [
    usersTotal,
    destinationsTotal,
    destinationsVerified,
    destinationsUnverified,
    subscriptionsTotal,
    subscriptionsRealtime,
    subscriptionsDigest,
    subscriptionsPaused,
    usersWithSubscriptions,
    avgSubsPerSubscribedUser,
    usersRealtimeEnabled,
    usersQuietHoursEnabled,
    usersWithGlobalInclude,
    usersWithGlobalExclude,
    usersWithAnyGlobalFilter,
    sourcesWithAnyChannelFilter,
    sourcesTotal,
    sourcesFailing,
    sourcesNeverSuccess,
    sourcesStale30m,
    sourcesStale2h,
    sourcesDueNow,
    sourcesDueNextMin,
    queuedRealtimeTotal,
    queuedUsers,
    queuedSources,
    deliveriesLast5Min,
    deliveriesLastHour,
    deliveriesLastDay,
    scrapedPostsTotal,
    scrapedPostsLast5Min,
    scrapedPostsLastHour,
    scrapedPostsLastDay,
    oldestQueuedAt,
    digestUsersActive,
    digestUsersDue,
  ] = await Promise.all([
    countBy(env.DB, "SELECT COUNT(*) AS n FROM users"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM destinations"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM destinations WHERE verified=1"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM destinations WHERE verified=0"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources WHERE paused=0 AND mode='realtime'"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources WHERE paused=0 AND mode='digest'"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources WHERE paused=1"),
    countBy(env.DB, "SELECT COUNT(DISTINCT user_id) AS n FROM user_sources"),
    (async () => {
      const row = await env.DB.prepare("SELECT AVG(cnt) AS n FROM (SELECT COUNT(*) AS cnt FROM user_sources GROUP BY user_id)").first<any>();
      const n = Number(row?.n ?? 0);
      return Number.isFinite(n) ? n : 0;
    })(),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_prefs WHERE realtime_enabled=1"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_prefs WHERE quiet_start>=0 AND quiet_end>=0"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_prefs WHERE COALESCE(global_include_keywords, '[]') != '[]'"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_prefs WHERE COALESCE(global_exclude_keywords, '[]') != '[]'"),
    countBy(
      env.DB,
      "SELECT COUNT(*) AS n FROM user_prefs WHERE COALESCE(global_include_keywords, '[]') != '[]' OR COALESCE(global_exclude_keywords, '[]') != '[]'"
    ),
    countBy(
      env.DB,
      "SELECT COUNT(*) AS n FROM user_sources WHERE COALESCE(include_keywords, '[]') != '[]' OR COALESCE(exclude_keywords, '[]') != '[]'"
    ),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE fail_count > 0"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE last_success_at = 0"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE last_success_at > 0 AND last_success_at < ?", [now - 30 * 60]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE last_success_at > 0 AND last_success_at < ?", [now - 2 * 3600]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE next_check_at > 0 AND next_check_at <= ?", [now]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE next_check_at > ? AND next_check_at <= ?", [now, now + 60]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM queued_realtime"),
    countBy(env.DB, "SELECT COUNT(DISTINCT user_id) AS n FROM queued_realtime"),
    countBy(env.DB, "SELECT COUNT(DISTINCT username) AS n FROM queued_realtime"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM deliveries WHERE created_at >= ?", [now - 5 * 60]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM deliveries WHERE created_at >= ?", [now - 3600]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM deliveries WHERE created_at >= ?", [now - 86400]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts WHERE scraped_at >= ?", [now - 5 * 60]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts WHERE scraped_at >= ?", [now - 3600]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts WHERE scraped_at >= ?", [now - 86400]),
    (async () => {
      const row = await env.DB.prepare("SELECT MIN(queued_at) AS oldest FROM queued_realtime").first<any>();
      return toSec(row?.oldest);
    })(),
    countBy(env.DB, "SELECT COUNT(DISTINCT user_id) AS n FROM user_sources WHERE mode='digest' AND paused=0"),
    countBy(
      env.DB,
      `SELECT COUNT(DISTINCT us.user_id) AS n
       FROM user_sources us
       JOIN user_prefs p ON p.user_id = us.user_id
       JOIN destinations d ON d.user_id = us.user_id AND d.verified = 1
       WHERE us.mode='digest' AND us.paused=0
         AND (p.last_digest_at = 0 OR p.last_digest_at <= (? - (p.digest_hours * 3600)))`,
      [now]
    ),
  ]);

  const healthySources = Math.max(0, sourcesTotal - sourcesFailing);
  const usersWithoutDestination = Math.max(0, usersTotal - destinationsTotal);
  const avgSubsPerUser = usersTotal > 0 ? subscriptionsTotal / usersTotal : 0;
  const deliveriesPerMinute5m = deliveriesLast5Min / 5;
  const scrapedPerMinute5m = scrapedPostsLast5Min / 5;

  const failingRows = await env.DB
    .prepare(
      `SELECT username, fail_count, check_every_sec, next_check_at, last_error, last_error_at, last_success_at
       FROM sources
       WHERE fail_count > 0
       ORDER BY fail_count DESC, last_error_at DESC
       LIMIT 20`
    )
    .all<SourceRow>();

  const nextCheckRows = await env.DB
    .prepare(
      `SELECT username, fail_count, check_every_sec, next_check_at, last_error, last_error_at, last_success_at
       FROM sources
       ORDER BY next_check_at ASC
       LIMIT 20`
    )
    .all<SourceRow>();

  const topSourcesRows = await env.DB
    .prepare(
      `SELECT username,
              COUNT(*) AS subs_total,
              SUM(CASE WHEN paused=0 AND mode='realtime' THEN 1 ELSE 0 END) AS subs_realtime,
              SUM(CASE WHEN paused=0 AND mode='digest' THEN 1 ELSE 0 END) AS subs_digest,
              SUM(CASE WHEN paused=1 THEN 1 ELSE 0 END) AS subs_paused
       FROM user_sources
       GROUP BY username
       ORDER BY subs_total DESC, username ASC
       LIMIT 20`
    )
    .all<SourceSubscribersRow>();

  const topUsersRows = await env.DB
    .prepare(
      `SELECT us.user_id,
              u.username,
              u.first_name,
              u.last_name,
              COUNT(*) AS subs_total,
              SUM(CASE WHEN us.paused=0 THEN 1 ELSE 0 END) AS subs_active,
              SUM(CASE WHEN us.paused=0 AND us.mode='realtime' THEN 1 ELSE 0 END) AS subs_realtime,
              SUM(CASE WHEN us.paused=0 AND us.mode='digest' THEN 1 ELSE 0 END) AS subs_digest,
              COALESCE(d.verified, 0) AS destination_verified
       FROM user_sources us
       LEFT JOIN destinations d ON d.user_id = us.user_id
       LEFT JOIN users u ON u.user_id = us.user_id
       GROUP BY us.user_id
       ORDER BY subs_total DESC, us.user_id ASC
       LIMIT 20`
    )
    .all<UserSubscriptionsRow>();

  const recentUsersRows = await env.DB
    .prepare(
      `SELECT user_id, username, first_name, last_name, created_at, updated_at
       FROM users
       ORDER BY COALESCE(updated_at, created_at) DESC, user_id DESC
       LIMIT 20`
    )
    .all<RecentUserRow>();

  const queueHotspotsRows = await env.DB
    .prepare(
      `SELECT username,
              COUNT(*) AS queued_count,
              COUNT(DISTINCT user_id) AS affected_users,
              MIN(queued_at) AS oldest_queued_at,
              MAX(queued_at) AS newest_queued_at
       FROM queued_realtime
       GROUP BY username
       ORDER BY queued_count DESC, affected_users DESC, username ASC
       LIMIT 20`
    )
    .all<QueueHotspotRow>();

  return {
    generated_at: now,
    generated_at_iso: isoFromSec(now),
    ticker: {
      alarm_ms: tickerAlarmMs,
      alarm_iso: tickerAlarmMs ? isoFromMs(tickerAlarmMs) : null,
      next_run_in_sec: tickerAlarmMs ? Math.max(0, Math.round((tickerAlarmMs - Date.now()) / 1000)) : null,
    },
    totals: {
      users: usersTotal,
      destinations: destinationsTotal,
      verified_destinations: destinationsVerified,
      unverified_destinations: destinationsUnverified,
      users_without_destination: usersWithoutDestination,
      subscriptions: subscriptionsTotal,
      subscriptions_realtime: subscriptionsRealtime,
      subscriptions_digest: subscriptionsDigest,
      subscriptions_paused: subscriptionsPaused,
      users_with_subscriptions: usersWithSubscriptions,
      avg_subscriptions_per_user: Number(avgSubsPerUser.toFixed(2)),
      avg_subscriptions_per_subscribed_user: Number(avgSubsPerSubscribedUser.toFixed(2)),
      sources: sourcesTotal,
      sources_healthy: healthySources,
      sources_failing: sourcesFailing,
      sources_never_success: sourcesNeverSuccess,
      sources_stale_30m: sourcesStale30m,
      sources_stale_2h: sourcesStale2h,
      sources_due_now: sourcesDueNow,
      sources_due_next_min: sourcesDueNextMin,
      queued_realtime: queuedRealtimeTotal,
      queued_users: queuedUsers,
      queued_sources: queuedSources,
      scraped_posts: scrapedPostsTotal,
    },
    adoption: {
      users_realtime_enabled: usersRealtimeEnabled,
      users_quiet_hours_enabled: usersQuietHoursEnabled,
      users_with_global_include: usersWithGlobalInclude,
      users_with_global_exclude: usersWithGlobalExclude,
      users_with_any_global_filter: usersWithAnyGlobalFilter,
      subscriptions_with_channel_filters: sourcesWithAnyChannelFilter,
    },
    activity: {
      deliveries_last_5m: deliveriesLast5Min,
      deliveries_last_hour: deliveriesLastHour,
      deliveries_last_day: deliveriesLastDay,
      deliveries_per_min_last_5m: Number(deliveriesPerMinute5m.toFixed(2)),
      scraped_posts_last_5m: scrapedPostsLast5Min,
      scraped_posts_last_hour: scrapedPostsLastHour,
      scraped_posts_last_day: scrapedPostsLastDay,
      scraped_per_min_last_5m: Number(scrapedPerMinute5m.toFixed(2)),
      oldest_queued_at: oldestQueuedAt || null,
      oldest_queued_at_iso: oldestQueuedAt ? isoFromSec(oldestQueuedAt) : null,
      oldest_queued_age_sec: oldestQueuedAt ? Math.max(0, now - oldestQueuedAt) : null,
    },
    digest: {
      users_active: digestUsersActive,
      users_due_now: digestUsersDue,
    },
    sources: {
      failing: (failingRows.results || []).map((r) => ({
        username: r.username,
        fail_count: toSec(r.fail_count),
        check_every_sec: toSec(r.check_every_sec),
        next_check_at: toSec(r.next_check_at),
        next_check_at_iso: isoFromSec(toSec(r.next_check_at)),
        last_error: r.last_error || null,
        last_error_at: toSec(r.last_error_at) || null,
        last_error_at_iso: isoFromSec(toSec(r.last_error_at)),
        last_success_at: toSec(r.last_success_at) || null,
        last_success_at_iso: isoFromSec(toSec(r.last_success_at)),
      })),
      next_to_check: (nextCheckRows.results || []).map((r) => ({
        username: r.username,
        fail_count: toSec(r.fail_count),
        check_every_sec: toSec(r.check_every_sec),
        next_check_at: toSec(r.next_check_at),
        next_check_at_iso: isoFromSec(toSec(r.next_check_at)),
        last_success_at: toSec(r.last_success_at) || null,
        last_success_at_iso: isoFromSec(toSec(r.last_success_at)),
      })),
      top_by_subscribers: (topSourcesRows.results || []).map((r) => ({
        username: r.username,
        subscriptions_total: toSec(r.subs_total),
        subscriptions_realtime: toSec(r.subs_realtime),
        subscriptions_digest: toSec(r.subs_digest),
        subscriptions_paused: toSec(r.subs_paused),
      })),
    },
    users: {
      top_by_subscriptions: (topUsersRows.results || []).map((r) => ({
        user_id: toSec(r.user_id),
        username: r.username || null,
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        subscriptions_total: toSec(r.subs_total),
        subscriptions_active: toSec(r.subs_active),
        subscriptions_realtime: toSec(r.subs_realtime),
        subscriptions_digest: toSec(r.subs_digest),
        destination_verified: toSec(r.destination_verified) === 1,
      })),
      recent: (recentUsersRows.results || []).map((r) => ({
        user_id: toSec(r.user_id),
        username: r.username || null,
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        created_at: toSec(r.created_at) || null,
        created_at_iso: isoFromSec(toSec(r.created_at)),
        updated_at: toSec(r.updated_at) || null,
        updated_at_iso: isoFromSec(toSec(r.updated_at)),
      })),
    },
    queue: {
      hotspots: (queueHotspotsRows.results || []).map((r) => ({
        username: r.username,
        queued_count: toSec(r.queued_count),
        affected_users: toSec(r.affected_users),
        oldest_queued_at: toSec(r.oldest_queued_at) || null,
        oldest_queued_at_iso: isoFromSec(toSec(r.oldest_queued_at)),
        newest_queued_at: toSec(r.newest_queued_at) || null,
        newest_queued_at_iso: isoFromSec(toSec(r.newest_queued_at)),
      })),
    },
  };
}

export function renderAdminStatsPage(adminKeyFromUrl: string) {
  const keyQuery = adminKeyFromUrl ? `?key=${encodeURIComponent(adminKeyFromUrl)}` : "";
  const statsUrl = `/admin/stats.json${keyQuery}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TG Feed Bot Stats</title>
  <style>
    :root {
      --bg: #070d1a;
      --bg-2: #0f1830;
      --panel: #101b33;
      --panel-2: #0e172b;
      --text: #e5edff;
      --muted: #91a3c9;
      --line: #273659;
      --accent: #66b2ff;
      --accent-soft: rgba(102, 178, 255, 0.18);
      --good: #4fdb99;
      --warn: #ffc978;
      --bad: #ff7d91;
      --shadow: 0 20px 40px rgba(2, 6, 16, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", Tahoma, sans-serif;
      background:
        radial-gradient(circle at 8% -10%, #1f3362 0%, transparent 38%),
        radial-gradient(circle at 92% -10%, #153b63 0%, transparent 40%),
        linear-gradient(180deg, var(--bg-2) 0%, var(--bg) 60%);
      color: var(--text);
    }
    .wrap {
      max-width: 1500px;
      margin: 20px auto 38px;
      padding: 0 18px;
    }
    .head {
      background: linear-gradient(180deg, rgba(18, 30, 55, 0.9), rgba(14, 24, 45, 0.9));
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: var(--shadow);
    }
    h1 {
      margin: 0;
      font-size: 30px;
      letter-spacing: 0.3px;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
    }
    .subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      border: 1px solid #2f4f86;
      background: #152544;
      color: #dbe7ff;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s ease, border-color 0.2s ease;
    }
    .btn:hover {
      background: #1a315d;
      border-color: #4f78be;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .pill {
      border: 1px solid #2a3f69;
      background: #14213a;
      color: #abc0eb;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .nav {
      position: sticky;
      top: 14px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      border-radius: 14px;
      padding: 12px;
      box-shadow: var(--shadow);
      display: grid;
      gap: 8px;
    }
    .nav-tab {
      width: 100%;
      text-align: left;
      border: 1px solid #2a3e66;
      background: #121f38;
      color: #b7c8ea;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    }
    .nav-tab:hover {
      border-color: #42609a;
      color: #d9e6ff;
    }
    .nav-tab.active {
      background: var(--accent-soft);
      border-color: #4d84ce;
      color: #dff0ff;
    }
    .panels {
      min-width: 0;
    }
    .panel {
      display: none;
    }
    .panel.active {
      display: block;
      animation: panel-fade 0.2s ease;
    }
    @keyframes panel-fade {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      margin: 0 0 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .k {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .v {
      font-size: 26px;
      font-weight: 700;
    }
    .section {
      background: linear-gradient(180deg, #111d36 0%, #101a2f 100%);
      border: 1px solid var(--line);
      border-radius: 14px;
      margin-top: 14px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .section h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 15px;
      border-bottom: 1px solid var(--line);
      background: #121f3a;
    }
    .table-scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      min-width: 640px;
    }
    th, td {
      padding: 9px 12px;
      border-bottom: 1px solid #1f2f4f;
      vertical-align: top;
      text-align: left;
    }
    th { color: var(--muted); font-weight: 600; }
    tbody tr:nth-child(even) { background: rgba(16, 26, 47, 0.36); }
    tbody tr:hover { background: rgba(102, 178, 255, 0.08); }
    tr:last-child td { border-bottom: 0; }
    .username-link {
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
    }
    .username-link:hover {
      text-decoration: underline;
    }
    .mono {
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      letter-spacing: 0.15px;
    }
    .ok { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    code {
      background: #162543;
      border: 1px solid #2b416c;
      border-radius: 6px;
      padding: 1px 5px;
    }
    .error {
      color: var(--bad);
      font-size: 13px;
      margin-top: 10px;
      display: none;
    }
    @media (max-width: 980px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .nav {
        position: static;
        display: flex;
        flex-wrap: wrap;
      }
      .nav-tab {
        width: auto;
        flex: 1 1 calc(50% - 8px);
      }
      .pill {
        display: none;
      }
      .v {
        font-size: 24px;
      }
      table {
        min-width: 560px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>TG Feed Bot Dashboard</h1>
      <div class="subtitle">Dark mode, split by area: overview, source health, users, and queue pressure.</div>
      <div class="topbar">
        <div id="updated" class="muted">Loading...</div>
        <div class="actions">
          <button id="refresh-btn" class="btn">Refresh now</button>
          <span id="refresh-note" class="pill">Auto refresh: 10s</span>
        </div>
      </div>
    </div>
    <div class="layout">
      <nav class="nav" aria-label="Dashboard Sections">
        <button type="button" class="nav-tab active" data-panel="overview">Overview</button>
        <button type="button" class="nav-tab" data-panel="sources">Sources</button>
        <button type="button" class="nav-tab" data-panel="users">Users</button>
        <button type="button" class="nav-tab" data-panel="queue">Queue</button>
      </nav>

      <div class="panels">
        <section id="panel-overview" class="panel active">
          <div id="cards" class="grid"></div>

          <div class="section">
            <h2>Ticker / Queue</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody id="ticker-body"></tbody>
            </table>
            </div>
          </div>

          <div class="section">
            <h2>Adoption / Preferences</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody id="adoption-body"></tbody>
            </table>
            </div>
          </div>
        </section>

        <section id="panel-sources" class="panel">
          <div class="section">
            <h2>Failing Sources</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Fail Count</th>
                  <th>Next Check</th>
                  <th>Last Error</th>
                  <th>Last Success</th>
                </tr>
              </thead>
              <tbody id="failing-body"></tbody>
            </table>
            </div>
          </div>

          <div class="section">
            <h2>Upcoming Checks</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Next Check</th>
                  <th>Every (sec)</th>
                  <th>Fail Count</th>
                  <th>Last Success</th>
                </tr>
              </thead>
              <tbody id="next-body"></tbody>
            </table>
            </div>
          </div>

          <div class="section">
            <h2>Top Sources by Subscribers</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Total Subs</th>
                  <th>Realtime</th>
                  <th>Digest</th>
                  <th>Paused</th>
                </tr>
              </thead>
              <tbody id="top-sources-body"></tbody>
            </table>
            </div>
          </div>
        </section>

        <section id="panel-users" class="panel">
          <div class="section">
            <h2>Top Users by Subscriptions</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Name</th>
                  <th>User ID</th>
                  <th>Total Subs</th>
                  <th>Active</th>
                  <th>Realtime</th>
                  <th>Digest</th>
                  <th>Destination</th>
                </tr>
              </thead>
              <tbody id="top-users-body"></tbody>
            </table>
            </div>
          </div>

          <div class="section">
            <h2>Recent Users</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Name</th>
                  <th>User ID</th>
                  <th>Last Seen</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody id="recent-users-body"></tbody>
            </table>
            </div>
          </div>
        </section>

        <section id="panel-queue" class="panel">
          <div class="section">
            <h2>Queue Hotspots</h2>
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Queued</th>
                  <th>Affected Users</th>
                  <th>Oldest</th>
                  <th>Newest</th>
                </tr>
              </thead>
              <tbody id="queue-hotspots-body"></tbody>
            </table>
            </div>
          </div>
        </section>
      </div>
    </div>

    <div id="error" class="error"></div>
  </div>

  <script>
    const statsUrl = ${JSON.stringify(statsUrl)};
    const validPanels = new Set(["overview", "sources", "users", "queue"]);
    const navTabs = Array.from(document.querySelectorAll(".nav-tab"));

    function setActivePanel(name) {
      const panel = validPanels.has(name) ? name : "overview";
      for (const tab of navTabs) {
        const isActive = tab.dataset.panel === panel;
        tab.classList.toggle("active", isActive);
      }
      for (const section of document.querySelectorAll(".panel")) {
        section.classList.toggle("active", section.id === "panel-" + panel);
      }
    }

    for (const tab of navTabs) {
      tab.addEventListener("click", () => setActivePanel(tab.dataset.panel || "overview"));
    }
    setActivePanel("overview");

    function setText(id, text) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }

    const intFormatter = new Intl.NumberFormat();
    const floatFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

    function td(text, className) {
      const cell = document.createElement("td");
      cell.textContent = text;
      if (className) cell.className = className;
      return cell;
    }

    function tdUsername(username) {
      const cell = document.createElement("td");
      const value = String(username || "").trim();
      if (!value) {
        cell.textContent = "-";
        cell.className = "muted";
        return cell;
      }
      const handle = value.startsWith("@") ? value.slice(1) : value;
      const link = document.createElement("a");
      link.className = "username-link";
      link.href = "https://t.me/" + encodeURIComponent(handle);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "@" + handle;
      cell.appendChild(link);
      return cell;
    }

    function formatNum(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "0";
      return Number.isInteger(n) ? intFormatter.format(n) : floatFormatter.format(n);
    }

    function formatName(firstName, lastName) {
      const parts = [firstName, lastName]
        .map((v) => String(v || "").trim())
        .filter(Boolean);
      return parts.length ? parts.join(" ") : "-";
    }

    function toStamp(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    }

    function setRows(id, rows, mapRow, emptyColspan = 5) {
      const body = document.getElementById(id);
      if (!body) return;
      body.innerHTML = "";
      if (!rows.length) {
        const tr = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = emptyColspan;
        cell.textContent = "No data";
        tr.appendChild(cell);
        body.appendChild(tr);
        return;
      }
      for (const row of rows) body.appendChild(mapRow(row));
    }

    function render(data) {
      setText("updated", "Updated: " + toStamp(data.generated_at_iso) + " (auto refresh: 10s)");
      const cards = document.getElementById("cards");
      cards.innerHTML = "";

      const cardItems = [
        ["Users", data.totals.users],
        ["Destinations", data.totals.destinations],
        ["Verified Destinations", data.totals.verified_destinations],
        ["Users w/o Destination", data.totals.users_without_destination],
        ["Subscriptions", data.totals.subscriptions],
        ["Avg Subs / User", data.totals.avg_subscriptions_per_user],
        ["Realtime Subs", data.totals.subscriptions_realtime],
        ["Digest Subs", data.totals.subscriptions_digest],
        ["Paused Subs", data.totals.subscriptions_paused],
        ["Sources", data.totals.sources],
        ["Failing Sources", data.totals.sources_failing],
        ["Sources Stale (30m)", data.totals.sources_stale_30m],
        ["Sources Due Now", data.totals.sources_due_now],
        ["Queued Realtime", data.totals.queued_realtime],
        ["Queued Users", data.totals.queued_users],
        ["Deliveries (5m)", data.activity.deliveries_last_5m],
        ["Deliveries (1h)", data.activity.deliveries_last_hour],
        ["Deliveries (24h)", data.activity.deliveries_last_day],
        ["Scraped Posts (5m)", data.activity.scraped_posts_last_5m],
        ["Scraped Posts (24h)", data.activity.scraped_posts_last_day]
      ];

      for (const [k, v] of cardItems) {
        const card = document.createElement("div");
        card.className = "card";
        const key = document.createElement("div");
        key.className = "k";
        key.textContent = String(k);
        const val = document.createElement("div");
        val.className = "v";
        val.textContent = formatNum(v ?? 0);
        card.appendChild(key);
        card.appendChild(val);
        cards.appendChild(card);
      }

      const tickerBody = document.getElementById("ticker-body");
      tickerBody.innerHTML = "";
      const tickerRows = [
        ["Ticker alarm", toStamp(data.ticker.alarm_iso)],
        ["Ticker next run in (sec)", String(data.ticker.next_run_in_sec ?? "-")],
        ["Sources due in next minute", String(data.totals.sources_due_next_min ?? 0)],
        ["Digest users due now", String(data.digest.users_due_now ?? 0)],
        ["Queue users", String(data.totals.queued_users ?? 0)],
        ["Queue sources", String(data.totals.queued_sources ?? 0)],
        ["Deliveries/min (last 5m)", String(data.activity.deliveries_per_min_last_5m ?? 0)],
        ["Scraped/min (last 5m)", String(data.activity.scraped_per_min_last_5m ?? 0)],
        ["Oldest queued post", toStamp(data.activity.oldest_queued_at_iso)],
        ["Oldest queued age (sec)", String(data.activity.oldest_queued_age_sec ?? "-")]
      ];
      for (const [k, v] of tickerRows) {
        const tr = document.createElement("tr");
        tr.appendChild(td(k));
        tr.appendChild(td(v));
        tickerBody.appendChild(tr);
      }

      const adoptionBody = document.getElementById("adoption-body");
      adoptionBody.innerHTML = "";
      const adoptionRows = [
        ["Users with subscriptions", String(data.totals.users_with_subscriptions ?? 0)],
        ["Avg subs / subscribed user", String(data.totals.avg_subscriptions_per_subscribed_user ?? 0)],
        ["Realtime enabled users", String(data.adoption.users_realtime_enabled ?? 0)],
        ["Users with quiet hours", String(data.adoption.users_quiet_hours_enabled ?? 0)],
        ["Users with global include filters", String(data.adoption.users_with_global_include ?? 0)],
        ["Users with global exclude filters", String(data.adoption.users_with_global_exclude ?? 0)],
        ["Users with any global filter", String(data.adoption.users_with_any_global_filter ?? 0)],
        ["Subscriptions with per-channel filters", String(data.adoption.subscriptions_with_channel_filters ?? 0)],
        ["Sources never successful", String(data.totals.sources_never_success ?? 0)],
        ["Sources stale over 2h", String(data.totals.sources_stale_2h ?? 0)]
      ];
      for (const [k, v] of adoptionRows) {
        const tr = document.createElement("tr");
        tr.appendChild(td(k));
        tr.appendChild(td(v));
        adoptionBody.appendChild(tr);
      }

      setRows("failing-body", data.sources.failing || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(tdUsername(row.username));
        tr.appendChild(td(formatNum(row.fail_count)));
        tr.appendChild(td(toStamp(row.next_check_at_iso)));
        tr.appendChild(td(row.last_error || "-"));
        tr.appendChild(td(toStamp(row.last_success_at_iso)));
        return tr;
      });

      setRows("next-body", data.sources.next_to_check || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(tdUsername(row.username));
        tr.appendChild(td(toStamp(row.next_check_at_iso)));
        tr.appendChild(td(formatNum(row.check_every_sec)));
        tr.appendChild(td(formatNum(row.fail_count)));
        tr.appendChild(td(toStamp(row.last_success_at_iso)));
        return tr;
      });

      setRows("top-sources-body", data.sources.top_by_subscribers || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(tdUsername(row.username));
        tr.appendChild(td(formatNum(row.subscriptions_total)));
        tr.appendChild(td(formatNum(row.subscriptions_realtime)));
        tr.appendChild(td(formatNum(row.subscriptions_digest)));
        tr.appendChild(td(formatNum(row.subscriptions_paused)));
        return tr;
      });

      setRows("top-users-body", data.users.top_by_subscriptions || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(tdUsername(row.username));
        tr.appendChild(td(formatName(row.first_name, row.last_name)));
        tr.appendChild(td(String(row.user_id), "mono"));
        tr.appendChild(td(formatNum(row.subscriptions_total)));
        tr.appendChild(td(formatNum(row.subscriptions_active)));
        tr.appendChild(td(formatNum(row.subscriptions_realtime)));
        tr.appendChild(td(formatNum(row.subscriptions_digest)));
        tr.appendChild(td(row.destination_verified ? "Verified" : "Not verified", row.destination_verified ? "ok" : "warn"));
        return tr;
      }, 8);

      setRows("recent-users-body", data.users.recent || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(tdUsername(row.username));
        tr.appendChild(td(formatName(row.first_name, row.last_name)));
        tr.appendChild(td(String(row.user_id), "mono"));
        tr.appendChild(td(toStamp(row.updated_at_iso || row.created_at_iso)));
        tr.appendChild(td(toStamp(row.created_at_iso)));
        return tr;
      }, 5);

      setRows("queue-hotspots-body", data.queue.hotspots || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(tdUsername(row.username));
        tr.appendChild(td(formatNum(row.queued_count)));
        tr.appendChild(td(formatNum(row.affected_users)));
        tr.appendChild(td(toStamp(row.oldest_queued_at_iso)));
        tr.appendChild(td(toStamp(row.newest_queued_at_iso)));
        return tr;
      });
    }

    const refreshBtn = document.getElementById("refresh-btn");
    let refreshBusy = false;

    async function refresh() {
      if (refreshBusy) return;
      refreshBusy = true;
      if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "Refreshing...";
      }
      const err = document.getElementById("error");
      try {
        const res = await fetch(statsUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        err.style.display = "none";
        render(data);
      } catch (e) {
        err.textContent = "Failed to load stats: " + (e && e.message ? e.message : String(e));
        err.style.display = "block";
      } finally {
        refreshBusy = false;
        if (refreshBtn) {
          refreshBtn.disabled = false;
          refreshBtn.textContent = "Refresh now";
        }
      }
    }

    if (refreshBtn) refreshBtn.addEventListener("click", () => refresh());
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}
