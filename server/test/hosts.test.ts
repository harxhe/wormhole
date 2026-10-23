import { describe, expect, it } from "vitest";
import { publicHostname, publicTcpUrl, publicUrl, stripPort, subdomainFromHost } from "../src/hosts.ts";

describe("stripPort", () => {
  it("removes a numeric port suffix", () => {
    expect(stripPort("localhost:8080")).toBe("localhost");
  });

  it("leaves a host without a port unchanged", () => {
    expect(stripPort("localhost")).toBe("localhost");
  });
});

describe("subdomainFromHost", () => {
  it("extracts a valid subdomain", () => {
    expect(subdomainFromHost("swift-fox.localhost:8080", "localhost")).toBe("swift-fox");
  });

  it("lowercases the host", () => {
    expect(subdomainFromHost("Swift-Fox.localhost", "localhost")).toBe("swift-fox");
  });

  it("returns null for the bare public host", () => {
    expect(subdomainFromHost("localhost:8080", "localhost")).toBeNull();
  });

  it("returns null for unrelated hosts", () => {
    expect(subdomainFromHost("example.com", "localhost")).toBeNull();
  });

  it("returns null for a nested subdomain", () => {
    expect(subdomainFromHost("a.b.localhost", "localhost")).toBeNull();
  });

  it("returns null when the header is missing", () => {
    expect(subdomainFromHost(undefined, "localhost")).toBeNull();
  });
});

describe("publicHostname / publicUrl", () => {
  it("builds the public hostname", () => {
    expect(publicHostname("swift-fox", { publicHost: "localhost" })).toBe("swift-fox.localhost");
  });

  it("includes a non-default port in the URL", () => {
    expect(publicUrl("swift-fox", { publicHost: "localhost", httpPort: 8080 })).toBe("http://swift-fox.localhost:8080");
  });

  it("omits port 80", () => {
    expect(publicUrl("swift-fox", { publicHost: "example.com", httpPort: 80 })).toBe("http://swift-fox.example.com");
  });

  it("supports https and omits the default port", () => {
    expect(
      publicUrl("swift-fox", { publicHost: "example.com", publicScheme: "https", publicPort: 443 })
    ).toBe("https://swift-fox.example.com");
  });

  it("supports https on a custom port", () => {
    expect(
      publicUrl("swift-fox", { publicHost: "example.com", publicScheme: "https", publicPort: 8443 })
    ).toBe("https://swift-fox.example.com:8443");
  });

  it("builds a tcp endpoint", () => {
    expect(publicTcpUrl(15001, { publicHost: "relay.example.com" })).toBe("tcp://relay.example.com:15001");
  });
});
