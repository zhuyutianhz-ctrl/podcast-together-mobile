const params = new URLSearchParams(window.location.search);
let room = params.get("room") || "";
let state = null;
let sourceUrl = "";
let ready = false;
let seeking = false;
let suppressNext = false;
let lastCommandId = -1;

const els = {
  roomTitle: document.querySelector("#roomTitle"),
  connectionState: document.querySelector("#connectionState"),
  listenerCount: document.querySelector("#listenerCount"),
  shareButton: document.querySelector("#shareButton"),
  sourceForm: document.querySelector("#sourceForm"),
  sourceInput: document.querySelector("#sourceInput"),
  episodePicker: document.querySelector("#episodePicker"),
  feedTitle: document.querySelector("#feedTitle"),
  episodeList: document.querySelector("#episodeList"),
  closePicker: document.querySelector("#closePicker"),
  showTitle: document.querySelector("#showTitle"),
  episodeTitle: document.querySelector("#episodeTitle"),
  audio: document.querySelector("#audio"),
  seekBar: document.querySelector("#seekBar"),
  currentTime: document.querySelector("#currentTime"),
  duration: document.querySelector("#duration"),
  backButton: document.querySelector("#backButton"),
  forwardButton: document.querySelector("#forwardButton"),
  playButton: document.querySelector("#playButton"),
  readyButton: document.querySelector("#readyButton"),
  syncButton: document.querySelector("#syncButton"),
  toast: document.querySelector("#toast"),
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("visible"), 2800);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = String(rounded % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function playbackPosition(playback) {
  if (!playback) return 0;
  const elapsed = playback.isPlaying ? (Date.now() - playback.updatedAt) / 1000 : 0;
  return Math.max(0, playback.position + elapsed);
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function ensureRoom() {
  if (!room) {
    const payload = await jsonFetch("/api/new-room");
    room = payload.room;
    params.set("room", room);
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
  }
  els.roomTitle.textContent = `房间 ${room}`;
}

function roomLink() {
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room)}`;
}

function connectEvents() {
  const events = new EventSource(`/events?room=${encodeURIComponent(room)}`);
  events.onopen = () => {
    els.connectionState.textContent = "已连接";
  };
  events.onerror = () => {
    els.connectionState.textContent = "正在重连";
  };
  events.onmessage = (event) => {
    applyState(JSON.parse(event.data));
  };
}

function applyState(nextState) {
  state = nextState;
  els.listenerCount.textContent = `${state.listenerCount || 0} 人在线`;

  if (state.source) {
    els.showTitle.textContent = state.source.showTitle || "播客";
    els.episodeTitle.textContent = state.source.title || "未命名单集";
    if (sourceUrl !== state.source.audioUrl) {
      sourceUrl = state.source.audioUrl;
      els.audio.src = sourceUrl;
      els.audio.load();
    }
  }

  const commandChanged = state.playback.commandId !== lastCommandId;
  lastCommandId = state.playback.commandId;
  const target = playbackPosition(state.playback);
  const diff = Math.abs((els.audio.currentTime || 0) - target);

  if (!seeking && sourceUrl && (commandChanged || diff > 1.2)) {
    try {
      els.audio.currentTime = target;
    } catch {
      // Some streams cannot seek until metadata is ready.
    }
  }

  if (state.playback.isPlaying) {
    els.playButton.textContent = "暂停";
    if (ready && els.audio.paused && sourceUrl) {
      suppressNext = true;
      els.audio.play().catch(() => {
        toast("手机浏览器需要先点一次“准备收听”。");
      });
    }
  } else {
    els.playButton.textContent = "播放";
    if (!els.audio.paused) {
      suppressNext = true;
      els.audio.pause();
    }
  }
}

async function sendControl(action, position = els.audio.currentTime || 0) {
  if (!sourceUrl) {
    toast("请先选择一集播客。");
    return;
  }
  await jsonFetch(`/api/rooms/${encodeURIComponent(room)}/control`, {
    method: "POST",
    body: JSON.stringify({ action, position }),
  });
}

function renderEpisodes(resolved) {
  els.feedTitle.textContent = resolved.kind === "rss" ? resolved.title : "选择音频";
  els.episodeList.innerHTML = "";

  for (const episode of resolved.episodes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "episode-item";
    item.innerHTML = `
      <strong>${escapeHtml(episode.title)}</strong>
      <span>${escapeHtml([episode.showTitle, episode.publishedAt].filter(Boolean).join(" · "))}</span>
    `;
    item.addEventListener("click", async () => {
      await jsonFetch(`/api/rooms/${encodeURIComponent(room)}/source`, {
        method: "POST",
        body: JSON.stringify({ episode, queue: resolved.episodes }),
      });
      els.episodePicker.hidden = true;
      toast("已载入这集播客。");
    });
    els.episodeList.append(item);
  }

  els.episodePicker.hidden = false;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

els.sourceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = els.sourceInput.value.trim();
  if (!url) return;
  const button = els.sourceForm.querySelector("button");
  button.disabled = true;
  button.textContent = "解析中";
  try {
    const resolved = await jsonFetch(`/api/resolve?url=${encodeURIComponent(url)}`);
    renderEpisodes(resolved);
    if (resolved.episodes.length === 1) {
      await jsonFetch(`/api/rooms/${encodeURIComponent(room)}/source`, {
        method: "POST",
        body: JSON.stringify({ episode: resolved.episodes[0], queue: resolved.episodes }),
      });
      els.episodePicker.hidden = true;
      toast("已载入音频。");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "解析";
  }
});

els.closePicker.addEventListener("click", () => {
  els.episodePicker.hidden = true;
});

els.shareButton.addEventListener("click", async () => {
  const link = roomLink();
  if (navigator.share) {
    await navigator.share({ title: "一起听播客", url: link }).catch(() => {});
    return;
  }
  await navigator.clipboard.writeText(link);
  toast("房间链接已复制。");
});

els.readyButton.addEventListener("click", async () => {
  ready = true;
  els.readyButton.textContent = "已准备";
  if (state?.playback?.isPlaying && sourceUrl) {
    await els.audio.play().catch(() => toast("请再点一次播放按钮来授权声音。"));
  } else {
    toast("已准备，可以同步播放。");
  }
});

els.playButton.addEventListener("click", async () => {
  ready = true;
  els.readyButton.textContent = "已准备";
  if (state?.playback?.isPlaying) {
    await sendControl("pause");
  } else {
    await sendControl("play");
  }
});

els.backButton.addEventListener("click", async () => {
  await sendControl("seek", Math.max(0, (els.audio.currentTime || 0) - 15));
});

els.forwardButton.addEventListener("click", async () => {
  await sendControl("seek", (els.audio.currentTime || 0) + 30);
});

els.syncButton.addEventListener("click", async () => {
  if (!state?.playback) return;
  const target = playbackPosition(state.playback);
  els.audio.currentTime = target;
  toast("已校准到房间进度。");
});

els.seekBar.addEventListener("input", () => {
  seeking = true;
  els.currentTime.textContent = formatTime(Number(els.seekBar.value));
});

els.seekBar.addEventListener("change", async () => {
  seeking = false;
  const position = Number(els.seekBar.value);
  els.audio.currentTime = position;
  await sendControl("seek", position);
});

els.audio.addEventListener("play", () => {
  if (suppressNext) {
    suppressNext = false;
    return;
  }
  sendControl("play").catch((error) => toast(error.message));
});

els.audio.addEventListener("pause", () => {
  if (suppressNext) {
    suppressNext = false;
    return;
  }
  if (!els.audio.ended) sendControl("pause").catch((error) => toast(error.message));
});

els.audio.addEventListener("loadedmetadata", () => {
  if (Number.isFinite(els.audio.duration)) {
    els.seekBar.max = String(els.audio.duration);
    els.duration.textContent = formatTime(els.audio.duration);
  }
});

els.audio.addEventListener("timeupdate", () => {
  if (!seeking) {
    els.seekBar.value = String(els.audio.currentTime || 0);
    els.currentTime.textContent = formatTime(els.audio.currentTime || 0);
  }
});

els.audio.addEventListener("durationchange", () => {
  if (Number.isFinite(els.audio.duration)) {
    els.seekBar.max = String(els.audio.duration);
    els.duration.textContent = formatTime(els.audio.duration);
  }
});

ensureRoom()
  .then(connectEvents)
  .catch((error) => {
    els.connectionState.textContent = "连接失败";
    toast(error.message);
  });
