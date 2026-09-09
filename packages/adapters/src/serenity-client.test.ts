import { describe, expect, it } from "vitest";
import {
  normalizeSerenityEndpoint,
  parseSerenityEndpoint,
  serenityEndpointRequiresDeploymentOwner,
} from "./serenity-client.js";

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
    expect(serenityEndpointRequiresDeploymentOwner("https://serenity.example.test/mcp")).toBe(
      false,
    );
  });

  it("rejects public HTTP endpoints", () => {
    expect(() => normalizeSerenityEndpoint("http://serenity.example.test/mcp")).toThrow(/HTTPS/);
  });
});
