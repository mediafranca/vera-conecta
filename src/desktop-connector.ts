export interface RelayEnvelope {
  tipo: "sobre";
  request_id: string;
  principal_id: string;
  alcances: string[];
  clase: "lectura" | "escritura";
  cuerpo: string;
}

export interface LocalCredential {
  token: string;
  client: string;
}

export interface ConnectorDependencies {
  localMcpUrl: string;
  credentialFor(principalId: string, scopes: readonly string[]): Promise<LocalCredential | null>;
  fetch?: typeof fetch;
}

export interface RelaySocket {
  send(data: string): void;
}

export interface LiveRelaySocket extends RelaySocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent) => void): void;
  close(code?: number, reason?: string): void;
}

export interface DesktopLinkOptions extends ConnectorDependencies {
  relayUrl: string;
  installationId: string;
  linkSecret: string;
  connectionId: string;
  protocolVersion?: number;
  heartbeatMs?: number;
  webSocketFactory?: (url: string) => LiveRelaySocket;
}

export interface DesktopLink {
  socket: LiveRelaySocket;
  stop(): void;
}

function protocolError(message: string): object {
  return { jsonrpc: "2.0", id: null, error: { code: -32000, message } };
}

export async function forwardRelayEnvelope(
  socket: RelaySocket,
  envelope: RelayEnvelope,
  dependencies: ConnectorDependencies,
): Promise<void> {
  socket.send(JSON.stringify({ tipo: "sobre_acuse", request_id: envelope.request_id }));

  const credential = await dependencies.credentialFor(envelope.principal_id, envelope.alcances);
  if (credential === null) {
    socket.send(JSON.stringify({
      tipo: "sobre_respuesta",
      request_id: envelope.request_id,
      payload: protocolError("No existe una credencial local compatible con esta concesión"),
    }));
    return;
  }

  try {
    const response = await (dependencies.fetch ?? fetch)(dependencies.localMcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-vera-client": credential.client,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: envelope.cuerpo,
    });
    const payload = await response.json().catch(() => protocolError("Vera local devolvió una respuesta ilegible"));
    socket.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: envelope.request_id, payload }));
  } catch {
    socket.send(JSON.stringify({
      tipo: "sobre_respuesta",
      request_id: envelope.request_id,
      payload: protocolError("Vera local no está disponible"),
    }));
  }
}

export function isRelayEnvelope(value: unknown): value is RelayEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RelayEnvelope>;
  return candidate.tipo === "sobre"
    && typeof candidate.request_id === "string"
    && typeof candidate.principal_id === "string"
    && Array.isArray(candidate.alcances)
    && candidate.alcances.every((scope) => typeof scope === "string")
    && (candidate.clase === "lectura" || candidate.clase === "escritura")
    && typeof candidate.cuerpo === "string";
}

export function connectDesktop(options: DesktopLinkOptions): DesktopLink {
  const url = new URL(`/v/${encodeURIComponent(options.installationId)}/link`, options.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("prueba_de_secreto", options.linkSecret);
  url.searchParams.set("version_ofrecida", String(options.protocolVersion ?? 1));
  url.searchParams.set("identificador_efimero", options.connectionId);

  const socket = (options.webSocketFactory ?? ((address) => new WebSocket(address) as unknown as LiveRelaySocket))(url.toString());
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  socket.addEventListener("open", () => {
    heartbeat = setInterval(() => socket.send(JSON.stringify({ tipo: "latido" })), options.heartbeatMs ?? 30_000);
    socket.send(JSON.stringify({ tipo: "latido" }));
  });
  socket.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (isRelayEnvelope(parsed)) void forwardRelayEnvelope(socket, parsed, options);
  });
  const clearHeartbeat = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  };
  socket.addEventListener("close", clearHeartbeat);
  socket.addEventListener("error", clearHeartbeat);

  return {
    socket,
    stop() {
      clearHeartbeat();
      socket.close(1000, "desktop_stopped");
    },
  };
}
