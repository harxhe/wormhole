/**
 * Minimal HTTP/1.1 parsing for the inspector. The client only sees raw bytes on
 * each stream, so the inspector recovers method, path, status and headers from
 * those bytes. Parsing never throws: malformed traffic is still relayed, it
 * just shows up in the inspector with fewer details.
 */

export type HeaderList = [string, string][];

export interface RequestHead {
  method: string;
  path: string;
  version: string;
  headers: HeaderList;
  /** Offset of the first body byte in the buffer that was parsed. */
  bodyOffset: number;
}

export interface ResponseHead {
  version: string;
  status: number;
  statusText: string;
  headers: HeaderList;
  bodyOffset: number;
}

const HEAD_TERMINATOR = Buffer.from("\r\n\r\n", "latin1");

function splitHead(buffer: Buffer): { lines: string[]; bodyOffset: number } | null {
  const end = buffer.indexOf(HEAD_TERMINATOR);
  if (end === -1) return null;
  const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
  return { lines, bodyOffset: end + HEAD_TERMINATOR.length };
}

function parseHeaders(lines: string[]): HeaderList {
  const headers: HeaderList = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

/** Parse a request head. Returns `null` until the full head has arrived or if it is malformed. */
export function parseRequestHead(buffer: Buffer): RequestHead | null {
  const split = splitHead(buffer);
  if (!split) return null;
  const [requestLine, ...rest] = split.lines;
  const parts = (requestLine ?? "").split(" ");
  if (parts.length !== 3) return null;
  const [method, path, version] = parts as [string, string, string];
  if (!method || !path || !version.startsWith("HTTP/")) return null;
  return { method, path, version, headers: parseHeaders(rest), bodyOffset: split.bodyOffset };
}

/** Parse a response head. Returns `null` until the full head has arrived or if it is malformed. */
export function parseResponseHead(buffer: Buffer): ResponseHead | null {
  const split = splitHead(buffer);
  if (!split) return null;
  const [statusLine, ...rest] = split.lines;
  const match = /^(HTTP\/\d(?:\.\d)?) (\d{3})(?: (.*))?$/.exec(statusLine ?? "");
  if (!match) return null;
  return {
    version: match[1]!,
    status: Number(match[2]),
    statusText: match[3] ?? "",
    headers: parseHeaders(rest),
    bodyOffset: split.bodyOffset
  };
}

/** Case-insensitive header lookup (first match). */
export function getHeader(headers: HeaderList, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

/**
 * Decode a `Transfer-Encoding: chunked` body. Returns `null` if the body is
 * incomplete or malformed, so callers can fall back to the raw bytes.
 */
export function decodeChunked(body: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) return null;
    const sizeText = body.subarray(offset, lineEnd).toString("latin1").split(";")[0]!.trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0 || !/^[0-9a-fA-F]+$/.test(sizeText)) return null;
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(parts);
    if (offset + size > body.length) return null;
    parts.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
}
