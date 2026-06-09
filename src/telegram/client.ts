import { Env } from "../types";

export class TelegramError extends Error {
  code: number;
  description: string;
  parameters?: any;

  constructor(code: number, description: string, parameters?: any) {
    super(`TelegramError ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export async function tg(env: Env, method: string, params: Record<string, any>, tries = 3): Promise<any> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await res.json();

  if (data.ok) return data.result;

  const retryAfter = data?.parameters?.retry_after;
  if (data.error_code === 429 && retryAfter && tries > 0) {
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + 250));
    return tg(env, method, params, tries - 1);
  }

  throw new TelegramError(Number(data.error_code || 0), String(data.description || "Unknown error"), data.parameters);
}
