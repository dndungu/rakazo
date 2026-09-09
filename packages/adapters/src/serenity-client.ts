import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isLocalMcpHost } from "@rakazo/contracts";
import { combineSignals } from "./connector-safety.js";
import { isCloudMetadataAddress, isPrivateAddress } from "./network-address.js";

const SERENITY_TIMEOUT_MS = 15_000;
export const MAX_SERENITY_FACT_CHARS = 10_000;
export const MAX_SERENITY_PROVENANCE_CHARS = 500;

export interface SerenityConnectionConfig {
  endpoint: string;
  token: string;
}

export type SerenityResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SerenityRecallFact {
  factId: string;
  fact: string;
  provenance: string;
  kind?: string;
  entitySlug?: string | null;
}

export interface SerenityRememberResult {
  id: string;
  status: string;
  statusText?: string;
}

export interface SerenityForgetResult {
  id: string;
  expired: boolean;
  reason: string | null;
}

/** Endpoints are route prefixes: no credentials, query, or fragment. */
export function parseSerenityEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Serenity endpoint must be a valid HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Serenity endpoint must use HTTP(S) without credentials, a query, or a fragment.",
    );
  }
  return url;
}

export function normalizeSerenityEndpoint(endpoint: string): string {
  const url = parseSerenityEndpoint(endpoint);
  assertAllowedSerenityEndpoint(url);
  const path = url.pathname.replace(/\/+$/, "") || "";
  const withMcp = path.endsWith("/mcp") ? path : `${path}/mcp`;
  url.pathname = withMcp;
  return url.href.replace(/\/+$/, "");
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Loopback or RFC1918/ULA hosts need deployment-owner authorization. */
export function serenityEndpointRequiresDeploymentOwner(endpoint: string): boolean {
  const url = parseSerenityEndpoint(endpoint);
  const host = hostnameOf(url);
  if (isLocalMcpHost(host)) return true;
  if (isIP(host) !== 0) return isPrivateAddress(host);
  // Unresolved hostnames may be LAN DNS; treat non-HTTPS as private trust boundary.
  return url.protocol === "http:";
}

function isLoopbackOrPrivateHost(host: string): boolean {
  if (isLocalMcpHost(host)) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

function assertAllowedSerenityEndpoint(url: URL): void {
  const host = hostnameOf(url);
  if (isCloudMetadataAddress(host)) {
    throw new Error("Serenity endpoint targets a blocked address.");
  }
  if (url.protocol === "http:" && !isLoopbackOrPrivateHost(host)) {
    throw new Error(
      "Serenity HTTP endpoints are limited to loopback or private LAN addresses; use HTTPS for public hosts.",
    );
  }
}

function mcpTextPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const row = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  };
  if (row.structuredContent && typeof row.structuredContent === "object") {
    return row.structuredContent;
  }
  const content = row.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const entry = part as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") {
      try {
        return JSON.parse(entry.text) as unknown;
      } catch {
        return entry.text;
      }
    }
  }
  return undefined;
}

function toolCallIsError(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError);
}

function verbErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const row = payload as { error?: unknown; message?: unknown; suggestion?: unknown };
  const parts = [
    typeof row.message === "string" ? row.message : null,
    typeof row.error === "string" ? `(${row.error})` : null,
    typeof row.suggestion === "string" ? row.suggestion : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : fallback;
}

async function withSerenityClient<T>(
  config: SerenityConnectionConfig,
  signal: AbortSignal | undefined,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const endpoint = normalizeSerenityEndpoint(config.endpoint);
  const url = parseSerenityEndpoint(endpoint);
  assertAllowedSerenityEndpoint(url);
  const requestSignal = combineSignals(signal, AbortSignal.timeout(SERENITY_TIMEOUT_MS));
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json, text/event-stream",
      },
      redirect: "manual",
      signal: requestSignal,
    },
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Serenity MCP redirects are not permitted; configure the final URL.");
      }
      return response;
    },
  });
  const client = new Client({ name: "rakazo", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { signal: requestSignal, timeout: SERENITY_TIMEOUT_MS });
    return await run(client, requestSignal);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function probeSerenity(
  config: SerenityConnectionConfig,
  signal?: AbortSignal,
): Promise<SerenityResult<void>> {
  try {
    await withSerenityClient(config, signal, async (client, requestSignal) => {
      const listed = await client.listTools(
        {},
        { signal: requestSignal, timeout: SERENITY_TIMEOUT_MS },
      );
      const names = new Set(listed.tools.map((tool) => tool.name));
      for (const required of ["recall", "remember", "forget"] as const) {
        if (!names.has(required)) {
          throw new Error(`Serenity MCP is missing the "${required}" tool.`);
        }
      }
    });
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function recallSerenity(
  query: string,
  config: SerenityConnectionConfig,
  options: { limit: number; entity?: string; signal?: AbortSignal },
): Promise<SerenityResult<SerenityRecallFact[]>> {
  try {
    const payload = await withSerenityClient(config, options.signal, async (client, signal) => {
      const result = await client.callTool(
        {
          name: "recall",
          arguments: {
            query,
            limit: Math.min(Math.max(1, Math.floor(options.limit)), 50),
            ...(options.entity ? { entity: options.entity } : {}),
          },
        },
        undefined,
        { signal, timeout: SERENITY_TIMEOUT_MS },
      );
      const body = mcpTextPayload(result);
      if (toolCallIsError(result)) {
        throw new Error(verbErrorMessage(body, "Serenity recall failed"));
      }
      return body;
    });
    return { ok: true, value: parseRecallFacts(payload).slice(0, options.limit) };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity recall failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function rememberSerenity(
  fact: string,
  provenance: string,
  config: SerenityConnectionConfig,
  options: { entity?: string; signal?: AbortSignal } = {},
): Promise<SerenityResult<SerenityRememberResult>> {
  const trimmedFact = fact.trim().slice(0, MAX_SERENITY_FACT_CHARS);
  const trimmedProvenance = provenance.trim().slice(0, MAX_SERENITY_PROVENANCE_CHARS);
  if (!trimmedFact) return { ok: false, error: "fact is required" };
  if (!trimmedProvenance) return { ok: false, error: "provenance is required" };
  try {
    const payload = await withSerenityClient(config, options.signal, async (client, signal) => {
      const result = await client.callTool(
        {
          name: "remember",
          arguments: {
            fact: trimmedFact,
            provenance: trimmedProvenance,
            ...(options.entity ? { entity: options.entity } : {}),
          },
        },
        undefined,
        { signal, timeout: SERENITY_TIMEOUT_MS },
      );
      const body = mcpTextPayload(result);
      if (toolCallIsError(result)) {
        throw new Error(verbErrorMessage(body, "Serenity remember failed"));
      }
      return body;
    });
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Serenity remember returned an unexpected payload" };
    }
    const row = payload as { id?: unknown; status?: unknown; status_text?: unknown };
    if (typeof row.id !== "string" || typeof row.status !== "string") {
      return { ok: false, error: "Serenity remember returned an unexpected payload" };
    }
    return {
      ok: true,
      value: {
        id: row.id,
        status: row.status,
        ...(typeof row.status_text === "string" ? { statusText: row.status_text } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity remember failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function forgetSerenity(
  id: string,
  config: SerenityConnectionConfig,
  options: { reason?: string; signal?: AbortSignal } = {},
): Promise<SerenityResult<SerenityForgetResult>> {
  const factId = id.trim();
  if (!factId) return { ok: false, error: "id is required" };
  try {
    const payload = await withSerenityClient(config, options.signal, async (client, signal) => {
      const result = await client.callTool(
        {
          name: "forget",
          arguments: {
            id: factId,
            ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
          },
        },
        undefined,
        { signal, timeout: SERENITY_TIMEOUT_MS },
      );
      const body = mcpTextPayload(result);
      if (toolCallIsError(result)) {
        throw new Error(verbErrorMessage(body, "Serenity forget failed"));
      }
      return body;
    });
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Serenity forget returned an unexpected payload" };
    }
    const row = payload as { id?: unknown; expired?: unknown; reason?: unknown };
    if (typeof row.id !== "string" || typeof row.expired !== "boolean") {
      return { ok: false, error: "Serenity forget returned an unexpected payload" };
    }
    return {
      ok: true,
      value: {
        id: row.id,
        expired: row.expired,
        reason: typeof row.reason === "string" ? row.reason : null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity forget failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseRecallFacts(payload: unknown): SerenityRecallFact[] {
  if (!payload || typeof payload !== "object") return [];
  const facts = (payload as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  const parsed: SerenityRecallFact[] = [];
  for (const item of facts) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      fact_id?: unknown;
      fact?: unknown;
      provenance?: unknown;
      kind?: unknown;
      entity_slug?: unknown;
    };
    const fact =
      typeof row.fact === "string" ? row.fact.trim().slice(0, MAX_SERENITY_FACT_CHARS) : "";
    const factId = typeof row.fact_id === "string" ? row.fact_id : "";
    const provenance =
      typeof row.provenance === "string"
        ? row.provenance.trim().slice(0, MAX_SERENITY_PROVENANCE_CHARS)
        : "";
    if (!fact || !factId) continue;
    parsed.push({
      factId,
      fact,
      provenance,
      ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
      ...(row.entity_slug === null || typeof row.entity_slug === "string"
        ? { entitySlug: row.entity_slug }
        : {}),
    });
  }
  return parsed;
}
