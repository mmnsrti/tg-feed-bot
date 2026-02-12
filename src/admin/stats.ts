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
    destinationsVerified,
    subscriptionsTotal,
    subscriptionsRealtime,
    subscriptionsDigest,
    subscriptionsPaused,
    sourcesTotal,
    sourcesFailing,
    queuedRealtimeTotal,
    deliveriesLastHour,
    deliveriesLastDay,
    scrapedPostsTotal,
    scrapedPostsLastHour,
    scrapedPostsLastDay,
    oldestQueuedAt,
  ] = await Promise.all([
    countBy(env.DB, "SELECT COUNT(*) AS n FROM users"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM destinations WHERE verified=1"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources WHERE paused=0 AND mode='realtime'"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources WHERE paused=0 AND mode='digest'"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM user_sources WHERE paused=1"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM sources WHERE fail_count > 0"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM queued_realtime"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM deliveries WHERE created_at >= ?", [now - 3600]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM deliveries WHERE created_at >= ?", [now - 86400]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts"),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts WHERE scraped_at >= ?", [now - 3600]),
    countBy(env.DB, "SELECT COUNT(*) AS n FROM scraped_posts WHERE scraped_at >= ?", [now - 86400]),
    (async () => {
      const row = await env.DB.prepare("SELECT MIN(queued_at) AS oldest FROM queued_realtime").first<any>();
      return toSec(row?.oldest);
    })(),
  ]);

  const healthySources = Math.max(0, sourcesTotal - sourcesFailing);

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
      verified_destinations: destinationsVerified,
      subscriptions: subscriptionsTotal,
      subscriptions_realtime: subscriptionsRealtime,
      subscriptions_digest: subscriptionsDigest,
      subscriptions_paused: subscriptionsPaused,
      sources: sourcesTotal,
      sources_healthy: healthySources,
      sources_failing: sourcesFailing,
      queued_realtime: queuedRealtimeTotal,
      scraped_posts: scrapedPostsTotal,
    },
    activity: {
      deliveries_last_hour: deliveriesLastHour,
      deliveries_last_day: deliveriesLastDay,
      scraped_posts_last_hour: scrapedPostsLastHour,
      scraped_posts_last_day: scrapedPostsLastDay,
      oldest_queued_at: oldestQueuedAt || null,
      oldest_queued_at_iso: oldestQueuedAt ? isoFromSec(oldestQueuedAt) : null,
      oldest_queued_age_sec: oldestQueuedAt ? Math.max(0, now - oldestQueuedAt) : null,
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
      --bg: #f6f8fc;
      --panel: #ffffff;
      --text: #182132;
      --muted: #5d687c;
      --line: #d7deea;
      --good: #13824f;
      --warn: #a06000;
      --bad: #b32235;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      background: radial-gradient(circle at top right, #e8efff, var(--bg) 35%);
      color: var(--text);
    }
    .wrap {
      max-width: 1160px;
      margin: 24px auto 40px;
      padding: 0 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0.4px;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
    }
    .grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin: 18px 0 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 1px 0 rgba(16, 24, 40, 0.04);
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
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      margin-top: 14px;
      overflow: hidden;
    }
    .section h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 15px;
      border-bottom: 1px solid var(--line);
      background: #f9fbff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 9px 12px;
      border-bottom: 1px solid #edf1f8;
      vertical-align: top;
      text-align: left;
    }
    th { color: var(--muted); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .ok { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    code {
      background: #f2f5fa;
      border: 1px solid #e2e8f2;
      border-radius: 6px;
      padding: 1px 5px;
    }
    .error {
      color: var(--bad);
      font-size: 13px;
      margin-top: 10px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>TG Feed Bot Dashboard</h1>
    <div id="updated" class="muted">Loading...</div>
    <div id="cards" class="grid"></div>

    <div class="section">
      <h2>Ticker / Queue</h2>
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

    <div class="section">
      <h2>Failing Sources</h2>
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

    <div class="section">
      <h2>Upcoming Checks</h2>
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

    <div id="error" class="error"></div>
  </div>

  <script>
    const statsUrl = ${JSON.stringify(statsUrl)};

    function setText(id, text) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }

    function td(text) {
      const cell = document.createElement("td");
      cell.textContent = text;
      return cell;
    }

    function toStamp(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    }

    function setRows(id, rows, mapRow) {
      const body = document.getElementById(id);
      if (!body) return;
      body.innerHTML = "";
      if (!rows.length) {
        const tr = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
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
        ["Verified Destinations", data.totals.verified_destinations],
        ["Subscriptions", data.totals.subscriptions],
        ["Realtime Subs", data.totals.subscriptions_realtime],
        ["Digest Subs", data.totals.subscriptions_digest],
        ["Paused Subs", data.totals.subscriptions_paused],
        ["Sources", data.totals.sources],
        ["Failing Sources", data.totals.sources_failing],
        ["Queued Realtime", data.totals.queued_realtime],
        ["Deliveries (1h)", data.activity.deliveries_last_hour],
        ["Deliveries (24h)", data.activity.deliveries_last_day],
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
        val.textContent = String(v ?? 0);
        card.appendChild(key);
        card.appendChild(val);
        cards.appendChild(card);
      }

      const tickerBody = document.getElementById("ticker-body");
      tickerBody.innerHTML = "";
      const tickerRows = [
        ["Ticker alarm", toStamp(data.ticker.alarm_iso)],
        ["Ticker next run in (sec)", String(data.ticker.next_run_in_sec ?? "-")],
        ["Oldest queued post", toStamp(data.activity.oldest_queued_at_iso)],
        ["Oldest queued age (sec)", String(data.activity.oldest_queued_age_sec ?? "-")]
      ];
      for (const [k, v] of tickerRows) {
        const tr = document.createElement("tr");
        tr.appendChild(td(k));
        tr.appendChild(td(v));
        tickerBody.appendChild(tr);
      }

      setRows("failing-body", data.sources.failing || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(td("@" + row.username));
        tr.appendChild(td(String(row.fail_count)));
        tr.appendChild(td(toStamp(row.next_check_at_iso)));
        tr.appendChild(td(row.last_error || "-"));
        tr.appendChild(td(toStamp(row.last_success_at_iso)));
        return tr;
      });

      setRows("next-body", data.sources.next_to_check || [], (row) => {
        const tr = document.createElement("tr");
        tr.appendChild(td("@" + row.username));
        tr.appendChild(td(toStamp(row.next_check_at_iso)));
        tr.appendChild(td(String(row.check_every_sec)));
        tr.appendChild(td(String(row.fail_count)));
        tr.appendChild(td(toStamp(row.last_success_at_iso)));
        return tr;
      });
    }

    async function refresh() {
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
      }
    }

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}
