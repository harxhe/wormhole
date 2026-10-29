// Wormhole dashboard. Vanilla JS, no build step.
// Talks to the local API and receives live changes over /ws.

const STORAGE_KEY = "wormhole.dashboard.settings.v1";

const ADJECTIVES = [
  "swift", "brave", "calm", "bold", "lucky", "quiet", "witty", "vivid",
  "sunny", "cosmic", "rapid", "clever", "gentle", "noble", "frosty", "amber",
  "zesty", "mellow"
];

const NOUNS = [
  "fox", "otter", "panda", "lynx", "hawk", "willow", "river", "comet",
  "ember", "cedar", "maple", "falcon", "badger", "heron", "raven", "pebble",
  "aurora", "quartz"
];

const $ = (id) => document.getElementById(id);

const state = {
  tunnels: new Map(),
  selectedTunnelId: null,
  requests: new Map(),
  selectedRequestId: null,
  filter: "",
  paused: false,
  formType: "http",
  config: null,
  settings: null,
  ws: null,
  wsRetry: null,
  toastTimer: null
};

/* ------------------------------------------------------------------ utilities */

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // A body is not guaranteed on every response.
  }
  if (!response.ok) {
    throw new Error(body && body.error ? body.error : `Request failed (${response.status})`);
  }
  return body;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return "…";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUptime(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function toast(message, type = "success") {
  const node = $("toast");
  $("toast-text").textContent = message;
  node.classList.toggle("is-error", type === "error");
  const use = $("toast-icon").querySelector("use");
  if (use) use.setAttribute("href", type === "error" ? "#i-alert" : "#i-check");
  node.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove("show"), 3600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    const helper = el("textarea", "clipboard-helper");
    helper.value = text;
    helper.setAttribute("readonly", "");
    document.body.append(helper);
    helper.select();
    try {
      document.execCommand("copy");
      toast("Copied to clipboard");
    } catch {
      toast("Could not copy — select the URL manually", "error");
    } finally {
      helper.remove();
    }
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    // Private browsing can reject localStorage; the dashboard still works.
  }
}

/* ------------------------------------------------------------------ form */

function setFormType(type) {
  state.formType = type === "tcp" ? "tcp" : "http";
  for (const button of $("type-segmented").querySelectorAll("button")) {
    const active = button.dataset.type === state.formType;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  $("port").placeholder = state.formType === "tcp" ? "5432" : "3000";
  updatePreview();
  updateCommandPreview();
}

function currentCommand() {
  const port = $("port").value.trim();
  const name = $("subdomain").value.trim().toLowerCase();
  return `wormhole ${state.formType}${port ? ` ${port}` : ""}${name ? ` --subdomain ${name}` : ""}`;
}

function updateCommandPreview() {
  $("command-text").textContent = currentCommand();
}

function validatePort() {
  const value = Number($("port").value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return null;
  }
  return value;
}

function showPortError(message) {
  const field = $("port").closest(".field");
  field.classList.toggle("has-error", Boolean(message));
  const error = $("port-error");
  error.hidden = !message;
  error.textContent = message || "";
}

function updatePreview() {
  const hint = $("url-preview");
  hint.replaceChildren();

  if (state.formType === "tcp") {
    hint.textContent = "A public TCP port is assigned when the tunnel starts.";
    return;
  }

  const name = $("subdomain").value.trim().toLowerCase() || "random";
  const base = state.settings && state.settings.publicBase ? state.settings.publicBase : "http://localhost:8080";

  try {
    const url = new URL(base);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) throw new Error("ip");
    url.hostname = `${name}.${url.hostname}`;
    const preview = el("span", "preview-url", url.toString().replace(/\/$/, ""));
    hint.append("Public URL: ", preview);
    if (name === "random") hint.append(" (random name assigned on start)");
  } catch {
    hint.textContent = "The public URL is assigned when the tunnel starts.";
  }
}

function randomName() {
  const pick = (items) => items[Math.floor(Math.random() * items.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

function setStarting(loading) {
  const button = $("start-btn");
  button.disabled = loading;
  button.classList.toggle("is-loading", loading);
  button.querySelector(".start-label").textContent = loading ? "Starting…" : "Start tunnel";
}

/* ------------------------------------------------------------------ tunnel cards */

function tunnelName(tunnel) {
  return tunnel.subdomain || (tunnel.type === "tcp" ? "tcp tunnel" : "tunnel");
}

function cardStatusClass(tunnel) {
  return tunnel.state === "starting" ? "starting" : tunnel.state;
}

function stateLabel(state) {
  if (state === "starting") return "connecting";
  if (state === "reconnecting") return "retrying";
  return state;
}

function createTunnelCard(tunnel) {
  const card = el("article", "tunnel-card");
  card.dataset.tunnelId = tunnel.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-pressed", String(state.selectedTunnelId === tunnel.id));
  card.setAttribute("aria-label", `Open ${tunnelName(tunnel)} tunnel, ${stateLabel(tunnel.state)}`);
  if (state.selectedTunnelId === tunnel.id) card.classList.add("selected");

  const top = el("div", "card-top");
  const nameWrap = el("div", "card-name");
  nameWrap.append(el("span", `status-dot ${cardStatusClass(tunnel)}`), el("span", "name", tunnelName(tunnel)));
  nameWrap.append(el("span", "type-chip", tunnel.type.toUpperCase()));
  nameWrap.append(el("span", `card-state ${cardStatusClass(tunnel)}`, stateLabel(tunnel.state)));
  const stop = el("button", "icon-btn");
  stop.type = "button";
  stop.title = "Stop tunnel";
  stop.setAttribute("aria-label", `Stop ${tunnelName(tunnel)} tunnel`);
  stop.append(icon("stop"));
  stop.addEventListener("click", (event) => {
    event.stopPropagation();
    void stopTunnel(tunnel.id);
  });
  top.append(nameWrap, stop);

  const urlRow = el("div", "card-url");
  const urlText = el(
    "span",
    `url${tunnel.url ? "" : " is-pending"}`,
    tunnel.url || (tunnel.state === "starting" ? "Assigning public URL…" : "No public URL yet")
  );
  urlText.title = tunnel.url || "";
  urlRow.append(urlText);

  const copy = el("button", "icon-btn");
  copy.type = "button";
  copy.title = "Copy public URL";
  copy.setAttribute("aria-label", "Copy public URL");
  copy.append(icon("copy"));
  copy.disabled = !tunnel.url;
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    if (tunnel.url) void copyText(tunnel.url);
  });
  urlRow.append(copy);

  if (tunnel.url && /^https?:/i.test(tunnel.url)) {
    const open = el("a", "icon-btn");
    open.href = tunnel.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.title = "Open public URL";
    open.setAttribute("aria-label", "Open public URL");
    open.append(icon("external"));
    open.addEventListener("click", (event) => event.stopPropagation());
    urlRow.append(open);
  }

  const meta = el("div", "card-meta");
  const uptime = el("span");
  uptime.append(icon("clock"), document.createTextNode(formatUptime(tunnel.createdAt)));
  meta.append(uptime);

  const count = el("span");
  count.dataset.role = "requests";
  count.textContent =
    tunnel.type === "tcp" ? `${tunnel.streamCount} active` : `${tunnel.requestCount} req`;
  meta.append(count);

  if (tunnel.type === "http" && tunnel.errorCount > 0) {
    const errors = el("span", "card-errors", `${tunnel.errorCount} err`);
    errors.dataset.role = "errors";
    meta.append(errors);
  }

  card.append(top, urlRow, meta);

  if (tunnel.message && (tunnel.state === "reconnecting" || tunnel.state === "offline")) {
    const message = el("div", `card-message${tunnel.state === "offline" ? " is-error" : ""}`);
    message.append(icon("alert"), document.createTextNode(tunnel.message));
    card.append(message);
  }

  card.addEventListener("click", () => selectTunnel(tunnel.id));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTunnel(tunnel.id);
    }
  });

  return card;
}

function renderTunnels() {
  const grid = $("tunnel-grid");
  const tunnels = [...state.tunnels.values()].sort((a, b) => b.createdAt - a.createdAt);
  grid.replaceChildren(...tunnels.map(createTunnelCard));
  grid.hidden = tunnels.length === 0;

  $("tunnel-title").textContent = `${tunnels.length} ${tunnels.length === 1 ? "tunnel" : "tunnels"}`;

  $("empty-state").hidden = tunnels.length > 0;
  renderRelayStatus();
  updateStatusBar();
}

function updateStatusBar() {
  const tunnels = [...state.tunnels.values()];
  const totalRequests = tunnels.reduce((sum, tunnel) => sum + (tunnel.requestCount || 0), 0);
  $("status-requests").textContent = `${totalRequests} req`;
}

function updateCardMeta(tunnelId) {
  const tunnel = state.tunnels.get(tunnelId);
  if (!tunnel) return;
  const card = [...$("tunnel-grid").children].find((node) => node.dataset.tunnelId === tunnelId);
  if (!card) return;

  const requests = state.requests.get(tunnelId);
  const count = card.querySelector('[data-role="requests"]');
  if (count) {
    count.textContent =
      tunnel.type === "tcp" ? `${tunnel.streamCount} active` : `${requests ? requests.size : tunnel.requestCount} req`;
  }

  const errors = card.querySelector('[data-role="errors"]');
  if (errors) {
    const errorCount = requests
      ? [...requests.values()].filter((request) => request.state === "error" || (request.status ?? 0) >= 500).length
      : tunnel.errorCount;
    errors.hidden = errorCount === 0;
    errors.textContent = `${errorCount} err`;
  }
}

function renderRelayStatus() {
  const tunnels = [...state.tunnels.values()];
  let status = "";
  if (tunnels.some((tunnel) => tunnel.state === "online")) status = "online";
  else if (tunnels.some((tunnel) => tunnel.state === "starting" || tunnel.state === "reconnecting")) status = "reconnecting";
  else if (tunnels.some((tunnel) => tunnel.state === "offline")) status = "offline";

  $("relay-dot").className = `status-dot ${status}`;
  $("relay-host").textContent = state.settings ? state.settings.server : "localhost:4443";
  $("relay-pill").title = status ? `Relay ${status} — open settings` : "Open relay settings";
}

/* ------------------------------------------------------------------ tunnel state */

function selectTunnel(id) {
  if (!state.tunnels.has(id)) return;
  if (state.selectedTunnelId === id) return;
  state.selectedTunnelId = id;
  state.selectedRequestId = null;
  state.filter = "";
  $("filter").value = "";
  $("detail").hidden = true;
  $("inspector-body").classList.remove("with-detail");
  renderTunnels();
  renderInspector();
  void loadRequests(id);
}

async function loadRequests(id) {
  try {
    const requests = await api(`/api/tunnels/${id}/requests`);
    state.requests.set(
      id,
      new Map(requests.map((request) => [request.id, request]))
    );
    const tunnel = state.tunnels.get(id);
    if (tunnel) {
      tunnel.requestCount = requests.length;
      tunnel.errorCount = requests.filter((request) => request.state === "error" || (request.status ?? 0) >= 500).length;
    }
    if (state.selectedTunnelId === id) {
      renderRequests();
      updateCardMeta(id);
    }
    updateStatusBar();
  } catch (err) {
    toast(err.message, "error");
  }
}

function upsertTunnel(tunnel, notify) {
  const previous = state.tunnels.get(tunnel.id);
  state.tunnels.set(tunnel.id, tunnel);

  if (!state.selectedTunnelId) selectTunnel(tunnel.id);

  if (notify && previous && previous.state !== tunnel.state) {
    if (tunnel.state === "online" && previous.state === "reconnecting") {
      toast(`Reconnected to ${tunnelName(tunnel)}`);
    } else if (tunnel.state === "offline") {
      toast(tunnel.message || `${tunnelName(tunnel)} went offline`, "error");
    }
  }

  renderTunnels();
  renderInspector();
}

function removeTunnel(id) {
  if (!state.tunnels.has(id)) return;
  state.tunnels.delete(id);
  state.requests.delete(id);

  if (state.selectedTunnelId === id) {
    state.selectedTunnelId = [...state.tunnels.keys()][0] || null;
    state.selectedRequestId = null;
    $("detail").hidden = true;
    $("inspector-body").classList.remove("with-detail");
    if (state.selectedTunnelId) void loadRequests(state.selectedTunnelId);
  }

  renderTunnels();
  renderInspector();
}

async function stopTunnel(id) {
  const tunnel = state.tunnels.get(id);
  try {
    await api(`/api/tunnels/${id}`, { method: "DELETE" });
    removeTunnel(id);
    toast(`Stopped ${tunnel ? tunnelName(tunnel) : "tunnel"}`);
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------------------ inspector */

function renderInspector() {
  const tunnel = state.selectedTunnelId ? state.tunnels.get(state.selectedTunnelId) : null;
  if (!tunnel) {
    $("inspector").hidden = true;
    return;
  }

  $("inspector").hidden = false;
  $("selected-name").textContent = tunnelName(tunnel);
  $("selected-type").textContent = tunnel.type.toUpperCase();

  const isTcp = tunnel.type === "tcp";
  $("inspector-body").hidden = isTcp;
  $("tcp-note").hidden = !isTcp;
  $("filter").closest(".search").hidden = isTcp;
  $("pause-btn").hidden = isTcp;
  $("clear-btn").hidden = isTcp;

  const pauseUse = $("pause-btn").querySelector("use");
  if (pauseUse) pauseUse.setAttribute("href", state.paused ? "#i-play" : "#i-pause");
  $("pause-btn").title = state.paused ? "Resume live updates" : "Pause live updates";
  $("pause-btn").setAttribute("aria-label", $("pause-btn").title);

  if (!isTcp) renderRequests();
}

function statusClass(request) {
  if (request.state === "error" && request.status === null) return "err";
  if (request.status === null) return "pending";
  return `s${String(request.status)[0]}`;
}

function matchesFilter(request) {
  if (!state.filter) return true;
  const text = `${request.method || ""} ${request.path || ""} ${request.status ?? ""}`.toLowerCase();
  return text.includes(state.filter);
}

function renderRequests() {
  const tunnelId = state.selectedTunnelId;
  if (!tunnelId) return;
  const tunnel = state.tunnels.get(tunnelId);
  if (!tunnel || tunnel.type !== "http") return;

  const map = state.requests.get(tunnelId) || new Map();
  const list = [...map.values()].sort((a, b) => b.id - a.id).filter(matchesFilter);
  const rows = $("rows");
  rows.replaceChildren();

  for (const request of list) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.requestId = String(request.id);
    if (request.id === state.selectedRequestId) row.classList.add("selected");

    const method = el("td", `method ${request.method || ""}`, request.method || "—");
    const path = el("td", "path", request.path || "—");
    path.title = request.path || "";
    if (request.replayOf !== null) path.append(el("span", "tag", "replay"));

    const statusText = request.status ?? (request.state === "error" ? "ERR" : "…");
    const status = el("td");
    status.append(el("span", `badge ${statusClass(request)}`, String(statusText)));

    row.append(
      method,
      path,
      status,
      el("td", "num", formatMs(request.durationMs)),
      el("td", "num", formatBytes(request.responseBytes)),
      el("td", "muted", new Date(request.startedAt).toLocaleTimeString())
    );

    row.addEventListener("click", () => selectRequest(request.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRequest(request.id);
      }
    });
    rows.append(row);
  }

  const empty = $("requests-empty");
  empty.hidden = list.length > 0;
  if (list.length === 0) {
    const hasRequests = map.size > 0;
    empty.querySelector("strong").textContent = hasRequests ? "No matching requests" : "Waiting for traffic";
    empty.querySelector("p").textContent = hasRequests
      ? "Try a different filter."
      : "Hit the public URL and requests will stream in here.";
  }

  if (state.selectedRequestId !== null && !map.has(state.selectedRequestId)) {
    state.selectedRequestId = null;
    $("detail").hidden = true;
    $("inspector-body").classList.remove("with-detail");
  }
}

function selectRequest(id) {
  state.selectedRequestId = id;
  renderRequests();
  void loadDetail(id);
}

async function loadDetail(id) {
  const tunnelId = state.selectedTunnelId;
  if (!tunnelId) return;
  try {
    const detail = await api(`/api/tunnels/${tunnelId}/requests/${id}`);
    if (state.selectedRequestId !== id || state.selectedTunnelId !== tunnelId) return;

    $("detail").hidden = false;
    $("inspector-body").classList.add("with-detail");
    $("detail-title").textContent = `${detail.method || "?"} ${detail.path || ""}`;

    const parts = [
      detail.status !== null ? `${detail.status} ${detail.statusText || ""}`.trim() : "no response",
      `total ${formatMs(detail.durationMs)}`,
      `first byte ${formatMs(detail.ttfbMs)}`,
      detail.streamId !== null ? `stream ${detail.streamId}` : `replay of #${detail.replayOf}`
    ];
    const meta = $("detail-meta");
    meta.replaceChildren();
    parts.forEach((part, index) => {
      if (index > 0) meta.append(el("span", "meta-sep"));
      meta.append(document.createTextNode(part));
    });

    const error = $("detail-error");
    error.hidden = !detail.error;
    error.textContent = detail.error || "";

    renderHeaders($("req-headers"), detail.requestHeaders);
    renderHeaders($("res-headers"), detail.responseHeaders);
    renderBody($("req-body"), $("req-size"), detail.requestBody);
    renderBody($("res-body"), $("res-size"), detail.responseBody);

    const replay = $("replay-btn");
    replay.disabled = !detail.replayable;
    replay.title = detail.replayable
      ? "Send this request to your local app again"
      : "Not replayable (incomplete or over 1 MB)";
  } catch (err) {
    toast(err.message, "error");
  }
}

function closeDetail() {
  state.selectedRequestId = null;
  $("detail").hidden = true;
  $("inspector-body").classList.remove("with-detail");
  renderRequests();
}

function renderHeaders(table, headers) {
  table.replaceChildren();
  for (const [name, value] of headers) {
    const row = document.createElement("tr");
    row.append(el("td", "", name), el("td", "", value));
    table.append(row);
  }
}

function renderBody(pre, sizeLabel, body) {
  sizeLabel.textContent = body.size ? `(${formatBytes(body.size)}${body.truncated ? ", truncated" : ""})` : "";
  if (body.size === 0) pre.textContent = "(empty)";
  else if (body.binary) pre.textContent = `[binary, ${formatBytes(body.size)}]`;
  else pre.textContent = prettyJson(body.text);
}

function prettyJson(text) {
  const trimmed = (text || "").trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text || "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text || "";
  }
}

async function replayRequest() {
  const tunnelId = state.selectedTunnelId;
  const requestId = state.selectedRequestId;
  if (!tunnelId || requestId === null) return;

  const button = $("replay-btn");
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "Replaying…";
  try {
    const replayed = await api(`/api/tunnels/${tunnelId}/requests/${requestId}/replay`, { method: "POST" });
    toast("Request replayed");
    selectRequest(replayed.id);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.innerHTML = original;
    button.disabled = false;
  }
}

async function clearRequests() {
  const tunnelId = state.selectedTunnelId;
  if (!tunnelId) return;
  if (!window.confirm("Clear captured requests for this tunnel?")) return;
  try {
    await api(`/api/tunnels/${tunnelId}/requests`, { method: "DELETE" });
    state.requests.set(tunnelId, new Map());
    const tunnel = state.tunnels.get(tunnelId);
    if (tunnel) {
      tunnel.requestCount = 0;
      tunnel.errorCount = 0;
    }
    state.selectedRequestId = null;
    $("detail").hidden = true;
    $("inspector-body").classList.remove("with-detail");
    renderRequests();
    updateCardMeta(tunnelId);
    toast("Request log cleared");
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------------------ realtime */

function handleMessage(message) {
  switch (message.type) {
    case "snapshot": {
      state.tunnels.clear();
      for (const tunnel of message.tunnels) state.tunnels.set(tunnel.id, tunnel);
      for (const id of [...state.requests.keys()]) {
        if (!state.tunnels.has(id)) state.requests.delete(id);
      }
      if (state.selectedTunnelId && !state.tunnels.has(state.selectedTunnelId)) {
        state.selectedTunnelId = null;
        state.selectedRequestId = null;
      }
      if (!state.selectedTunnelId && message.tunnels.length > 0) {
        selectTunnel(message.tunnels[0].id);
      } else {
        renderTunnels();
        renderInspector();
        if (state.selectedTunnelId) void loadRequests(state.selectedTunnelId);
      }
      break;
    }
    case "tunnel":
      upsertTunnel(message.tunnel, true);
      break;
    case "remove":
      removeTunnel(message.id);
      break;
    case "request":
      handleRequest(message.tunnelId, message.request);
      break;
    case "clear":
      handleClear(message.tunnelId);
      break;
    default:
      break;
  }
}

function handleRequest(tunnelId, request) {
  if (!state.tunnels.has(tunnelId)) return;

  let map = state.requests.get(tunnelId);
  if (!map) {
    map = new Map();
    state.requests.set(tunnelId, map);
  }
  map.set(request.id, request);

  const tunnel = state.tunnels.get(tunnelId);
  if (tunnel) {
    tunnel.requestCount = map.size;
    tunnel.errorCount = [...map.values()].filter(
      (entry) => entry.state === "error" || (entry.status ?? 0) >= 500
    ).length;
  }
  updateCardMeta(tunnelId);
  updateStatusBar();

  if (state.paused) return;
  if (state.selectedTunnelId === tunnelId) {
    renderRequests();
    if (state.selectedRequestId === request.id) void loadDetail(request.id);
  }
}

function handleClear(tunnelId) {
  state.requests.set(tunnelId, new Map());
  const tunnel = state.tunnels.get(tunnelId);
  if (tunnel) {
    tunnel.requestCount = 0;
    tunnel.errorCount = 0;
  }
  if (state.selectedTunnelId === tunnelId) {
    state.selectedRequestId = null;
    $("detail").hidden = true;
    $("inspector-body").classList.remove("with-detail");
    renderRequests();
  }
  updateCardMeta(tunnelId);
  updateStatusBar();
}

function setLiveStatus(status, label) {
  $("live-dot").className = `status-dot ${status}`;
  $("live-label").textContent = label;
}

function connectWebSocket() {
  if (state.ws) return;
  setLiveStatus("starting", "connecting");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  state.ws = socket;

  socket.addEventListener("open", () => {
    clearTimeout(state.wsRetry);
    state.wsRetry = null;
    setLiveStatus("online", "live");
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  socket.addEventListener("close", () => {
    state.ws = null;
    setLiveStatus("offline", "offline");
    if (!state.wsRetry) {
      state.wsRetry = setTimeout(() => {
        state.wsRetry = null;
        connectWebSocket();
      }, 1500);
    }
  });

  socket.addEventListener("error", () => socket.close());
}

/* ------------------------------------------------------------------ settings dialog */

function openSettings() {
  if (!state.settings) return;
  const dialog = $("settings-dialog");
  if (dialog.open) return;
  $("s-server").value = state.settings.server;
  $("s-token").value = state.settings.token || "";
  $("s-local-host").value = state.settings.localHost;
  $("s-public-base").value = state.settings.publicBase;
  $("s-secure").checked = Boolean(state.settings.secure);
  dialog.showModal();
  $("s-server").focus();
}

function closeSettings() {
  $("settings-dialog").close();
}

function saveSettingsFromDialog() {
  const server = $("s-server").value.trim();
  if (!server) {
    toast("Relay server is required", "error");
    return;
  }
  const publicBase = $("s-public-base").value.trim();
  if (publicBase) {
    try {
      const parsed = new URL(publicBase);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      toast("Public URL base must be an http or https URL", "error");
      return;
    }
  }

  state.settings = {
    server,
    token: $("s-token").value.trim(),
    localHost: $("s-local-host").value.trim() || "localhost",
    publicBase: publicBase || "http://localhost:8080",
    secure: $("s-secure").checked
  };
  saveSettings();

  $("relay-host").textContent = state.settings.server;
  $("form-relay").textContent = state.settings.server;
  if (!$("local-host").value.trim()) $("local-host").value = state.settings.localHost;
  updatePreview();
  renderRelayStatus();
  closeSettings();
  toast("Settings saved");
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const config = await api("/api/config");
  state.config = config;

  const saved = loadSettings();
  state.settings = {
    server: saved.server || config.defaults.server,
    token: saved.token || "",
    localHost: saved.localHost || config.defaults.localHost,
    publicBase: saved.publicBase || config.defaults.publicBase,
    secure: Boolean(saved.secure)
  };

  $("relay-host").textContent = state.settings.server;
  $("form-relay").textContent = state.settings.server;
  $("local-host").value = state.settings.localHost;

  for (const tunnel of config.tunnels) state.tunnels.set(tunnel.id, tunnel);
  if (config.tunnels.length > 0) selectTunnel(config.tunnels[0].id);
  else {
    renderTunnels();
    renderInspector();
  }
  updatePreview();
  updateCommandPreview();
  renderRelayStatus();
  connectWebSocket();

  // Keep the "up 4m" labels fresh without touching the request table.
  window.setInterval(() => {
    if (state.tunnels.size > 0) renderTunnels();
  }, 30_000);
}

/* ------------------------------------------------------------------ events */

$("tunnel-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const port = validatePort();
  if (port === null) {
    showPortError("Enter a port between 1 and 65535.");
    $("port").focus();
    return;
  }
  showPortError("");

  const subdomain = $("subdomain").value.trim().toLowerCase();
  if (subdomain && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
    toast("Public name can only use lowercase letters, numbers and hyphens.", "error");
    return;
  }

  setStarting(true);
  try {
    const tunnel = await api("/api/tunnels", {
      method: "POST",
      body: JSON.stringify({
        type: state.formType,
        localPort: port,
        localHost: $("local-host").value.trim() || state.settings.localHost,
        subdomain: subdomain || undefined,
        server: state.settings.server,
        token: state.settings.token || undefined,
        secure: state.settings.secure
      })
    });

    if (!state.tunnels.has(tunnel.id)) state.tunnels.set(tunnel.id, tunnel);
    selectTunnel(tunnel.id);
    $("subdomain").value = "";
    updatePreview();
    updateCommandPreview();
    toast(tunnel.type === "tcp" ? "Starting TCP tunnel…" : "Starting tunnel…");
    if (window.matchMedia("(max-width: 920px)").matches) {
      document.querySelector(".main").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setStarting(false);
  }
});

$("port").addEventListener("input", () => {
  if (validatePort() !== null) showPortError("");
  updatePreview();
  updateCommandPreview();
});

$("subdomain").addEventListener("input", () => {
  updatePreview();
  updateCommandPreview();
});

$("randomize").addEventListener("click", () => {
  $("subdomain").value = randomName();
  updatePreview();
  updateCommandPreview();
  $("subdomain").focus();
});

for (const button of $("type-segmented").querySelectorAll("button")) {
  button.addEventListener("click", () => setFormType(button.dataset.type));
}

$("empty-cta").addEventListener("click", () => $("port").focus());
$("settings-btn").addEventListener("click", openSettings);
$("advanced-settings").addEventListener("click", openSettings);
$("relay-pill").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-cancel").addEventListener("click", closeSettings);

$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettingsFromDialog();
});

$("settings-dialog").addEventListener("click", (event) => {
  if (event.target === $("settings-dialog")) closeSettings();
});

$("filter").addEventListener("input", (event) => {
  state.filter = event.target.value.trim().toLowerCase();
  renderRequests();
});

$("pause-btn").addEventListener("click", () => {
  state.paused = !state.paused;
  renderInspector();
  if (!state.paused && state.selectedTunnelId) void loadRequests(state.selectedTunnelId);
  toast(state.paused ? "Live updates paused" : "Live updates resumed");
});

$("clear-btn").addEventListener("click", () => void clearRequests());
$("close-inspector").addEventListener("click", () => {
  state.selectedTunnelId = null;
  state.selectedRequestId = null;
  $("detail").hidden = true;
  $("inspector-body").classList.remove("with-detail");
  renderTunnels();
  renderInspector();
});

$("replay-btn").addEventListener("click", () => void replayRequest());
$("close-detail").addEventListener("click", closeDetail);

document.addEventListener("keydown", (event) => {
  const target = document.activeElement;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
  if (typing) return;

  if (event.key === "/") {
    event.preventDefault();
    $("filter").focus();
  } else if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    $("port").focus();
  } else if (event.key === "Escape") {
    closeDetail();
  }
});

boot().catch((err) => toast(err.message, "error"));
