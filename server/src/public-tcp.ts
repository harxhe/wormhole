import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { createLogger } from "@wormhole/transport";
import type { Stream } from "@wormhole/transport";

const log = createLogger("tcp-public");

export interface TcpTunnelOptions {
  /** Interface to bind, e.g. `0.0.0.0` or `127.0.0.1`. */
  bindHost: string;
  /** Port from the configured public range. */
  port: number;
  /** Open one tunnel stream for an accepted public connection. */
  openStream: () => Stream;
}

/** A per-tunnel public TCP listener. */
export interface TcpTunnel {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Listen on one public port and bridge every accepted connection to a fresh
 * tunnel stream. The caller owns the port allocation; if `listen` fails the
 * promise rejects and the port can be reused.
 */
export function listenTcpTunnel(options: TcpTunnelOptions): Promise<TcpTunnel> {
  const sockets = new Set<Socket>();
  const server = createServer();

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      server.on("error", (err) => log.debug(`listener error: ${err.message}`));
      const address = server.address() as AddressInfo | null;
      resolve({
        port: address?.port ?? options.port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => done());
          })
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      bridge(socket, options.openStream);
    });
    server.listen(options.port, options.bindHost);
  });
}

function bridge(socket: Socket, openStream: () => Stream): void {
  socket.setNoDelay(true);

  let stream: Stream;
  try {
    stream = openStream();
  } catch (err) {
    log.debug(`refusing connection: ${(err as Error).message}`);
    socket.destroy();
    return;
  }

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    socket.destroy();
    stream.close();
  };

  // Public -> tunnel.
  socket.on("data", (chunk: Buffer) => {
    if (!stream.write(chunk)) socket.pause();
  });
  socket.on("drain", () => stream.resumeControl());
  socket.on("end", finish);
  socket.on("close", finish);
  socket.on("error", finish);

  // Tunnel -> public.
  stream.on("data", (chunk: Buffer) => {
    if (!socket.write(chunk)) stream.pauseControl();
  });
  stream.on("drain", () => socket.resume());
  stream.on("close", finish);
  stream.on("error", finish);
}

export type { Server, Socket };
