import { describe, expect, it } from "vitest";
import { getHeader, parseRequestHead, renderResponse, serializeRequestHead } from "../src/http.ts";

describe("parseRequestHead", () => {
  it("parses the request line and headers", () => {
    const buffer = Buffer.from("GET /path?x=1 HTTP/1.1\r\nHost: app.localhost\r\nAccept: */*\r\n\r\nbody", "latin1");
    const head = parseRequestHead(buffer);

    expect(head).not.toBeNull();
    expect(head!.method).toBe("GET");
    expect(head!.target).toBe("/path?x=1");
    expect(head!.version).toBe("HTTP/1.1");
    expect(getHeader(head!.headers, "host")).toBe("app.localhost");
    expect(buffer.subarray(head!.bodyOffset).toString()).toBe("body");
  });

  it("returns null until the header terminator arrives", () => {
    expect(parseRequestHead(Buffer.from("GET / HTTP/1.1\r\nHost: x", "latin1"))).toBeNull();
  });

  it("returns null for a malformed request line", () => {
    expect(parseRequestHead(Buffer.from("GET /\r\n\r\n", "latin1"))).toBeNull();
  });
});

describe("serializeRequestHead", () => {
  it("forces Connection: close and preserves other headers", () => {
    const head = parseRequestHead(
      Buffer.from("GET / HTTP/1.1\r\nHost: app.localhost\r\nConnection: keep-alive\r\n\r\n", "latin1")
    )!;
    const serialized = serializeRequestHead(head).toString("latin1");

    expect(serialized).toContain("GET / HTTP/1.1\r\n");
    expect(serialized).toContain("Host: app.localhost\r\n");
    expect(serialized).toContain("Connection: close\r\n");
    expect(serialized).not.toContain("keep-alive");
    expect(serialized.endsWith("\r\n\r\n")).toBe(true);
  });

  it("adds Connection: close when absent", () => {
    const head = parseRequestHead(Buffer.from("GET / HTTP/1.1\r\nHost: a\r\n\r\n", "latin1"))!;
    expect(serializeRequestHead(head).toString("latin1")).toContain("Connection: close");
  });
});

describe("renderResponse", () => {
  it("builds a complete response with a Content-Length", () => {
    const response = renderResponse(404, "Not Found", "missing").toString("latin1");
    expect(response.startsWith("HTTP/1.1 404 Not Found\r\n")).toBe(true);
    expect(response).toContain("Content-Type: text/html; charset=utf-8");
    expect(response).toMatch(/Content-Length: \d+/);
    expect(response).toContain("missing");
  });
});
