const BOT_TOKEN = process.env.BOT_TOKEN!;
const LOCAL_ENDPOINT = process.env.LOCAL_ENDPOINT || "http://127.0.0.1:8787/telegram";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

async function tg(method: string, params: Record<string, any>) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // polling mode
  await tg("deleteWebhook", { drop_pending_updates: true });

  let offset = 0;
  while (true) {
    const updates = await tg("getUpdates", { timeout: 30, offset });
    for (const u of updates) {
      offset = Math.max(offset, (u.update_id ?? 0) + 1);

      await fetch(LOCAL_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(WEBHOOK_SECRET ? { "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify(u),
      });
    }
    await sleep(200);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
