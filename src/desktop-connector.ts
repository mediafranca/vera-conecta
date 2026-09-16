export interface RelayEnvelope {
  tipo: "sobre";
  request_id: string;
  principal_id: string;
  alcances: string[];
  clase: "lectura" | "escritura";
  cuerpo: string;
}

export interface RelayCaptureEnvelope {
  tipo: "captura";
  request_id: string;
  principal_id: string;
  identificador_de_idempotencia: string;
  cuerpo: string;
}

export interface LocalCredential {
  token: string;
  client: string;
}

export interface ConnectorDependencies {
  localMcpUrl: string;
  localCaptureUrl?: string;
  credentialFor(principalId: string, scopes: readonly string[]): Promise<LocalCredential | null>;
  fetch?: typeof fetch;
}

export async function forwardCaptureEnvelope(
  socket: RelaySocket,
  envelope: RelayCaptureEnvelope,
  dependencies: ConnectorDependencies,
): Promise<void> {
  const credential = await dependencies.credentialFor(envelope.principal_id, ["capture"]);
  if (credential === null || !dependencies.localCaptureUrl) {
    socket.send(JSON.stringify({ tipo: "captura_rechazada", request_id: envelope.request_id, payload: { codigo: "acceso_retirado" } }));
    return;
  }
  try {
    const response = await (dependencies.fetch ?? fetch)(dependencies.localCaptureUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-vera-client": credential.client,
        "content-type": "application/json",
      },
      body: envelope.cuerpo,
    });
    const payload = await response.json().catch(() => ({ aceptada: response.ok }));
    socket.send(JSON.stringify({
      tipo: response.ok ? "captura_aceptada" : "captura_rechazada",
      request_id: envelope.request_id,
      payload,
    }));
  } catch {
    socket.send(JSON.stringify({ tipo: "captura_rechazada", request_id: envelope.request_id, payload: { codigo: "vera_no_disponible" } }));
  }
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

export type DesktopConnectionStatus = "detenida" | "conectando" | "conectada" | "esperando";

export interface DesktopSupervisorOptions extends Omit<DesktopLinkOptions, "connectionId"> {
  connectionId?: () => string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  onStatus?: (status: DesktopConnectionStatus) => void;
}

export interface DesktopSupervisor {
  status(): DesktopConnectionStatus;
  start(): void;
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

export function isRelayCaptureEnvelope(value: unknown): value is RelayCaptureEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RelayCaptureEnvelope>;
  return candidate.tipo === "captura"
    && typeof candidate.request_id === "string"
    && typeof candidate.principal_id === "string"
    && typeof candidate.identificador_de_idempotencia === "string"
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
    if (isRelayCaptureEnvelope(parsed)) void forwardCaptureEnvelope(socket, parsed, options);
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

/**
 * Mantiene exactamente un enlace saliente durante la vida de Vera Desktop.
 * Una caída espera antes de volver: nunca hace un bucle apretado ni mantiene
 * un temporizador después del apagado de la aplicación.
 */
export function superviseDesktop(options: DesktopSupervisorOptions): DesktopSupervisor {
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const random = options.random ?? Math.random;
  const connectionId = options.connectionId ?? (() => crypto.randomUUID());
  const base = Math.max(1, options.reconnectBaseMs ?? 1_000);
  const maximum = Math.max(base, options.reconnectMaxMs ?? 30_000);
  let currentStatus: DesktopConnectionStatus = "detenida";
  let current: DesktopLink | null = null;
  let retry: ReturnType<typeof globalThis.setTimeout> | null = null;
  let failures = 0;
  let running = false;

  const report = (status: DesktopConnectionStatus): void => {
    if (currentStatus === status) return;
    currentStatus = status;
    options.onStatus?.(status);
  };

  const clearRetry = (): void => {
    if (retry !== null) cancel(retry);
    retry = null;
  };

  const reconnect = (): void => {
    if (!running || retry !== null) return;
    current = null;
    failures += 1;
    const ceiling = Math.min(maximum, base * 2 ** (failures - 1));
    const delay = Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
    report("esperando");
    retry = schedule(() => {
      retry = null;
      open();
    }, delay);
  };

  const open = (): void => {
    if (!running || current !== null) return;
    report("conectando");
    const link = connectDesktop({ ...options, connectionId: connectionId() });
    current = link;
    link.socket.addEventListener("open", () => {
      if (current !== link || !running) return;
      failures = 0;
      report("conectada");
    });
    link.socket.addEventListener("close", () => {
      if (current !== link) return;
      reconnect();
    });
    link.socket.addEventListener("error", () => {
      if (current !== link) return;
      reconnect();
    });
  };

  return {
    status: () => currentStatus,
    start() {
      if (running) return;
      running = true;
      open();
    },
    stop() {
      if (!running && currentStatus === "detenida") return;
      running = false;
      clearRetry();
      const link = current;
      current = null;
      link?.stop();
      failures = 0;
      report("detenida");
    },
  };
}
