/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { Env, TgUpdate } from "./types";
import { ensureDbUpgrades } from "./db/schema";
import { handleCallback, handleChannelPost, handlePrivateMessage } from "./telegram/handlers";
import { ensureBotCommands } from "./telegram/commands";
import { runScrapeTick } from "./ticker/do";
import { buildAdminStats, renderAdminStatsPage } from "./admin/stats";

const app = new Hono<{ Bindings: Env }>();

const TICK_MS = 5000;
const LOCK_KEY = "scrape_lock";
const LOCK_TTL_MS = 25_000;
const PRUNE_KEY = "deliveries_prune_at";
const PRUNE_INTERVAL_SEC = 6 * 3600;
const DELIVERY_TTL_DAYS = 14;

async function processUpdate(env: Env, update: TgUpdate) {
  await ensureDbUpgrades(env.DB);
  await ensureBotCommands(env);

  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }
  if (update.message && update.message.chat?.type === "private") {
    await handlePrivateMessage(env, update.message);
    return;
  }
  if (update.channel_post) {
    await handleChannelPost(env, update.channel_post);
    return;
  }
}

async function ensureTickerStarted(env: Env) {
  const id = env.TICKER.idFromName("global");
  const stub = env.TICKER.get(id);
  await stub.fetch("https://ticker/start", { method: "POST" });
}

export class Ticker {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async acquireScrapeLock(): Promise<boolean> {
    const now = Date.now();
    const cur = (await this.state.storage.get<number>(LOCK_KEY)) || 0;
    if (!cur || now - cur > LOCK_TTL_MS) {
      await this.state.storage.put(LOCK_KEY, now);
      return true;
    }
    return false;
  }

  private async releaseScrapeLock() {
    await this.state.storage.delete(LOCK_KEY);
  }

  private async maybePruneDeliveries() {
    const now = Math.floor(Date.now() / 1000);
    const last = (await this.state.storage.get<number>(PRUNE_KEY)) || 0;
    if (now - last < PRUNE_INTERVAL_SEC) return;

    const cutoff = now - DELIVERY_TTL_DAYS * 86400;
    try {
      await this.env.DB.prepare("DELETE FROM deliveries WHERE created_at < ?").bind(cutoff).run();
      await this.state.storage.put(PRUNE_KEY, now);
    } catch (e) {
      console.log("deliveries prune error:", String(e));
    }
  }

  private async runScrapeOnce(): Promise<{ ok: boolean; busy?: boolean; error?: string }> {
    const got = await this.acquireScrapeLock();
    if (!got) return { ok: false, busy: true };

    try {
      await ensureDbUpgrades(this.env.DB);
      await runScrapeTick(this.env, this.state.storage);
      await this.maybePruneDeliveries();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e) };
    } finally {
      await this.releaseScrapeLock();
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const cur = await this.state.storage.getAlarm();
      if (!cur) await this.state.storage.setAlarm(Date.now() + 1000);
      return new Response("started");
    }

    if (url.pathname === "/stop") {
      await this.state.storage.deleteAlarm();
      return new Response("stopped");
    }

    if (url.pathname === "/status") {
      const alarm = await this.state.storage.getAlarm();
      return new Response(JSON.stringify({ alarm }), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/run-scrape" && request.method === "POST") {
      const result = await this.runScrapeOnce();
      const status = result.ok ? 200 : result.busy ? 409 : 500;
      return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    try {
      await this.runScrapeOnce();
    } catch (e) {
      console.log("ticker alarm error:", String(e));
    } finally {
      await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }
}

/** ------------------- admin auth ------------------- */
function getAdminKey(env: Env) {
  return env.ADMIN_KEY || env.WEBHOOK_SECRET || "";
}
function checkAdmin(c: any) {
  const expected = getAdminKey(c.env);
  if (!expected) return false;
  const auth = c.req.header("Authorization") || "";
  const xkey = c.req.header("X-Admin-Key") || "";
  const qkey = c.req.query("key") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected;
  return xkey === expected || qkey === expected;
}

/** ------------------- routes ------------------- */
app.get("/", (c) => c.text("ok"));

app.post("/telegram", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (c.env.WEBHOOK_SECRET && (!secret || secret !== c.env.WEBHOOK_SECRET)) return c.text("forbidden", 403);

  c.executionCtx.waitUntil(ensureTickerStarted(c.env));

  const update = await c.req.json<TgUpdate>();
  c.executionCtx.waitUntil(processUpdate(c.env, update));
  return c.json({ ok: true });
});

app.get("/admin/stats", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  return c.html(renderAdminStatsPage(c.req.query("key") || ""));
});

app.get("/admin/stats.json", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  await ensureDbUpgrades(c.env.DB);
  const stats = await buildAdminStats(c.env);
  return c.json(stats);
});

app.post("/admin/run-scrape", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  const res = await stub.fetch("https://ticker/run-scrape", { method: "POST" });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/admin/ticker/start", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  await ensureTickerStarted(c.env);
  return c.json({ ok: true });
});

app.post("/admin/ticker/stop", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  await stub.fetch("https://ticker/stop", { method: "POST" });
  return c.json({ ok: true });
});

app.get("/admin/ticker/status", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  const id = c.env.TICKER.idFromName("global");
  const stub = c.env.TICKER.get(id);
  const res = await stub.fetch("https://ticker/status");
  return new Response(await res.text(), { headers: { "content-type": "application/json" } });
});

export default {
  fetch: app.fetch,

  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(ensureTickerStarted(env));
  },
};
