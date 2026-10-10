import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { connect as netConnect } from "node:net";
import {
  CONTROL_STREAM_ID,
  FrameType,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  decodeJson
} from "@wormhole/protocol";
import type { AssignPayload, AuthPayload, ErrorPayload, Frame } from "@wormhole/protocol";
import { Mux, createLogger } from "@wormhole/transport";

const log = createLogger("mock-client");

export interface MockClientOptions {
  serverHost: string;
  serverPort: number;
  token: string;
  localPort: number;
  subdomain?: string;
  /** Skip certificate verification (self-signed local certs). Default true. */
  insecure?: boolean;
  onAssigned?: (assign: AssignPayload) => void;
}

export interface MockClient {
  assigned: Promise<AssignPayload>;
  close(): void;
}

/**
 * A minimal tunnel client used to exercise the server end to end before the
 * real CLI exists. Connects over TLS, authenticates, and proxies each stream to
 * a local TCP port.
 */
export function startMockClient(options: MockClientOptions): MockClient {
  const socket: TLSSocket = tlsConnect({
    host: options.serverHost,
    port: options.serverPort,
    rejectUnauthorized: options.insecure === false
  });

  let mux: Mux | undefined;
  let assignResolve!: (payload: AssignPayload) => void;
  let assignReject!: (err: Error) => void;
  const assigned = new Promise<AssignPayload>((resolve, reject) => {
    assignResolve = resolve;
    assignReject = reject;
  });

  socket.on("error", (err) => {
    assignReject(err);
    log.error(`connection error: ${err.message}`);
  });

  socket.on("secureConnect", () => {
    socket.removeListener("error", assignReject);
    mux = new Mux(socket, {
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS
    });

    mux.on("error", (err) => log.error(`mux error: ${err.message}`));
    mux.on("control", (frame: Frame) => {
      if (frame.type === FrameType.ASSIGN) {
        const assign = decodeJson<AssignPayload>(frame);
        log.info(`assigned ${assign.url ?? assign.subdomain}`);
        options.onAssigned?.(assign);
        assignResolve(assign);
      } else if (frame.type === FrameType.ERROR) {
        const error = decodeJson<ErrorPayload>(frame);
        log.error(`server error ${error.code}: ${error.message}`);
      }
    });
    mux.on("open", (streamId: number) => handleOpen(mux!, streamId, options.localPort));

    const auth: AuthPayload = { token: options.token, type: "http", subdomain: options.subdomain };
    mux.sendJsonFrame(FrameType.AUTH, CONTROL_STREAM_ID, auth);
  });

  return {
    assigned,
    close: () => {
      if (mux) mux.destroy();
      else socket.destroy();
    }
  };
}

function handleOpen(mux: Mux, streamId: number, localPort: number): void {
  const stream = mux.acceptStream(streamId);
  const local = netConnect(localPort, "127.0.0.1");
  local.setNoDelay(true);

  let localReady = false;
  let closed = false;
  const pending: Buffer[] = [];

  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    local.destroy();
    stream.close();
  };

  stream.on("data", (chunk: Buffer) => {
    if (localReady) {
      if (!local.write(chunk)) stream.pauseControl();
    } else {
      pending.push(chunk);
    }
  });
  stream.on("drain", () => local.resume());
  stream.on("close", () => {
    if (!closed) {
      closed = true;
      local.destroy();
    }
  });
  stream.on("error", () => {});

  local.on("connect", () => {
    localReady = true;
    for (const chunk of pending) local.write(chunk);
    pending.length = 0;
  });
  local.on("data", (chunk: Buffer) => {
    if (!stream.write(chunk)) local.pause();
  });
  local.on("drain", () => stream.resumeControl());
  local.on("end", closeOnce);
  local.on("error", closeOnce);
  local.on("close", closeOnce);
}
