import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSerenityProvider,
  prepareSerenityConnection,
  SerenityMemoryProvider,
  serenityBotEntity,
  serenityRequiresDeploymentOwner,
  serenitySpaceEntity,
} from "./serenity-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

vi.mock("./serenity-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serenity-client.js")>();
  return {
    ...actual,
    probeSerenity: vi.fn(),
    recallSerenity: vi.fn(),
    rememberSerenity: vi.fn(),
    forgetSerenity: vi.fn(),
  };
});

import {
  forgetSerenity,
  probeSerenity,
  recallSerenity,
  rememberSerenity,
} from "./serenity-client.js";

const probeSerenityMock = vi.mocked(probeSerenity);
const recallSerenityMock = vi.mocked(recallSerenity);
const rememberSerenityMock = vi.mocked(rememberSerenity);
const forgetSerenityMock = vi.mocked(forgetSerenity);

afterEach(() => {
  vi.clearAllMocks();
});

function provider(allowWrites = true, brainLabel = "") {
  return new SerenityMemoryProvider({
    endpoint: "http://127.0.0.1:8787/mcp",
    token: "serenity_test_token",
    brainLabel,
    allowWrites,
  });
}

describe("SerenityMemoryProvider", () => {
  it("keeps bot and space entity namespaces inside the adapter", () => {
    expect(serenityBotEntity("bot-1")).toBe("rakazo-bot/bot-1");
    expect(serenitySpaceEntity("workspace-1")).toBe("rakazo-space/workspace-1");
    expect(serenityBotEntity("bot-1", "Personal Brain")).toBe("rakazo-bot/personal-brain/bot-1");
    expect(serenitySpaceEntity("workspace-1", "Personal Brain")).toBe(
      "rakazo-space/personal-brain/workspace-1",
    );
  });

  it("requires deployment owner for loopback endpoints", () => {
    expect(serenityRequiresDeploymentOwner({ endpoint: "http://127.0.0.1:8787/mcp" })).toBe(true);
    expect(serenityRequiresDeploymentOwner({ endpoint: "https://serenity.example.test/mcp" })).toBe(
      false,
    );
  });

  it("probes before accepting a connection", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "http://127.0.0.1:8787", allowWrites: "false", brainLabel: "personal" },
      { token: "serenity_test_token" },
    );
    expect(prepared.settings.endpoint).toBe("http://127.0.0.1:8787/mcp");
    expect(prepared.settings.allowWrites).toBe("false");
    expect(prepared.credentials).toEqual({ token: "serenity_test_token" });
    expect(probeSerenityMock).toHaveBeenCalledOnce();
  });

  it("recalls isolated scope only against the bot entity", async () => {
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: [
        {
          factId: "fact-1",
          fact: "Prefer conventional commits.",
          provenance: "user told rakazo",
        },
      ],
    });

    const result = await provider().recall(
      { query: "commits", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Prefer conventional commits.",
          score: 1,
          id: "fact-1",
          provenance: "user told rakazo",
        },
      ],
    });
    expect(recallSerenityMock).toHaveBeenCalledWith(
      "commits",
      expect.objectContaining({ endpoint: "http://127.0.0.1:8787/mcp" }),
      expect.objectContaining({ entity: "rakazo-bot/bot-1", limit: 5 }),
    );
  });

  it("mirrors shared durable saves to space and bot entities", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const result = await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-space/workspace-1",
      "rakazo-bot/bot-1",
    ]);
  });

  it("scopes shared durable saves by brain label when configured", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    await labeled.save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-space/personal-brain/workspace-1",
      "rakazo-bot/personal-brain/bot-1",
    ]);
  });

  it("blocks durable writes when allowWrites is off", async () => {
    const result = await provider(false).save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("skips history compaction writes and purges", async () => {
    await expect(
      provider().save(
        {
          content: "summary",
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "history", generation: 3 },
        },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [1, 2] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("forgets by Serenity fact id when writes are enabled", async () => {
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
    const result = await provider().forget({ id: "fact-1", reason: "user requested" }, context);
    expect(result).toEqual({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
  });

  it("createSerenityProvider builds a working adapter", () => {
    const created = createSerenityProvider(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "true" },
      { token: "serenity_test_token" },
    );
    expect(created.describe().id).toBe("serenity");
  });
});
