import { MediaItem, ScrapedPost } from "../types";

const TME_BASE = "https://t.me/s/";

function decodeHtmlEntities(s: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s
    .replace(/&([a-zA-Z]+);/g, (_, name) => (named[name] ?? `&${name};`))
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function stripHtml(html: string) {
  const withNewlines = html.replace(/<br\s*\/?>/gi, "\n");
  const noTags = withNewlines.replace(/<[^>]*>/g, "");
  return decodeHtmlEntities(noTags).replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUrl(u: string) {
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}

function isEmojiAssetUrl(u: string) {
  const x = (u || "").toLowerCase();
  if (!x) return false;
  return (
    x.includes("/emoji/") ||
    x.includes("telegram.org/img/emoji") ||
    x.includes("twemoji") ||
    x.includes("emoji.png") ||
    x.includes("emoji.webp") ||
    x.includes("emoji.svg")
  );
}

function extractMedia(htmlSlice: string): MediaItem[] {
  const photos: string[] = [];
  const videos: string[] = [];
  const docs: string[] = [];

  const reBg = /background-image\s*:\s*url\(['"]([^'"]+)['"]\)/gi;
  let m: RegExpExecArray | null;
  while ((m = reBg.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (!isEmojiAssetUrl(u)) photos.push(u);
  }

  const reImg = /<img[^>]+src="([^"]+)"/gi;
  while ((m = reImg.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (!isEmojiAssetUrl(u)) photos.push(u);
  }

  const reDataVideo = /data-video="([^"]+)"/gi;
  while ((m = reDataVideo.exec(htmlSlice)) !== null) videos.push(normalizeUrl(m[1]));

  const reVideoSrc = /<(?:video|source)[^>]+src="([^"]+)"/gi;
  while ((m = reVideoSrc.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (/\.mp4(\?|$)/i.test(u) || /video/i.test(u)) videos.push(u);
  }

  const reDoc = /href="(https?:\/\/cdn\d+\.telesco\.pe\/file\/[^\"]+)"/gi;
  while ((m = reDoc.exec(htmlSlice)) !== null) {
    const u = normalizeUrl(m[1]);
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u)) continue;
    if (/\.mp4(\?|$)/i.test(u)) continue;
    docs.push(u);
  }

  const uniq = (arr: string[]) => {
    const s = new Set<string>();
    for (const x of arr) if (x) s.add(x);
    return [...s];
  };

  const out: MediaItem[] = [];
  for (const u of uniq(photos)) out.push({ kind: "photo", url: u });
  for (const u of uniq(videos)) out.push({ kind: "video", url: u });
  for (const u of uniq(docs)) out.push({ kind: "document", url: u });

  return out.slice(0, 10);
}

export async function fetchTme(username: string): Promise<string> {
  const url = `${TME_BASE}${username}`;
  const req = new Request(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });

  const cache = caches.default;
  const cached = await cache.match(req);
  if (cached) return await cached.text();

  const res = await fetch(req, { cf: { cacheTtl: 15, cacheEverything: true } as any });
  if (!res.ok) throw new Error(`t.me fetch failed ${res.status} for ${username}`);

  const clone = res.clone();
  await cache.put(req, clone);
  return await res.text();
}

export function scrapeTmePreview(username: string, html: string): ScrapedPost[] {
  const wanted = username.toLowerCase();
  const posts: ScrapedPost[] = [];

  const re = /data-post="([^"\/]+)\/(\d+)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const chan = m[1].toLowerCase();
    if (chan !== wanted) continue;

    const postId = Number(m[2]);
    if (!Number.isFinite(postId)) continue;

    const start = m.index;
    const slice = html.slice(start, start + 80000);

    const textMatch =
      /<div class="tgme_widget_message_text[^"]*">([\s\S]*?)<\/div>/.exec(slice) ||
      /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(slice);

    const raw = textMatch ? textMatch[1] : "";
    const text = raw ? stripHtml(raw) : "";

    const media = extractMedia(slice);

    posts.push({ postId, text, media, link: `https://t.me/${username}/${postId}` });
  }

  const uniq = new Map<number, ScrapedPost>();
  for (const p of posts) uniq.set(p.postId, p);
  return [...uniq.values()].sort((a, b) => a.postId - b.postId);
}
