import { describe, it, expect } from "vitest";
import {
  FrameDecoder,
  FrameType,
  HEADER_SIZE,
  MAX_PAYLOAD,
  ProtocolError,
  encodeFrame,
  encodeJsonFrame
} from "@wormhole/protocol";
import type { Frame } from "@wormhole/protocol";

describe("encodeFrame", () => {
  it("writes a big-endian header followed by the payload", () => {
    const payload = Buffer.from("hello", "utf8");
    const frame = encodeFrame(FrameType.DATA, 0x01020304, payload);

    expect(frame.length).toBe(HEADER_SIZE + payload.length);
    expect(frame.readUInt8(0)).toBe(FrameType.DATA);
    expect(frame.readUInt32BE(1)).toBe(0x01020304);
    expect(frame.readUInt32BE(5)).toBe(payload.length);
    expect(frame.subarray(HEADER_SIZE).toString("utf8")).toBe("hello");
  });

  it("defaults to an empty payload", () => {
    const frame = encodeFrame(FrameType.PING, 0);
    expect(frame.length).toBe(HEADER_SIZE);
    expect(frame.readUInt32BE(5)).toBe(0);
  });

  it("rejects payloads larger than MAX_PAYLOAD", () => {
    const huge = Buffer.alloc(MAX_PAYLOAD + 1);
    expect(() => encodeFrame(FrameType.DATA, 1, huge)).toThrow(ProtocolError);
  });

  it("rejects invalid stream ids", () => {
    expect(() => encodeFrame(FrameType.DATA, -1)).toThrow(ProtocolError);
    expect(() => encodeFrame(FrameType.DATA, 0x1_0000_0000)).toThrow(ProtocolError);
  });
});

describe("decodeJson", () => {
  it("round-trips JSON control payloads", async () => {
    const { decodeJson } = await import("@wormhole/protocol");
    const frame = encodeFrame(FrameType.AUTH, 0, Buffer.from(JSON.stringify({ token: "t", type: "http" })));
    const [decoded] = new FrameDecoder().push(frame);
    expect(decodeJson(decoded!)).toEqual({ token: "t", type: "http" });
  });
});

describe("FrameDecoder", () => {
  it("parses a whole frame from a single chunk", () => {
    const frame = encodeJsonFrame(FrameType.AUTH, 0, { token: "abc", type: "http" });
    const frames = new FrameDecoder().push(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(FrameType.AUTH);
    expect(frames[0]!.streamId).toBe(0);
  });

  it("buffers a frame delivered one byte at a time", () => {
    const decoder = new FrameDecoder();
    const frame = encodeJsonFrame(FrameType.OPEN, 7, {});
    const collected: Frame[] = [];

    for (let i = 0; i < frame.length; i++) {
      collected.push(...decoder.push(frame.subarray(i, i + 1)));
    }

    expect(collected).toHaveLength(1);
    expect(collected[0]!.streamId).toBe(7);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("merges multiple frames arriving in one chunk", () => {
    const a = encodeFrame(FrameType.DATA, 1, Buffer.from("aa"));
    const b = encodeFrame(FrameType.DATA, 3, Buffer.from("bbb"));
    const c = encodeFrame(FrameType.CLOSE, 1);
    const frames = new FrameDecoder().push(Buffer.concat([a, b, c]));

    expect(frames.map((f) => f.streamId)).toEqual([1, 3, 1]);
    expect(frames.map((f) => f.type)).toEqual([FrameType.DATA, FrameType.DATA, FrameType.CLOSE]);
    expect(frames[0]!.payload.toString()).toBe("aa");
    expect(frames[1]!.payload.toString()).toBe("bbb");
  });

  it("handles a frame split across two chunks plus a following frame", () => {
    const first = encodeFrame(FrameType.DATA, 5, Buffer.from("split me"));
    const second = encodeFrame(FrameType.CLOSE, 5);
    const combined = Buffer.concat([first, second]);

    const cut = HEADER_SIZE + 3;
    const decoder = new FrameDecoder();

    const partial = decoder.push(combined.subarray(0, cut));
    expect(partial).toHaveLength(0);

    const rest = decoder.push(combined.subarray(cut));
    expect(rest.map((f) => f.type)).toEqual([FrameType.DATA, FrameType.CLOSE]);
    expect(rest[0]!.payload.toString()).toBe("split me");
  });

  it("accepts a payload at the MAX_PAYLOAD boundary", () => {
    const frame = encodeFrame(FrameType.DATA, 1, Buffer.alloc(MAX_PAYLOAD, 0x41));
    const frames = new FrameDecoder().push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(MAX_PAYLOAD);
  });

  it("throws on an unknown frame type", () => {
    const frame = encodeFrame(99 as FrameType, 1);
    expect(() => new FrameDecoder().push(frame)).toThrow(ProtocolError);
  });

  it("throws when the declared length exceeds maxPayload", () => {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt8(FrameType.DATA, 0);
    header.writeUInt32BE(1, 1);
    header.writeUInt32BE(MAX_PAYLOAD + 1, 5);
    expect(() => new FrameDecoder().push(header)).toThrow(ProtocolError);
  });

  it("ignores empty chunks", () => {
    expect(new FrameDecoder().push(Buffer.alloc(0))).toEqual([]);
  });
});
