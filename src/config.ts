import { Env } from "./types";

export function shouldStoreScrapedPosts(env: Env): boolean {
  const raw = String(env.STORE_SCRAPED_POSTS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
