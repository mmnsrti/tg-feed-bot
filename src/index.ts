/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { Env, TgUpdate } from "./types";
import { ensureDbUpgrades } from "./db/schema";
import { handleCallback, handleChannelPost, handlePrivateMessage } from "./telegram/handlers";
import { runScrapeTickLocked } from "./ticker/do";

const app = new Hono<{ Bindings: Env }>();

const TICK_MS = 5000;

async function processUpdate(env: Env, update: TgUpdate) {
  await ensureDbUpgrades(env.DB);

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

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    try {
      await ensureDbUpgrades(this.env.DB);
      await runScrapeTickLocked(this.env);
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
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected;
  return xkey === expected;
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

app.post("/admin/run-scrape", async (c) => {
  if (!checkAdmin(c)) return c.text("forbidden", 403);
  await ensureDbUpgrades(c.env.DB);
  await runScrapeTickLocked(c.env);
  return c.json({ ok: true });
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
