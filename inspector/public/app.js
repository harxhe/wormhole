// Wormhole inspector dashboard. Plain JS, no build step.
// Receives live updates over a WebSocket at /ws and loads details from /api.

const state = {
  requests: new Map(), // id -> summary
  selected: null,
  filter: ""
};

const $ = (id) => document.getElementById(id);
const rows = $("rows");

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "snapshot":
        state.requests.clear();
        for (const request of message.requests) state.requests.set(request.id, request);
        renderStatus(message.status);
        renderList();
        break;
      case "upsert":
        state.requests.set(message.request.id, message.request);
        renderList();
        if (state.selected === message.request.id) loadDetail(message.request.id);
        break;
      case "clear":
        state.requests.clear();
        state.selected = null;
        $("detail").hidden = true;
        renderList();
        break;
      case "status":
        renderStatus(message.status);
        break;
    }
  });

  socket.addEventListener("close", () => {
    renderStatus({ state: "offline", url: null, localPort: null, message: "inspector disconnected" });
    setTimeout(connect, 1000);
  });
}

function renderStatus(status) {
  $("status-dot").className = `dot ${status.state}`;
  const labels = { online: "online", connecting: "connecting…", reconnecting: "reconnecting…", offline: "offline" };
  $("status-text").textContent = status.message ? `${labels[status.state]} · ${status.message}` : labels[status.state];
  const link = $("status-url");
  if (status.url) {
    link.href = status.url;
    link.textContent = status.url;
  } else {
    link.removeAttribute("href");
    link.textContent = "";
  }
  $("status-local").textContent = status.localPort ? `→ localhost:${status.localPort}` : "";
}

function statusClass(request) {
  if (request.state === "error") return "err";
  if (request.status === null) return "pending";
  return `s${String(request.status)[0]}`;
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

function matchesFilter(request) {
  if (!state.filter) return true;
  const text = `${request.method ?? ""} ${request.path ?? ""} ${request.status ?? ""}`.toLowerCase();
  return text.includes(state.filter);
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderList() {
  const list = [...state.requests.values()].sort((a, b) => b.id - a.id).filter(matchesFilter);
  rows.replaceChildren();
  for (const request of list) {
    const tr = document.createElement("tr");
    if (request.id === state.selected) tr.className = "active";

    tr.append(cell(request.method ?? "—", "method"));

    const path = cell(request.path ?? "—", "path");
    path.title = request.path ?? "";
    if (request.replayOf !== null) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "replay";
      path.append(tag);
    }
    tr.append(path);

    const statusText = request.state === "error" ? "ERR" : request.status ?? "…";
    tr.append(cell(String(statusText), `badge ${statusClass(request)}`));
    tr.append(cell(formatMs(request.durationMs), "num"));
    tr.append(cell(formatBytes(request.responseBytes), "num"));
    tr.append(cell(new Date(request.startedAt).toLocaleTimeString(), "muted"));

    tr.addEventListener("click", () => select(request.id));
    rows.append(tr);
  }
  $("empty").hidden = list.length > 0;
}

function select(id) {
  state.selected = id;
  renderList();
  loadDetail(id);
}

async function loadDetail(id) {
  const response = await fetch(`/api/requests/${id}`);
  if (!response.ok) return;
  const detail = await response.json();
  if (state.selected !== id) return;

  $("detail").hidden = false;
  $("d-title").textContent = `${detail.method ?? "?"} ${detail.path ?? ""}`;
  const parts = [
    detail.status !== null ? `${detail.status} ${detail.statusText ?? ""}` : "no response",
    `total ${formatMs(detail.durationMs)}`,
    `first byte ${formatMs(detail.ttfbMs)}`,
    detail.streamId !== null ? `stream ${detail.streamId}` : `replay of #${detail.replayOf}`
  ];
  $("d-meta").textContent = parts.join(" · ");

  const error = $("d-error");
  error.hidden = !detail.error;
  error.textContent = detail.error ?? "";

  renderHeaders($("d-req-headers"), detail.requestHeaders);
  renderHeaders($("d-res-headers"), detail.responseHeaders);
  renderBody($("d-req-body"), $("d-req-size"), detail.requestBody);
  renderBody($("d-res-body"), $("d-res-size"), detail.responseBody);

  const replay = $("replay");
  replay.disabled = !detail.replayable;
  replay.title = detail.replayable ? "Send this request to your local app again" : "Not replayable (incomplete or over 1 MB)";
}

function renderHeaders(table, headers) {
  table.replaceChildren();
  for (const [name, value] of headers) {
    const tr = document.createElement("tr");
    tr.append(cell(name), cell(value));
    table.append(tr);
  }
}

function renderBody(pre, sizeLabel, body) {
  sizeLabel.textContent = body.size ? `(${formatBytes(body.size)}${body.truncated ? ", truncated" : ""})` : "";
  if (body.size === 0) pre.textContent = "(empty)";
  else if (body.binary) pre.textContent = `[binary, ${formatBytes(body.size)}]`;
  else pre.textContent = prettyJson(body.text);
}

function prettyJson(text) {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

$("replay").addEventListener("click", async () => {
  if (state.selected === null) return;
  const button = $("replay");
  button.disabled = true;
  button.textContent = "Replaying…";
  try {
    const response = await fetch(`/api/requests/${state.selected}/replay`, { method: "POST" });
    const body = await response.json();
    if (response.ok) select(body.id);
    else alert(`Replay failed: ${body.error}`);
  } finally {
    button.textContent = "Replay";
    button.disabled = false;
  }
});

$("clear").addEventListener("click", () => fetch("/api/requests", { method: "DELETE" }));

$("filter").addEventListener("input", (event) => {
  state.filter = event.target.value.trim().toLowerCase();
  renderList();
});

connect();
