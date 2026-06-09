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

function toGeoUrl(lat: number, lon: number) {
  return `geo:${lat},${lon}`;
}

function parseLocationCoords(u: string): { lat: number; lon: number } | null {
  const s = String(u || "").trim();
  if (!s) return null;

  const parseNum = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const safeDecode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };

  const geo = /^geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(s);
  if (geo) {
    const lat = parseNum(geo[1]);
    const lon = parseNum(geo[2]);
    if (lat !== null && lon !== null) return { lat, lon };
  }

  const tryUrl = (() => {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  })();

  if (tryUrl) {
    const keysLat = ["lat", "latitude"];
    const keysLon = ["lon", "lng", "longitude"];
    let lat: number | null = null;
    let lon: number | null = null;
    for (const k of keysLat) {
      const v = tryUrl.searchParams.get(k);
      if (v != null) {
        lat = parseNum(v);
        if (lat !== null) break;
      }
    }
    for (const k of keysLon) {
      const v = tryUrl.searchParams.get(k);
      if (v != null) {
        lon = parseNum(v);
        if (lon !== null) break;
      }
    }
    if (lat !== null && lon !== null) return { lat, lon };

    const q = tryUrl.searchParams.get("q") || tryUrl.searchParams.get("query") || "";
    const qm = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(safeDecode(q));
    if (qm) {
      lat = parseNum(qm[1]);
      lon = parseNum(qm[2]);
      if (lat !== null && lon !== null) return { lat, lon };
    }

    const ll = tryUrl.searchParams.get("ll") || "";
    const llm = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(safeDecode(ll));
    if (llm) {
      // Some map providers use ll=lon,lat.
      lon = parseNum(llm[1]);
      lat = parseNum(llm[2]);
      if (lat !== null && lon !== null) return { lat, lon };
    }

    const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(tryUrl.pathname + tryUrl.hash);
    if (at) {
      lat = parseNum(at[1]);
      lon = parseNum(at[2]);
      if (lat !== null && lon !== null) return { lat, lon };
    }
  }

  const rawPair =
    /(geo:|map|maps|location|venue|lat|lon|lng|ll=|q=)/i.test(s) ? /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(s) : null;
  if (rawPair) {
    const lat = parseNum(rawPair[1]);
    const lon = parseNum(rawPair[2]);
    if (lat !== null && lon !== null) return { lat, lon };
  }

  return null;
}

function inferMediaKindFromUrl(u: string): MediaItem["kind"] | null {
  const clean = String(u || "")
    .split("#")[0]
    .split("?")[0]
    .toLowerCase();
  if (!clean) return null;
  if (clean.startsWith("geo:")) return "location";
  if (clean.includes("maps.google.") || clean.includes("openstreetmap.org") || clean.includes("maps.apple.com")) return "location";
  if (clean.includes("/sticker/") || clean.includes("sticker")) return "sticker";
  if (/\.(jpg|jpeg|png|webp)$/i.test(clean)) return "photo";
  if (/\.(tgs)$/i.test(clean)) return "sticker";
  if (/\.gif$/i.test(clean)) return "animation";
  if (/\.(mp3|m4a|aac|flac|wav)$/i.test(clean)) return "audio";
  if (/\.(ogg|oga|opus)$/i.test(clean)) return "voice";
  if (/\.(mp4|webm|mov|mkv)$/i.test(clean)) return "video";
  if (/\.(pdf|txt|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx)$/i.test(clean)) return "document";
  return null;
}

function looksLikeMediaUrl(u: string) {
  const x = String(u || "").toLowerCase();
  if (x.startsWith("geo:")) return true;
  if (!/^https?:\/\//i.test(x)) return false;
  if (x.includes("/file/")) return true;
  if (x.includes("/video/") || x.includes("/audio/")) return true;
  if (x.includes("maps.google.") || x.includes("openstreetmap.org") || x.includes("maps.apple.com")) return true;
  if (/\.(jpg|jpeg|png|webp|tgs|gif|mp3|m4a|aac|flac|wav|ogg|oga|opus|mp4|webm|mov|mkv|pdf|txt|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx)(?:\?|#|$)/i.test(x))
    return true;
  return false;
}

function extractMedia(htmlSlice: string, messageLink: string): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();

  const push = (kind: MediaItem["kind"], rawUrl: string) => {
    const u = normalizeUrl(rawUrl);
    if (!u) return;
    const isGeo = /^geo:/i.test(u);
    if (!isGeo && !/^https?:\/\//i.test(u)) return;
    if (!isGeo && isEmojiAssetUrl(u)) return;
    const key = `${kind}|${u}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, url: u });
  };

  const pushByUrl = (rawUrl: string, fallback: MediaItem["kind"] = "document") => {
    const u = normalizeUrl(rawUrl);
    if (!u) return;
    const inferred = inferMediaKindFromUrl(u);
    const wantedKind = inferred || fallback;
    if (String(wantedKind).toLowerCase() === "location") {
      const coords = parseLocationCoords(u);
      if (!coords) return;
      push("location", toGeoUrl(coords.lat, coords.lon));
      return;
    }
    if (!inferred && fallback === "document" && !looksLikeMediaUrl(u)) return;
    push(wantedKind, u);
  };

  // Only capture backgrounds from message media blocks (not avatars/userpics).
  const rePhotoWrapBg =
    /<[^>]*class="[^"]*tgme_widget_message_(?:photo_wrap|video_thumb|grouped)[^"]*"[^>]*style="[^"]*background-image\s*:\s*url\(['"]([^'"]+)['"]\)[^"]*"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rePhotoWrapBg.exec(htmlSlice)) !== null) {
    push("photo", m[1]);
  }

  const reStickerWrapBg =
    /<[^>]*class="[^"]*tgme_widget_message_sticker[^"]*"[^>]*style="[^"]*background-image\s*:\s*url\(['"]([^'"]+)['"]\)[^"]*"[^>]*>/gi;
  while ((m = reStickerWrapBg.exec(htmlSlice)) !== null) {
    pushByUrl(m[1], "sticker");
  }

  // Keep <img> capture limited to message text/media containers.
  const reImg =
    /<img[^>]+class="[^"]*tgme_widget_message_[^"]*"[^>]+src="([^"]+)"/gi;
  while ((m = reImg.exec(htmlSlice)) !== null) {
    push("photo", m[1]);
  }

  const reDataVideo = /data-video="([^"]+)"/gi;
  while ((m = reDataVideo.exec(htmlSlice)) !== null) push("video", m[1]);

  const reVideoSrc = /<(?:video|source)[^>]+src="([^"]+)"/gi;
  while ((m = reVideoSrc.exec(htmlSlice)) !== null) pushByUrl(m[1], "video");

  const reAudioSrc = /<audio[^>]+src="([^"]+)"/gi;
  while ((m = reAudioSrc.exec(htmlSlice)) !== null) pushByUrl(m[1], "audio");

  const reDataAudio = /data-audio="([^"]+)"/gi;
  while ((m = reDataAudio.exec(htmlSlice)) !== null) pushByUrl(m[1], "audio");

  const reDataVoice = /data-voice="([^"]+)"/gi;
  while ((m = reDataVoice.exec(htmlSlice)) !== null) pushByUrl(m[1], "voice");

  const reDataAnimation = /data-animation="([^"]+)"/gi;
  while ((m = reDataAnimation.exec(htmlSlice)) !== null) pushByUrl(m[1], "animation");

  const reDataSticker = /data-sticker="([^"]+)"/gi;
  while ((m = reDataSticker.exec(htmlSlice)) !== null) pushByUrl(m[1], "sticker");

  const reDataDocument = /data-document="([^"]+)"/gi;
  while ((m = reDataDocument.exec(htmlSlice)) !== null) pushByUrl(m[1], "document");

  const reDataFile = /data-file="([^"]+)"/gi;
  while ((m = reDataFile.exec(htmlSlice)) !== null) pushByUrl(m[1], "document");

  const reDataLatLonA = /data-(?:lat|latitude)="(-?\d+(?:\.\d+)?)"[^>]*data-(?:lon|lng|longitude)="(-?\d+(?:\.\d+)?)"/gi;
  while ((m = reDataLatLonA.exec(htmlSlice)) !== null) push("location", toGeoUrl(Number(m[1]), Number(m[2])));

  const reDataLatLonB = /data-(?:lon|lng|longitude)="(-?\d+(?:\.\d+)?)"[^>]*data-(?:lat|latitude)="(-?\d+(?:\.\d+)?)"/gi;
  while ((m = reDataLatLonB.exec(htmlSlice)) !== null) push("location", toGeoUrl(Number(m[2]), Number(m[1])));

  // File links can point to documents, audio, voice notes, or gifs.
  const reFileHref = /href="(https?:\/\/[^"]+\/file\/[^"]+)"/gi;
  while ((m = reFileHref.exec(htmlSlice)) !== null) pushByUrl(m[1], "document");

  const reMediaHref = /href="(https?:\/\/[^"]+\.(?:gif|mp3|m4a|aac|flac|wav|ogg|oga|opus|mp4|webm|mov)(?:\?[^"]*)?)"/gi;
  while ((m = reMediaHref.exec(htmlSlice)) !== null) pushByUrl(m[1], "document");

  const reAnyHref = /href="([^"]+)"/gi;
  while ((m = reAnyHref.exec(htmlSlice)) !== null) {
    const href = normalizeUrl(m[1]);
    if (!href) continue;
    if (parseLocationCoords(href)) {
      pushByUrl(href, "location");
      continue;
    }
    if (looksLikeMediaUrl(href)) pushByUrl(href, "document");
  }

  // Hint that this post has non-text/native payload even if direct media URLs were not extractable.
  const hasNativeOnlyWidget =
    /tgme_widget_message_(?:sticker|audio|voice|music|audio_player|location|live_location|roundvideo|contact|poll|game|invoice|venue|document|file)/i.test(htmlSlice);
  if (hasNativeOnlyWidget && !out.some((it) => it.kind === "source_copy")) {
    push("source_copy", messageLink);
  }

  return out;
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
  const markers: { index: number; chan: string; postId: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const chan = m[1].toLowerCase();
    const postId = Number(m[2]);
    if (!Number.isFinite(postId)) continue;
    markers.push({ index: m.index, chan, postId });
  }

  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    if (cur.chan !== wanted) continue;

    const start = cur.index;
    const nextStart = i + 1 < markers.length ? markers[i + 1].index : html.length;
    const slice = html.slice(start, nextStart);

    const textMatch =
      /<div class="tgme_widget_message_text[^"]*">([\s\S]*?)<\/div>/.exec(slice) ||
      /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(slice);

    const raw = textMatch ? textMatch[1] : "";
    const text = raw ? stripHtml(raw) : "";

    const link = `https://t.me/${username}/${cur.postId}`;
    const media = extractMedia(slice, link);

    posts.push({ postId: cur.postId, text, media, link });
  }

  const score = (p: ScrapedPost) => {
    const textScore = (p.text || "").trim().length;
    const mediaScore = (p.media?.length || 0) * 1000;
    return mediaScore + textScore;
  };

  const uniq = new Map<number, ScrapedPost>();
  for (const p of posts) {
    const prev = uniq.get(p.postId);
    if (!prev || score(p) > score(prev)) uniq.set(p.postId, p);
  }
  return [...uniq.values()].sort((a, b) => a.postId - b.postId);
}
