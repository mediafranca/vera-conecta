import { describe, expect, it, vi } from "vitest";

import { connectDesktop, forwardCaptureEnvelope, forwardRelayEnvelope, type RelayEnvelope } from "../src/desktop-connector";

const envelope = (overrides: Partial<RelayEnvelope> = {}): RelayEnvelope => ({
  tipo: "sobre",
  request_id: "request-1",
  principal_id: "principal-a",
  alcances: ["read"],
  clase: "lectura",
  cuerpo: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  ...overrides,
});

describe("conector Desktop", () => {
  it("abre el enlace saliente sin exponer Vera y mantiene latidos", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: Event | MessageEvent) => void>();
    const sent: string[] = [];
    let openedUrl = "";
    const socket = {
      addEventListener: (type: string, listener: (event: Event | MessageEvent) => void) => listeners.set(type, listener),
      send: (data: string) => sent.push(data),
      close: vi.fn(),
    };
    const link = connectDesktop({
      relayUrl: "https://conecta.example",
      installationId: "installation-a",
      linkSecret: "link-secret",
      connectionId: "connection-a",
      localMcpUrl: "http://127.0.0.1:4180/mcp",
      credentialFor: async () => null,
      heartbeatMs: 1_000,
      webSocketFactory: (url) => { openedUrl = url; return socket; },
    });
    expect(openedUrl).toContain("wss://conecta.example/v/installation-a/link");
    listeners.get("open")?.(new Event("open"));
    vi.advanceTimersByTime(2_000);
    expect(sent.map((message) => JSON.parse(message).tipo)).toEqual(["latido", "latido", "latido"]);
    link.stop();
    expect(socket.close).toHaveBeenCalledWith(1000, "desktop_stopped");
    vi.useRealTimers();
  });

  it("acusa antes de llamar a Vera y responde con el resultado MCP local", async () => {
    const sent: object[] = [];
    const socket = { send: (data: string) => sent.push(JSON.parse(data)) };
    const localFetch = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));

    await forwardRelayEnvelope(socket, envelope(), {
      localMcpUrl: "http://127.0.0.1:4180/mcp",
      credentialFor: async () => ({ token: "local-a", client: "remote-a" }),
      fetch: localFetch,
    });

    expect(sent[0]).toMatchObject({ tipo: "sobre_acuse", request_id: "request-1" });
    expect(sent[1]).toMatchObject({ tipo: "sobre_respuesta", request_id: "request-1" });
    expect(localFetch).toHaveBeenCalledWith("http://127.0.0.1:4180/mcp", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer local-a", "x-vera-client": "remote-a" }),
    }));
  });

  it("niega localmente cuando no existe una credencial compatible", async () => {
    const sent: any[] = [];
    const localFetch = vi.fn();
    await forwardRelayEnvelope({ send: (data) => sent.push(JSON.parse(data)) }, envelope(), {
      localMcpUrl: "http://127.0.0.1:4180/mcp",
      credentialFor: async () => null,
      fetch: localFetch,
    });
    expect(localFetch).not.toHaveBeenCalled();
    expect(sent[1].payload.error.message).toMatch(/credencial local/);
  });

  it("mantiene aisladas dos instalaciones y sus credenciales", async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), authorization: String((init?.headers as Record<string, string>).authorization) });
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    };
    const socket = { send: () => undefined };

    await Promise.all([
      forwardRelayEnvelope(socket, envelope({ principal_id: "principal-a" }), {
        localMcpUrl: "http://vera-a/mcp",
        credentialFor: async () => ({ token: "token-a", client: "client-a" }),
        fetch: fakeFetch,
      }),
      forwardRelayEnvelope(socket, envelope({ request_id: "request-2", principal_id: "principal-b" }), {
        localMcpUrl: "http://vera-b/mcp",
        credentialFor: async () => ({ token: "token-b", client: "client-b" }),
        fetch: fakeFetch,
      }),
    ]);

    expect(calls).toEqual(expect.arrayContaining([
      { url: "http://vera-a/mcp", authorization: "Bearer token-a" },
      { url: "http://vera-b/mcp", authorization: "Bearer token-b" },
    ]));
    expect(calls).not.toContainEqual({ url: "http://vera-a/mcp", authorization: "Bearer token-b" });
  });

  it("entrega capturas a la puerta local con autoridad exclusiva de captura", async () => {
    const sent: any[] = [];
    const requestedScopes: Array<readonly string[]> = [];
    const localFetch = vi.fn(async () => Response.json({ aceptada: true }, { status: 202 }));
    await forwardCaptureEnvelope({ send: data => sent.push(JSON.parse(data)) }, {
      tipo: "captura",
      request_id: "capture-request",
      principal_id: "clip-a",
      identificador_de_idempotencia: "stable-capture",
      cuerpo: JSON.stringify({ idempotencyKey: "stable-capture", content: "Texto" }),
    }, {
      localMcpUrl: "http://127.0.0.1:4173/mcp",
      localCaptureUrl: "http://127.0.0.1:4173/captures",
      credentialFor: async (_principal, scopes) => {
        requestedScopes.push(scopes);
        return { token: "capture-local", client: "vera-clip" };
      },
      fetch: localFetch,
    });
    expect(requestedScopes).toEqual([["capture"]]);
    expect(localFetch).toHaveBeenCalledWith("http://127.0.0.1:4173/captures", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer capture-local" }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({ tipo: "captura_aceptada", request_id: "capture-request" }));
  });
});
