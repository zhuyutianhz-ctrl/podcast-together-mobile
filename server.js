const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function now() {
  return Date.now();
}

function roomId(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 32);
  return cleaned || crypto.randomBytes(6).toString("hex").toUpperCase();
}

function currentPlayback(state) {
  if (!state) return { position: 0, isPlaying: false, updatedAt: now() };
  const elapsed = state.isPlaying ? (now() - state.updatedAt) / 1000 : 0;
  return {
    ...state,
    position: Math.max(0, state.position + elapsed),
    updatedAt: now(),
  };
}

function getRoom(id) {
  const key = roomId(id);
  if (!rooms.has(key)) {
    rooms.set(key, {
      id: key,
      createdAt: now(),
      updatedAt: now(),
      source: null,
      queue: [],
      playback: {
        position: 0,
        isPlaying: false,
        updatedAt: now(),
        commandId: 0,
      },
      clients: new Set(),
    });
  }
  return rooms.get(key);
}

function pruneRooms() {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [id, room] of rooms) {
    if (!room.clients.size && room.updatedAt < cutoff) {
      rooms.delete(id);
    }
  }
}

function publicState(room) {
  return {
    id: room.id,
    source: room.source,
    queue: room.queue,
    playback: currentPlayback(room.playback),
    listenerCount: room.clients.size,
    updatedAt: room.updatedAt,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function broadcast(room) {
  const payload = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const client of room.clients) {
    client.write(payload);
  }
}

function getTextBetween(text, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(re);
  return match ? decodeXml(stripCdata(match[1]).trim()) : "";
}

function getAttr(text, attr) {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i");
  const match = text.match(re);
  return match ? decodeXml(match[1].trim()) : "";
}

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function looksLikeDirectAudio(url) {
  return /\.(mp3|m4a|aac|ogg|oga|wav|flac)(\?.*)?$/i.test(url);
}

function cleanUrl(value) {
  try {
    const parsed = new URL(String(value).trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "PodcastTogether/0.1 (+https://localhost)",
      accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
    },
  });
  if (!response.ok) {
    throw new Error(`Source returned HTTP ${response.status}.`);
  }
  return {
    text: await response.text(),
    type: response.headers.get("content-type") || "",
    finalUrl: response.url,
  };
}

function parseRss(xml, feedUrl) {
  const channelMatch = xml.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;
  const showTitle = getTextBetween(channel, "title") || "播客";
  const itemMatches = [...channel.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];

  const episodes = itemMatches
    .map((match, index) => {
      const item = match[1];
      const enclosure = item.match(/<enclosure\b[^>]*>/i)?.[0] || "";
      const audioUrl = getAttr(enclosure, "url");
      const type = getAttr(enclosure, "type");
      if (!audioUrl) return null;
      return {
        id: crypto.createHash("sha1").update(audioUrl).digest("hex").slice(0, 12),
        title: getTextBetween(item, "title") || `第 ${index + 1} 集`,
        showTitle,
        audioUrl,
        pageUrl: getTextBetween(item, "link") || feedUrl,
        publishedAt: getTextBetween(item, "pubDate"),
        duration: getTextBetween(item, "itunes:duration"),
        type,
      };
    })
    .filter(Boolean)
    .slice(0, 50);

  return {
    kind: "rss",
    title: showTitle,
    url: feedUrl,
    episodes,
  };
}

function discoverAudioFromHtml(html, pageUrl) {
  const metaAudio =
    html.match(/<meta\b[^>]*(?:property|name)=["']og:audio(?::url)?["'][^>]*>/i)?.[0] ||
    html.match(/<meta\b[^>]*content=["'][^"']+\.(?:mp3|m4a|aac|ogg|wav)[^"']*["'][^>]*>/i)?.[0] ||
    "";
  const audioUrl =
    getAttr(metaAudio, "content") ||
    getAttr(html.match(/<audio\b[^>]*src=["'][^"']+["'][^>]*>/i)?.[0] || "", "src") ||
    "";

  if (!audioUrl) return null;
  const absolute = new URL(audioUrl, pageUrl).toString();
  const documentTitle = getTextBetween(html, "title");
  const title =
    getAttr(html.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*>/i)?.[0] || "", "content") ||
    documentTitle ||
    "播客单集";
  const showTitle = deriveShowTitle(documentTitle, title);

  return {
    kind: "audio",
    title,
    url: absolute,
    episodes: [
      {
        id: crypto.createHash("sha1").update(absolute).digest("hex").slice(0, 12),
        title,
        showTitle,
        audioUrl: absolute,
        pageUrl,
      },
    ],
  };
}

function deriveShowTitle(documentTitle, episodeTitle) {
  const title = String(documentTitle || "");
  const episode = String(episodeTitle || "");
  const withoutBrand = title.split("|")[0] || title;
  const candidates = withoutBrand
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (candidates.length >= 2) {
    const possibleShow = candidates[candidates.length - 1];
    if (possibleShow && possibleShow !== episode) return possibleShow;
  }
  return "网页音频";
}

async function resolveSource(rawUrl) {
  const url = cleanUrl(rawUrl);
  if (!url) {
    const error = new Error("请提供有效的 http 或 https 链接。");
    error.statusCode = 400;
    throw error;
  }

  if (looksLikeDirectAudio(url)) {
    return {
      kind: "audio",
      title: "播客音频",
      url,
      episodes: [
        {
          id: crypto.createHash("sha1").update(url).digest("hex").slice(0, 12),
          title: "播客音频",
          showTitle: "直接音频链接",
          audioUrl: url,
          pageUrl: url,
        },
      ],
    };
  }

  const { text, type, finalUrl } = await fetchText(url);
  if (/rss|xml|atom/i.test(type) || /<rss[\s>]|<feed[\s>]/i.test(text)) {
    const parsed = parseRss(text, finalUrl);
    if (!parsed.episodes.length) {
      const error = new Error("这个 RSS 里没有找到可播放的音频 enclosure。");
      error.statusCode = 422;
      throw error;
    }
    return parsed;
  }

  const discovered = discoverAudioFromHtml(text, finalUrl);
  if (discovered) return discovered;

  const error = new Error("暂时无法从这个页面解析出音频。请改用播客 RSS 链接或直接音频链接。");
  error.statusCode = 422;
  throw error;
}

function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/new-room") {
    sendJson(res, 200, { room: roomId() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resolve") {
    try {
      sendJson(res, 200, await resolveSource(url.searchParams.get("url")));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
    const room = getRoom(parts[2]);

    if (req.method === "GET" && parts.length === 3) {
      sendJson(res, 200, publicState(room));
      return;
    }

    if (req.method === "POST" && parts[3] === "source") {
      try {
        const body = await parseBody(req);
        const episode = body.episode;
        if (!episode?.audioUrl) {
          sendJson(res, 400, { error: "请选择一个包含音频链接的单集。" });
          return;
        }
        room.source = {
          id: episode.id || crypto.createHash("sha1").update(episode.audioUrl).digest("hex").slice(0, 12),
          title: episode.title || "播客音频",
          showTitle: episode.showTitle || "",
          audioUrl: episode.audioUrl,
          pageUrl: episode.pageUrl || episode.audioUrl,
        };
        room.queue = Array.isArray(body.queue) ? body.queue.slice(0, 50) : [];
        room.playback = {
          position: 0,
          isPlaying: false,
          updatedAt: now(),
          commandId: room.playback.commandId + 1,
        };
        room.updatedAt = now();
        broadcast(room);
        sendJson(res, 200, publicState(room));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === "POST" && parts[3] === "control") {
      try {
        const body = await parseBody(req);
        const current = currentPlayback(room.playback);
        const position = Number.isFinite(Number(body.position))
          ? Math.max(0, Number(body.position))
          : current.position;
        const action = String(body.action || "");
        if (!["play", "pause", "seek", "sync"].includes(action)) {
          sendJson(res, 400, { error: "未知的播放指令。" });
          return;
        }
        room.playback = {
          position,
          isPlaying: action === "play" ? true : action === "pause" ? false : current.isPlaying,
          updatedAt: now(),
          commandId: current.commandId + 1,
        };
        room.updatedAt = now();
        broadcast(room);
        sendJson(res, 200, publicState(room));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

function handleEvents(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = getRoom(url.searchParams.get("room"));

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  room.clients.add(res);
  res.write(`data: ${JSON.stringify(publicState(room))}\n\n`);
  broadcast(room);

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.clients.delete(res);
    broadcast(room);
  });
}

const server = http.createServer((req, res) => {
  pruneRooms();

  if (req.url.startsWith("/events")) {
    handleEvents(req, res);
    return;
  }

  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message });
    });
    return;
  }

  handleStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Podcast Together is running at http://${HOST}:${PORT}`);
});
