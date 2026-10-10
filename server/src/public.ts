import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import type { Config } from "./config.ts";
import type { TunnelRegistry } from "./registry.ts";
import {
  getHeader,
  parseRequestHead,
  renderResponse,
  serializeRequestHead,
  createLogger,
  type Stream,
  type ParsedRequestHead
} from "@wormhole/transport";
import { subdomainFromHost } from "./hosts.ts";

const log = createLogger("public");

const MAX_HEADER_BYTES = 64 * 1024;

export interface PublicServerOptions {
  config: Config;
  registry: TunnelRegistry;
}

/**
 * Create the public HTTP listener. Incoming requests are routed to a tunnel by
 * the `Host` header, then relayed over a fresh stream as raw HTTP/1.1 bytes.
 */
export function createPublicServer(options: PublicServerOptions): Server {
  const { config, registry } = options;
  return createServer((socket) => handleConnection(socket, config, registry));
}

function handleConnection(socket: Socket, config: Config, registry: TunnelRegistry): void {
  socket.setNoDelay(true);

  let buffered = Buffer.alloc(0);
  let head: ParsedRequestHead | null = null;
  let stream: Stream | null = null;
  let responseStarted = false;
  let finished = false;

  const finish = (response?: Buffer): void => {
    if (finished) return;
    finished = true;
    if (response) socket.end(response);
    else socket.end();
  };

  socket.on("error", () => {
    stream?.close();
    socket.destroy();
  });
  socket.on("close", () => stream?.close());

  socket.on("data", (chunk: Buffer) => {
    if (finished) return;

    if (!head) {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        finish(renderResponse(400, "Bad Request", "Request headers are too large."));
        return;
      }
      const parsed = parseRequestHead(buffered);
      if (!parsed) return;
      head = parsed;
      startTunnel(parsed);
      return;
    }

    if (stream) {
      if (!stream.write(chunk)) socket.pause();
    }
  });

  function startTunnel(parsed: ParsedRequestHead): void {
    const hostHeader = getHeader(parsed.headers, "host");
    const subdomain = subdomainFromHost(hostHeader, config.publicHost);
    if (!subdomain) {
      finish(renderResponse(404, "No tunnel", "This host is not a Wormhole tunnel."));
      return;
    }

    const tunnel = registry.get(subdomain);
    if (!tunnel) {
      finish(renderResponse(404, "Tunnel not found", `No active tunnel for <code>${subdomain}</code>.`));
      return;
    }

    try {
      stream = tunnel.openStream();
    } catch {
      stream = null;
      finish(renderResponse(502, "Bad Gateway", "The tunnel is no longer available."));
      return;
    }

    const active = stream;
    active.on("data", (chunk: Buffer) => {
      responseStarted = true;
      if (!socket.write(chunk)) {
        active.pauseControl();
        socket.once("drain", () => active.resumeControl());
      }
    });
    active.on("drain", () => socket.resume());
    active.on("error", (err: Error) => log.debug(`stream error: ${err.message}`));
    active.on("close", () => {
      if (responseStarted) finish();
      else finish(renderResponse(502, "Bad Gateway", "The local service did not respond."));
    });

    const body = buffered.subarray(parsed.bodyOffset);
    const requestBytes = Buffer.concat([serializeRequestHead(parsed), body]);
    buffered = Buffer.alloc(0);
    if (!active.write(requestBytes)) socket.pause();
  }
}
