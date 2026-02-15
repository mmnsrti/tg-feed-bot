// scripts/schedule.ts
const endpoint = process.env.SCHEDULE_ENDPOINT || "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*";
const intervalMs = Number(process.env.SCHEDULE_INTERVAL_MS || 1000); // 2 minutes

let inFlight = false;

async function tick() {
  if (inFlight) return; // prevent overlap
  inFlight = true;
  try {
    const res = await fetch(endpoint, { method: "GET" });
    const text = await res.text();
    console.log(new Date().toISOString(), "tick", res.status, text.trim());
  } catch (e) {
    console.error(new Date().toISOString(), "tick error", e);
  } finally {
    inFlight = false;
  }
}

console.log("Auto scheduler started:", endpoint, "every", intervalMs, "ms");
tick();
setInterval(tick, intervalMs);
