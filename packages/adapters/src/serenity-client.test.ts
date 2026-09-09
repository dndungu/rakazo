import { describe, expect, it, vi } from "vitest";
import {
  normalizeSerenityEndpoint,
  parseSerenityEndpoint,
  probeSerenity,
  serenityEndpointRequiresDeploymentOwner,
} from "./serenity-client.js";

const TOKEN = "serenity_test_token";

describe("serenity endpoint helpers", () => {
  it("appends /mcp when missing", () => {
    expect(normalizeSerenityEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/mcp");
    expect(normalizeSerenityEndpoint("https://serenity.example.test/mcp")).toBe(
      "https://serenity.example.test/mcp",
    );
  });

  it("rejects credentials, queries, and fragments", () => {
    expect(() => parseSerenityEndpoint("https://user:pass@serenity.example.test/mcp")).toThrow(
      /credentials/,
    );
    expect(() => parseSerenityEndpoint("https://serenity.example.test/mcp?x=1")).toThrow(/query/);
    expect(() => parseSerenityEndpoint("https://serenity.example.test/mcp#frag")).toThrow(
      /fragment/,
    );
  });

  it("requires deployment-owner trust for loopback and private LAN", () => {
    expect(serenityEndpointRequiresDeploymentOwner("http://127.0.0.1:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("http://192.168.1.10:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("https://192.168.1.10:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("https://serenity.example.test/mcp")).toBe(
      false,
    );
  });

  it("rejects public HTTP endpoints", () => {
    expect(() => normalizeSerenityEndpoint("http://serenity.example.test/mcp")).toThrow(/HTTPS/);
  });
});

describe("serenity SSRF fetch path", () => {
  it("rejects public HTTPS when DNS returns a private address", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "10.1.2.3", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows public HTTPS when DNS returns a public address (safe fetch runs)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("safe-path-fetch-reached");
    });
    let resolved = false;
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "203.0.113.10", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/safe-path-fetch-reached|Could not reach/);
  });

  it("uses plain fetch for loopback without DNS pinning", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("plain-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "http://127.0.0.1:8787/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.1.2.3", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/plain-fetch-reached/);
  });

  it("uses plain fetch for private LAN HTTPS without assertPublicAddresses", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-lan-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "https://192.168.1.10:8787/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "203.0.113.10", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private-lan-fetch-reached/);
  });
});
