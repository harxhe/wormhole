/** Minimal HTTP/1.1 helpers for the raw public listener. */

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "latin1");

export interface ParsedRequestHead {
  method: string;
  target: string;
  version: string;
  headers: Array<[string, string]>;
  /** Byte offset just past the `\r\n\r\n` terminator; the body starts here. */
  bodyOffset: number;
}

/** Parse the request line and headers, or return `null` if incomplete/invalid. */
export function parseRequestHead(buffer: Buffer): ParsedRequestHead | null {
  const end = buffer.indexOf(HEADER_TERMINATOR);
  if (end === -1) return null;

  const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine) return null;

  const parts = requestLine.split(" ");
  if (parts.length !== 3) return null;
  const [method, target, version] = parts;
  if (!method || !target || !version || !version.startsWith("HTTP/")) return null;

  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    if (line === "") continue;
    const index = line.indexOf(":");
    if (index === -1) return null;
    headers.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
  }

  return { method, target, version, headers, bodyOffset: end + HEADER_TERMINATOR.length };
}

/** Case-insensitive header lookup. */
export function getHeader(headers: Array<[string, string]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of headers) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Re-serialize a parsed request head for the tunnel, forcing
 * `Connection: close` so each stream maps to a single request/response.
 */
export function serializeRequestHead(head: ParsedRequestHead): Buffer {
  const lines = [`${head.method} ${head.target} ${head.version}`];
  let hasConnection = false;
  for (const [key, value] of head.headers) {
    if (key.toLowerCase() === "connection") {
      if (!hasConnection) {
        lines.push("Connection: close");
        hasConnection = true;
      }
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  if (!hasConnection) lines.push("Connection: close");
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  429: "Too Many Requests",
  502: "Bad Gateway"
};

/** Build a complete raw HTTP response with an HTML body. */
export function renderResponse(
  status: number,
  title: string,
  message: string,
  headers: Record<string, string> = {}
): Buffer {
  const statusText = STATUS_TEXT[status] ?? "Error";
  const body = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${status} ${title}</title>`,
    "<style>body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;color:#1f2933}" +
      "h1{font-size:1.4rem}code{background:#f0f4f8;padding:.1rem .3rem;border-radius:4px}</style>",
    "</head><body>",
    `<h1>${status} &middot; ${title}</h1>`,
    `<p>${message}</p>`,
    "<p><code>wormhole</code></p>",
    "</body></html>"
  ].join("\n");

  const head = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Content-Type: text/html; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    ""
  ].join("\r\n");

  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body, "utf8")]);
}
