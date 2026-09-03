import { DurableObject } from "cloudflare:workers";
import { hashWithPepper, randomToken, timingSafeEqualStrings, verifyWithPepper } from "./crypto";

export interface Env {
  INSTALLATIONS: DurableObjectNamespace<InstallationRelay>;
  VERA_CONECTA_TOKEN_PEPPER: string;
}

// specs/installation-link.allium § config
const VIGENCIA_DEL_DESAFIO_MS = 10 * 60_000;
const SOLAPAMIENTO_DE_ROTACION_MS = 5 * 60_000;
const UMBRAL_DE_LATIDO_MS = 60_000;
const BITS_ENTROPIA_ID_PUBLICO = 128;
const BITS_ENTROPIA_SECRETO = 256;
const VERSION_MINIMA_ADMITIDA = 1;
const VERSION_MAXIMA_ADMITIDA = 1;
const ALARM_TICK_MS = 15_000;

// specs/client-grants.allium § config
const VIGENCIA_DE_AUTORIZACION_PENDIENTE_MS = 10 * 60_000;
const VIGENCIA_DE_CREDENCIAL_DE_ACCESO_MS = 60 * 60_000;
const VENTANA_DE_REFRESCO_MS = 90 * 24 * 60 * 60_000;
const BITS_ENTROPIA_CREDENCIAL = 256;
const ALCANCES_VALIDOS = ["read", "write", "delete"] as const;
type Alcance = (typeof ALCANCES_VALIDOS)[number];
const EVIDENCIAS_VALIDAS = ["bearer_del_piloto", "confirmacion_en_desktop", "oauth_con_consentimiento_explicito"] as const;
type Evidencia = (typeof EVIDENCIAS_VALIDAS)[number];

// specs/mcp-relay.allium § config
const PLAZO_DE_SOLICITUD_MS = 120_000;
const PLAZO_DE_ESCRITURA_MS = 15 * 60_000;
const MAX_CONCURRENTES_POR_INSTALACION = 32;
const MAX_CONCURRENTES_POR_CLIENTE = 8;
const BYTES_MAXIMOS_POR_SOLICITUD = 10_485_760;
const MAX_REINTENTOS_DE_LECTURA = 1;
const BITS_ENTROPIA_REQUEST_ID = 128;
const BITS_ENTROPIA_IDENTIFICADOR_DE_SESION = 128;

type ClaseDeOperacion = "lectura" | "escritura";
type CodigoPublico =
  | "no_autenticada"
  | "sin_alcance"
  | "instalacion_desconocida"
  | "conflicto_de_enlace"
  | "excede_limite"
  | "cuota_agotada"
  | "escrituras_suspendidas"
  | "vera_offline"
  | "plazo_agotado";

const CODIGO_HTTP: Record<CodigoPublico, number> = {
  no_autenticada: 401,
  sin_alcance: 403,
  instalacion_desconocida: 404,
  conflicto_de_enlace: 409,
  excede_limite: 413,
  cuota_agotada: 429,
  escrituras_suspendidas: 503,
  vera_offline: 503,
  plazo_agotado: 504,
};

// Métodos MCP de sólo lectura por convención del protocolo (discovery,
// negociación, notificaciones). El relay no inspecciona el contenido de la
// solicitud (specs/mcp-relay.allium lo excluye explícitamente), así que
// cualquier método no reconocido —empezando por tools/call, cuyo efecto real
// el relay no puede conocer sin mirar dentro— se clasifica como escritura por
// defecto. Es una decisión de implementación, no una decisión de la spec:
// conviene revisarla si aparecen herramientas de sólo lectura que deban
// clasificarse aparte.
const METODOS_MCP_DE_LECTURA = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);

function clasificarMetodoMcp(metodo: string): { clase: ClaseDeOperacion; alcance: Alcance } {
  if (metodo.startsWith("notifications/") || METODOS_MCP_DE_LECTURA.has(metodo)) {
    return { clase: "lectura", alcance: "read" };
  }
  return { clase: "escritura", alcance: "write" };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

interface DesafioRow extends Record<string, SqlStorageValue> {
  hash_del_codigo: string;
  estado: "pendiente" | "reclamado" | "caducado";
  expira_en: number;
  version_ofrecida: number;
}

interface InstalacionRow extends Record<string, SqlStorageValue> {
  id_publico: string;
  estado: "emparejando" | "conectada" | "desconectada" | "revocada";
}

interface LinkAttachment {
  identificador_efimero: string;
}

interface ClienteRow extends Record<string, SqlStorageValue> {
  principal_id: string;
  etiqueta_de_aplicacion: string;
  estado: "pendiente" | "autorizado" | "credencial_vencida" | "revocado" | "expirado";
  creado_en: number;
  expira_en: number | null;
  refresco_expira_en: number | null;
}

interface SesionMcpRow extends Record<string, SqlStorageValue> {
  identificador: string;
  cliente_principal_id: string;
  estado: "abierta" | "cerrada";
}

interface SolicitudMcpRow extends Record<string, SqlStorageValue> {
  request_id: string;
  cliente_principal_id: string;
  sesion_identificador: string | null;
  clase: ClaseDeOperacion;
  alcance_requerido: Alcance;
  plazo_en: number;
  acusada: number;
  reintentos: number;
  estado: "entregada" | "respondida" | "resultado_incierto" | "vera_desconectada";
  entregada_por_identificador_efimero: string | null;
}

interface SolicitudMcpPendiente {
  resolve: (respuesta: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class InstallationRelay extends DurableObject<Env> {
  // Correlaciona una solicitud MCP en vuelo con la Response HTTP que la
  // originó. No persiste: si el objeto se recicla mientras una solicitud
  // sigue "entregada", el respaldo es el barrido de alarm() (ver
  // PlazoAgotadoTrasEntrega), aunque en ese caso ya no hay un llamador HTTP
  // a quien responder.
  private readonly solicitudesMcpPendientes = new Map<string, SolicitudMcpPendiente>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS desafios (
      hash_del_codigo TEXT PRIMARY KEY,
      estado TEXT NOT NULL,
      emitido_en INTEGER NOT NULL,
      expira_en INTEGER NOT NULL,
      version_ofrecida INTEGER NOT NULL,
      instalacion_id_publico TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS instalacion (
      id_publico TEXT PRIMARY KEY,
      estado TEXT NOT NULL,
      creada_en INTEGER NOT NULL,
      id_publico_rotado_en INTEGER,
      revocada_en INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS secretos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      emitido_en INTEGER NOT NULL,
      estado TEXT NOT NULL,
      solapamiento_expira_en INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS conexiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identificador_efimero TEXT NOT NULL,
      version_negociada INTEGER NOT NULL,
      abierta_en INTEGER NOT NULL,
      ultimo_latido_en INTEGER NOT NULL,
      estado TEXT NOT NULL,
      cerrada_en INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS clientes (
      principal_id TEXT PRIMARY KEY,
      etiqueta_de_aplicacion TEXT NOT NULL,
      estado TEXT NOT NULL,
      creado_en INTEGER NOT NULL,
      expira_en INTEGER,
      hash_de_credencial TEXT,
      hash_de_refresco TEXT,
      refresco_expira_en INTEGER,
      revocado_en INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS concesiones (
      cliente_principal_id TEXT PRIMARY KEY,
      alcances TEXT NOT NULL,
      otorgada_en INTEGER NOT NULL,
      evidencia TEXT NOT NULL,
      estado TEXT NOT NULL,
      retirada_en INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS sesiones_mcp (
      identificador TEXT PRIMARY KEY,
      cliente_principal_id TEXT NOT NULL,
      abierta_en INTEGER NOT NULL,
      estado TEXT NOT NULL,
      cerrada_en INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS solicitudes_mcp (
      request_id TEXT PRIMARY KEY,
      cliente_principal_id TEXT NOT NULL,
      sesion_identificador TEXT,
      clase TEXT NOT NULL,
      alcance_requerido TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      recibida_en INTEGER NOT NULL,
      plazo_en INTEGER NOT NULL,
      acusada INTEGER NOT NULL DEFAULT 0,
      reintentos INTEGER NOT NULL DEFAULT 0,
      estado TEXT NOT NULL,
      entregada_por_identificador_efimero TEXT,
      respondida_en INTEGER,
      codigo TEXT
    )`);
    // Sliver mínimo de service-operations.allium: sólo el interruptor manual
    // que mcp-relay necesita (clase_admitida_ahora). La degradación
    // automática por umbral sigue siendo una pregunta abierta de esa spec —
    // no se implementa acá.
    sql.exec(`CREATE TABLE IF NOT EXISTS servicio (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      escrituras_admitidas INTEGER NOT NULL DEFAULT 1
    )`);
    sql.exec(`INSERT OR IGNORE INTO servicio (id, escrituras_admitidas) VALUES (1, 1)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/pairings") {
      return this.emitirDesafio(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/pairings/claim") {
      return this.reclamarDesafio(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/provision") {
      return this.provisionar(request);
    }
    if (request.method === "GET" && url.pathname === "/internal/link") {
      return this.abrirCanal(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/rotate") {
      return this.rotarSecreto(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/rotate/confirm") {
      return this.confirmarRotacion(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/revoke") {
      return this.revocar(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/clients") {
      return this.autorizarCliente(request);
    }
    if (request.method === "GET" && url.pathname === "/internal/clients") {
      return this.listarClientes();
    }
    const claimClienteMatch = url.pathname.match(/^\/internal\/clients\/([^/]+)\/claim$/);
    if (request.method === "POST" && claimClienteMatch) {
      return this.reclamarCredencialDeCliente(request, claimClienteMatch[1]);
    }
    const refreshClienteMatch = url.pathname.match(/^\/internal\/clients\/([^/]+)\/refresh$/);
    if (request.method === "POST" && refreshClienteMatch) {
      return this.refrescarCredencialDeCliente(request, refreshClienteMatch[1]);
    }
    const revokeClienteMatch = url.pathname.match(/^\/internal\/clients\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revokeClienteMatch) {
      return this.revocarCliente(request, revokeClienteMatch[1]);
    }
    if (request.method === "POST" && url.pathname === "/internal/mcp") {
      return this.aceptarSolicitudMcp(request);
    }
    if (request.method === "DELETE" && url.pathname === "/internal/mcp") {
      return this.cerrarSesionMcpPorHeader(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/servicio") {
      return this.actualizarServicio(request);
    }
    return json(404, { error: "ruta_interna_desconocida" });
  }

  // rule EmitirDesafioDeEmparejamiento
  private async emitirDesafio(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { version_ofrecida?: unknown } | null;
    const versionOfrecida = body?.version_ofrecida;
    if (typeof versionOfrecida !== "number" || !Number.isInteger(versionOfrecida)) {
      return json(400, { error: "version_ofrecida_invalida" });
    }

    const codigo = randomToken(BITS_ENTROPIA_SECRETO);
    const hash = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, codigo);
    const now = Date.now();
    const expiraEn = now + VIGENCIA_DEL_DESAFIO_MS;

    this.ctx.storage.sql.exec(
      `INSERT INTO desafios (hash_del_codigo, estado, emitido_en, expira_en, version_ofrecida)
       VALUES (?, 'pendiente', ?, ?, ?)`,
      hash,
      now,
      expiraEn,
      versionOfrecida,
    );
    await this.scheduleNextAlarm();

    return json(201, { codigo, expira_en: new Date(expiraEn).toISOString() });
  }

  // rule ReclamarEmparejamiento
  private async reclamarDesafio(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { codigo?: unknown } | null;
    const codigo = body?.codigo;
    if (typeof codigo !== "string" || codigo.length === 0) {
      return json(400, { error: "codigo_invalido" });
    }

    const hash = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, codigo);
    const now = Date.now();
    const desafio = this.ctx.storage.sql
      .exec<DesafioRow>(
        `SELECT hash_del_codigo, estado, expira_en, version_ofrecida FROM desafios WHERE hash_del_codigo = ?`,
        hash,
      )
      .toArray()[0];

    if (!desafio) {
      return json(404, { error: "desafio_no_encontrado" });
    }
    if (desafio.estado !== "pendiente") {
      return json(409, { error: "desafio_ya_resuelto" });
    }
    if (desafio.expira_en <= now) {
      this.ctx.storage.sql.exec(`UPDATE desafios SET estado = 'caducado' WHERE hash_del_codigo = ?`, hash);
      return json(410, { error: "desafio_caducado" });
    }

    // Reserva atómica antes de aprovisionar: sin esto, dos reclamos concurrentes
    // con el mismo código podrían aprovisionar dos instalaciones.
    const reserva = this.ctx.storage.sql.exec(
      `UPDATE desafios SET estado = 'reclamado' WHERE hash_del_codigo = ? AND estado = 'pendiente'`,
      hash,
    );
    if (reserva.rowsWritten !== 1) {
      return json(409, { error: "desafio_ya_resuelto" });
    }

    const idPublico = randomToken(BITS_ENTROPIA_ID_PUBLICO);
    const secreto = randomToken(BITS_ENTROPIA_SECRETO);
    const secretoHash = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, secreto);

    const instalacionStub = this.env.INSTALLATIONS.get(this.env.INSTALLATIONS.idFromName(idPublico));
    const provisionResponse = await instalacionStub.fetch("http://do/internal/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id_publico: idPublico,
        creada_en: now,
        secreto_hash: secretoHash,
        secreto_emitido_en: now,
      }),
    });
    if (!provisionResponse.ok) {
      return json(502, { error: "aprovisionamiento_fallido" });
    }

    this.ctx.storage.sql.exec(
      `UPDATE desafios SET instalacion_id_publico = ? WHERE hash_del_codigo = ?`,
      idPublico,
      hash,
    );

    return json(201, {
      id_publico: idPublico,
      secreto_de_enlace: secreto,
      version_ofrecida: desafio.version_ofrecida,
    });
  }

  // Aprovisiona la Instalacion + SecretoDeEnlace creados por ReclamarEmparejamiento
  // dentro del Durable Object que le corresponde a este id_publico.
  private async provisionar(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      id_publico?: unknown;
      creada_en?: unknown;
      secreto_hash?: unknown;
      secreto_emitido_en?: unknown;
    } | null;

    if (
      typeof body?.id_publico !== "string" ||
      typeof body?.creada_en !== "number" ||
      typeof body?.secreto_hash !== "string" ||
      typeof body?.secreto_emitido_en !== "number"
    ) {
      return json(400, { error: "aprovisionamiento_invalido" });
    }

    const yaExiste = this.ctx.storage.sql.exec(`SELECT id_publico FROM instalacion LIMIT 1`).toArray();
    if (yaExiste.length > 0) {
      return json(409, { error: "instalacion_ya_existe" });
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO instalacion (id_publico, estado, creada_en) VALUES (?, 'emparejando', ?)`,
      body.id_publico,
      body.creada_en,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO secretos (hash, emitido_en, estado) VALUES (?, ?, 'vigente')`,
      body.secreto_hash,
      body.secreto_emitido_en,
    );
    await this.scheduleNextAlarm();

    return json(201, { ok: true });
  }

  // rules AbrirCanalDeEnlace, ConexionNuevaDesplazaAnterior,
  // RechazarCanalPorCredencial, RechazarCanalPorVersion
  private async abrirCanal(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json(400, { error: "se_esperaba_websocket" });
    }

    const url = new URL(request.url);
    const pruebaDeSecreto = url.searchParams.get("prueba_de_secreto");
    const identificadorEfimero = url.searchParams.get("identificador_efimero");
    const versionOfrecida = Number(url.searchParams.get("version_ofrecida"));

    if (!pruebaDeSecreto || !identificadorEfimero || !Number.isInteger(versionOfrecida)) {
      return json(400, { error: "parametros_de_enlace_invalidos" });
    }

    // rule RechazarCanalPorVersion — no depende de que la instalación exista.
    if (versionOfrecida < VERSION_MINIMA_ADMITIDA || versionOfrecida > VERSION_MAXIMA_ADMITIDA) {
      return json(400, { error: "version_de_protocolo_incompatible" });
    }

    const instalacion = this.leerInstalacion();
    // rule RechazarCanalPorCredencial — instalación inexistente y revocada son
    // indistinguibles: ambas carecen de secretos_utilizables verificables.
    const secretosUtilizables = instalacion
      ? this.ctx.storage.sql
          .exec<{ hash: string }>(`SELECT hash FROM secretos WHERE estado IN ('vigente', 'solapado')`)
          .toArray()
      : [];

    let acreditado = false;
    for (const secreto of secretosUtilizables) {
      if (await verifyWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, pruebaDeSecreto, secreto.hash)) {
        acreditado = true;
        break;
      }
    }
    if (!instalacion || !acreditado) {
      return json(401, { error: "credencial_de_enlace_invalida" });
    }

    const now = Date.now();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["link"]);
    server.serializeAttachment({ identificador_efimero: identificadorEfimero } satisfies LinkAttachment);

    if (instalacion.estado === "conectada") {
      // rule ConexionNuevaDesplazaAnterior
      const desplazados: string[] = [];
      for (const ws of this.ctx.getWebSockets("link")) {
        if (ws === server) continue;
        const attachment = ws.deserializeAttachment() as LinkAttachment | null;
        if (attachment?.identificador_efimero) desplazados.push(attachment.identificador_efimero);
        ws.close(4000, "enlace_desplazado");
      }
      this.ctx.storage.sql.exec(
        `UPDATE conexiones SET estado = 'desplazada', cerrada_en = ? WHERE estado = 'activa'`,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO conexiones (identificador_efimero, version_negociada, abierta_en, ultimo_latido_en, estado)
         VALUES (?, ?, ?, ?, 'activa')`,
        identificadorEfimero,
        versionOfrecida,
        now,
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE instalacion SET estado = 'conectada' WHERE id_publico = ?`, instalacion.id_publico);
      // specs/mcp-relay.allium rules ReintentarLecturaNoAcusada,
      // EntregaDesplazadaQuedaIncierta — corre después de que la conexión
      // nueva ya está aceptada, para poder reentregar sobre ella.
      for (const identificadorAnterior of desplazados) {
        this.manejarDesplazamientoDeSolicitudes(identificadorAnterior);
      }
      await this.scheduleNextAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO conexiones (identificador_efimero, version_negociada, abierta_en, ultimo_latido_en, estado)
       VALUES (?, ?, ?, ?, 'activa')`,
      identificadorEfimero,
      versionOfrecida,
      now,
      now,
    );
    this.ctx.storage.sql.exec(`UPDATE instalacion SET estado = 'conectada' WHERE id_publico = ?`, instalacion.id_publico);
    await this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Credencial compartida por rotate/rotate-confirm/revoke: misma prueba de
  // posesión del secreto que abre el canal, pero por HTTP y sin exigir que
  // haya un WebSocket abierto (ver surface ControlDeInstalacion).
  private async leerCredencialDesdeBody(request: Request): Promise<InstalacionRow | null> {
    const body = (await request.json().catch(() => null)) as { prueba_de_secreto?: unknown } | null;
    const pruebaDeSecreto = body?.prueba_de_secreto;
    if (typeof pruebaDeSecreto !== "string" || pruebaDeSecreto.length === 0) return null;
    return this.verificarSecretoDeEnlace(pruebaDeSecreto);
  }

  // rule RotarSecretoDeEnlace
  private async rotarSecreto(request: Request): Promise<Response> {
    const instalacion = await this.leerCredencialDesdeBody(request);
    if (!instalacion) return json(401, { error: "credencial_de_enlace_invalida" });
    if (instalacion.estado !== "conectada" && instalacion.estado !== "desconectada") {
      return json(409, { error: "instalacion_no_permite_rotacion" });
    }

    const vigentes = this.ctx.storage.sql.exec(`SELECT id FROM secretos WHERE estado = 'vigente'`).toArray();
    if (vigentes.length === 0) return json(409, { error: "sin_secreto_vigente" });

    const now = Date.now();
    const solapamientoExpiraEn = now + SOLAPAMIENTO_DE_ROTACION_MS;
    this.ctx.storage.sql.exec(
      `UPDATE secretos SET estado = 'solapado', solapamiento_expira_en = ? WHERE estado = 'vigente'`,
      solapamientoExpiraEn,
    );

    const nuevoSecreto = randomToken(BITS_ENTROPIA_SECRETO);
    const nuevoHash = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, nuevoSecreto);
    this.ctx.storage.sql.exec(`INSERT INTO secretos (hash, emitido_en, estado) VALUES (?, ?, 'vigente')`, nuevoHash, now);
    await this.scheduleNextAlarm();

    return json(201, {
      secreto_de_enlace: nuevoSecreto,
      solapamiento_expira_en: new Date(solapamientoExpiraEn).toISOString(),
    });
  }

  // rule DesktopConfirmaRotacion
  private async confirmarRotacion(request: Request): Promise<Response> {
    const instalacion = await this.leerCredencialDesdeBody(request);
    if (!instalacion) return json(401, { error: "credencial_de_enlace_invalida" });

    const solapados = this.ctx.storage.sql.exec(`SELECT id FROM secretos WHERE estado = 'solapado'`).toArray();
    if (solapados.length === 0) return json(409, { error: "sin_secreto_solapado" });

    this.ctx.storage.sql.exec(
      `UPDATE secretos SET estado = 'invalidado', solapamiento_expira_en = NULL WHERE estado = 'solapado'`,
    );
    return json(200, { ok: true });
  }

  // rule RevocarInstalacion
  private async revocar(request: Request): Promise<Response> {
    const instalacion = await this.leerCredencialDesdeBody(request);
    if (!instalacion) return json(401, { error: "credencial_de_enlace_invalida" });
    if (instalacion.estado === "revocada") {
      return json(409, { error: "instalacion_ya_revocada" });
    }

    const now = Date.now();
    for (const ws of this.ctx.getWebSockets("link")) {
      ws.close(4002, "instalacion_revocada");
    }
    this.ctx.storage.sql.exec(
      `UPDATE instalacion SET estado = 'revocada', revocada_en = ? WHERE id_publico = ?`,
      now,
      instalacion.id_publico,
    );
    this.ctx.storage.sql.exec(
      `UPDATE secretos SET estado = 'invalidado', solapamiento_expira_en = NULL WHERE estado IN ('vigente', 'solapado')`,
    );
    this.ctx.storage.sql.exec(`UPDATE conexiones SET estado = 'cerrada', cerrada_en = ? WHERE estado = 'activa'`, now);

    // rules RevocarClientesPendientesAlRevocarInstalacion,
    // RevocarClientesAutorizadosAlRevocarInstalacion,
    // RevocarClientesConCredencialVencidaAlRevocarInstalacion — revocar la
    // instalación arrastra a todos sus clientes, sin excepción.
    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'revocado', revocado_en = ?, expira_en = NULL,
           hash_de_credencial = NULL, hash_de_refresco = NULL, refresco_expira_en = NULL
       WHERE estado IN ('pendiente', 'autorizado', 'credencial_vencida')`,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE concesiones SET estado = 'retirada', retirada_en = ? WHERE estado = 'vigente'`,
      now,
    );
    // specs/mcp-relay.allium rule CerrarSesionesAlTerminarElAcceso — revocar
    // la instalación termina el acceso de todos sus clientes a la vez.
    this.ctx.storage.sql.exec(
      `UPDATE sesiones_mcp SET estado = 'cerrada', cerrada_en = ? WHERE estado = 'abierta'`,
      now,
    );

    return json(200, { ok: true });
  }

  // rule AutorizarCliente
  private async autorizarCliente(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      prueba_de_secreto?: unknown;
      etiqueta_de_aplicacion?: unknown;
      alcances?: unknown;
      evidencia?: unknown;
    } | null;

    const pruebaDeSecreto = body?.prueba_de_secreto;
    if (typeof pruebaDeSecreto !== "string" || pruebaDeSecreto.length === 0) {
      return json(401, { error: "credencial_de_enlace_invalida" });
    }
    const instalacion = await this.verificarSecretoDeEnlace(pruebaDeSecreto);
    if (!instalacion) return json(401, { error: "credencial_de_enlace_invalida" });
    if (instalacion.estado !== "conectada" && instalacion.estado !== "desconectada") {
      return json(409, { error: "instalacion_no_permite_autorizar_clientes" });
    }

    const etiqueta = body?.etiqueta_de_aplicacion;
    if (typeof etiqueta !== "string" || etiqueta.length === 0) {
      return json(400, { error: "etiqueta_de_aplicacion_invalida" });
    }
    const alcances = this.validarAlcances(body?.alcances);
    if (!alcances) return json(400, { error: "alcances_invalidos" });
    const evidencia = this.validarEvidencia(body?.evidencia);
    if (!evidencia) return json(400, { error: "evidencia_invalida" });

    const now = Date.now();
    const expiraEn = now + VIGENCIA_DE_AUTORIZACION_PENDIENTE_MS;
    const principalId = randomToken(BITS_ENTROPIA_CREDENCIAL);

    this.ctx.storage.sql.exec(
      `INSERT INTO clientes (principal_id, etiqueta_de_aplicacion, estado, creado_en, expira_en)
       VALUES (?, ?, 'pendiente', ?, ?)`,
      principalId,
      etiqueta,
      now,
      expiraEn,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO concesiones (cliente_principal_id, alcances, otorgada_en, evidencia, estado)
       VALUES (?, ?, ?, ?, 'vigente')`,
      principalId,
      alcances.join(","),
      now,
      evidencia,
    );
    await this.scheduleNextAlarm();

    return json(201, {
      principal_id: principalId,
      etiqueta_de_aplicacion: etiqueta,
      alcances,
      expira_en: new Date(expiraEn).toISOString(),
    });
  }

  // rule EmitirCredencialDeCliente — entrega credencial de acceso (1h) y de
  // refresco (90 días) de una vez; sólo la primera se vuelve a emitir sola en
  // refrescarCredencialDeCliente.
  private async reclamarCredencialDeCliente(request: Request, principalId: string): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { prueba_de_consentimiento?: unknown } | null;
    const pruebaDeConsentimiento = body?.prueba_de_consentimiento;
    if (typeof pruebaDeConsentimiento !== "string" || !timingSafeEqualStrings(pruebaDeConsentimiento, principalId)) {
      return json(401, { error: "consentimiento_invalido" });
    }

    const cliente = this.leerCliente(principalId);
    if (!cliente) return json(404, { error: "cliente_no_encontrado" });
    if (cliente.estado !== "pendiente") return json(409, { error: "cliente_no_esta_pendiente" });
    if (!cliente.expira_en || cliente.expira_en <= Date.now()) {
      return json(410, { error: "autorizacion_caducada" });
    }

    const now = Date.now();
    const expiraEn = now + VIGENCIA_DE_CREDENCIAL_DE_ACCESO_MS;
    const refrescoExpiraEn = now + VENTANA_DE_REFRESCO_MS;
    const secretoDeAcceso = randomToken(BITS_ENTROPIA_CREDENCIAL);
    const secretoDeRefresco = randomToken(BITS_ENTROPIA_CREDENCIAL);
    const hashDeAcceso = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, secretoDeAcceso);
    const hashDeRefresco = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, secretoDeRefresco);

    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'autorizado', hash_de_credencial = ?, expira_en = ?,
           hash_de_refresco = ?, refresco_expira_en = ?
       WHERE principal_id = ?`,
      hashDeAcceso,
      expiraEn,
      hashDeRefresco,
      refrescoExpiraEn,
      principalId,
    );
    await this.scheduleNextAlarm();

    const concesion = this.leerConcesion(principalId);
    return json(201, {
      secreto_de_cliente: secretoDeAcceso,
      secreto_de_refresco: secretoDeRefresco,
      alcances: concesion?.alcances.split(",") ?? [],
      expira_en: new Date(expiraEn).toISOString(),
      refresco_expira_en: new Date(refrescoExpiraEn).toISOString(),
    });
  }

  // rule RefrescarCredencialDeCliente — no reabre consentimiento ni alcances:
  // sólo repone la credencial de acceso mientras la de refresco siga viva.
  private async refrescarCredencialDeCliente(request: Request, principalId: string): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { prueba_de_refresco?: unknown } | null;
    const pruebaDeRefresco = body?.prueba_de_refresco;
    if (typeof pruebaDeRefresco !== "string" || pruebaDeRefresco.length === 0) {
      return json(401, { error: "refresco_invalido" });
    }

    const cliente = this.leerCliente(principalId);
    if (!cliente) return json(404, { error: "cliente_no_encontrado" });
    if (cliente.estado !== "credencial_vencida") return json(409, { error: "cliente_no_tiene_credencial_vencida" });
    if (!cliente.refresco_expira_en || cliente.refresco_expira_en <= Date.now()) {
      return json(410, { error: "ventana_de_refresco_agotada" });
    }

    const hashDeRefrescoActual = this.leerHashDeRefresco(principalId);
    if (!hashDeRefrescoActual || !(await verifyWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, pruebaDeRefresco, hashDeRefrescoActual))) {
      return json(401, { error: "refresco_invalido" });
    }

    const now = Date.now();
    const expiraEn = now + VIGENCIA_DE_CREDENCIAL_DE_ACCESO_MS;
    const secretoDeAcceso = randomToken(BITS_ENTROPIA_CREDENCIAL);
    const hashDeAcceso = await hashWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, secretoDeAcceso);

    this.ctx.storage.sql.exec(
      `UPDATE clientes SET estado = 'autorizado', hash_de_credencial = ?, expira_en = ? WHERE principal_id = ?`,
      hashDeAcceso,
      expiraEn,
      principalId,
    );
    await this.scheduleNextAlarm();

    const concesion = this.leerConcesion(principalId);
    return json(201, {
      secreto_de_cliente: secretoDeAcceso,
      alcances: concesion?.alcances.split(",") ?? [],
      expira_en: new Date(expiraEn).toISOString(),
    });
  }

  // rules RevocarClientePendiente, RevocarClienteAutorizado,
  // RevocarClienteConCredencialVencida
  private async revocarCliente(request: Request, principalId: string): Promise<Response> {
    const instalacion = await this.leerCredencialDesdeBody(request);
    if (!instalacion) return json(401, { error: "credencial_de_enlace_invalida" });

    const cliente = this.leerCliente(principalId);
    if (!cliente) return json(404, { error: "cliente_no_encontrado" });
    if (cliente.estado !== "pendiente" && cliente.estado !== "autorizado" && cliente.estado !== "credencial_vencida") {
      return json(409, { error: "cliente_no_revocable" });
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'revocado', revocado_en = ?, expira_en = NULL,
           hash_de_credencial = NULL, hash_de_refresco = NULL, refresco_expira_en = NULL
       WHERE principal_id = ?`,
      now,
      principalId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE concesiones SET estado = 'retirada', retirada_en = ? WHERE cliente_principal_id = ?`,
      now,
      principalId,
    );
    // specs/mcp-relay.allium rule CerrarSesionesAlTerminarElAcceso
    this.cerrarSesionesMcpDelCliente(principalId);

    return json(200, { ok: true });
  }

  private async listarClientes(): Promise<Response> {
    const clientes = this.ctx.storage.sql
      .exec<ClienteRow>(
        `SELECT principal_id, etiqueta_de_aplicacion, estado, creado_en, expira_en, refresco_expira_en FROM clientes`,
      )
      .toArray();
    const concesiones = this.ctx.storage.sql
      .exec<{ cliente_principal_id: string; alcances: string; evidencia: string }>(
        `SELECT cliente_principal_id, alcances, evidencia FROM concesiones`,
      )
      .toArray();
    const alcancesPorCliente = new Map(concesiones.map((c) => [c.cliente_principal_id, c]));

    return json(200, {
      clientes: clientes.map((c) => ({
        principal_id: c.principal_id,
        etiqueta_de_aplicacion: c.etiqueta_de_aplicacion,
        estado: c.estado,
        creado_en: new Date(c.creado_en).toISOString(),
        expira_en:
          (c.estado === "pendiente" || c.estado === "autorizado") && c.expira_en
            ? new Date(c.expira_en).toISOString()
            : null,
        refresco_expira_en:
          (c.estado === "autorizado" || c.estado === "credencial_vencida") && c.refresco_expira_en
            ? new Date(c.refresco_expira_en).toISOString()
            : null,
        alcances: alcancesPorCliente.get(c.principal_id)?.alcances.split(",") ?? [],
        evidencia: alcancesPorCliente.get(c.principal_id)?.evidencia ?? null,
      })),
    });
  }

  // ---------------------------------------------------------------------
  // specs/mcp-relay.allium
  // ---------------------------------------------------------------------

  // rules AceptarSolicitudMcp, RechazarPorTamano, RechazarPorOrigen,
  // RechazarPorInstalacionNoUtilizable, RechazarPorCredencial,
  // RechazarPorAlcance, RechazarEscrituraSuspendida, RechazarPorCuota,
  // AutenticarSolicitud, EntregarSolicitud, VeraNoConectadaAlEntregar.
  // El rechazo se evalúa en el mismo orden que la spec declara las reglas:
  // cada motivo asume que los anteriores ya no aplican.
  private async aceptarSolicitudMcp(request: Request): Promise<Response> {
    const bodyText = await request.text();
    const bytes = new TextEncoder().encode(bodyText).length;

    // RechazarPorTamano — se comprueba antes de deserializar nada.
    if (bytes > BYTES_MAXIMOS_POR_SOLICITUD) {
      return this.respuestaMcpRechazada("excede_limite");
    }

    if (!this.esOrigenAdmitido(request.headers.get("Origin"))) {
      return this.respuestaMcpRechazada("sin_alcance");
    }

    const instalacion = this.leerInstalacion();
    const instalacionUtilizable = !!instalacion && (instalacion.estado === "conectada" || instalacion.estado === "desconectada");
    if (!instalacionUtilizable) {
      return this.respuestaMcpRechazada("instalacion_desconocida");
    }

    const auth = request.headers.get("Authorization");
    const credencial = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    const cliente = credencial ? await this.clientePorCredencialDeAcceso(credencial) : null;
    if (!cliente) {
      return this.respuestaMcpRechazada("no_autenticada");
    }

    let cuerpo: { method?: unknown } | null;
    try {
      cuerpo = bodyText.length > 0 ? (JSON.parse(bodyText) as { method?: unknown }) : null;
    } catch {
      cuerpo = null;
    }
    const metodo = typeof cuerpo?.method === "string" ? cuerpo.method : "";
    const { clase, alcance } = clasificarMetodoMcp(metodo);

    const concesion = this.leerConcesion(cliente.principal_id);
    const alcancesConcedidos = (concesion?.alcances.split(",") ?? []) as Alcance[];
    if (!alcancesConcedidos.includes(alcance)) {
      return this.respuestaMcpRechazada("sin_alcance");
    }

    if (clase === "escritura" && !this.leerEscriturasAdmitidas()) {
      return this.respuestaMcpRechazada("escrituras_suspendidas");
    }

    const sesion = this.resolverSesionMcp(request.headers.get("Mcp-Session-Id"), cliente.principal_id);
    if (sesion === "ajena_o_inexistente") {
      return this.respuestaMcpRechazada("instalacion_desconocida");
    }

    const enVueloInstalacion = this.contarSolicitudesEnVueloDeInstalacion();
    const enVueloCliente = this.contarSolicitudesEnVueloDeCliente(cliente.principal_id);
    if (enVueloInstalacion >= MAX_CONCURRENTES_POR_INSTALACION || enVueloCliente >= MAX_CONCURRENTES_POR_CLIENTE) {
      return this.respuestaMcpRechazada("cuota_agotada", sesion.identificador);
    }

    // AutenticarSolicitud queda implícito: llegar hasta acá es haberla superado.
    if (instalacion.estado !== "conectada") {
      return this.respuestaMcpRechazada("vera_offline", sesion.identificador);
    }

    return this.entregarSolicitudMcp({
      clienteId: cliente.principal_id,
      sesionIdentificador: sesion.identificador,
      clase,
      alcance,
      bytes,
      bodyText,
    });
  }

  // rule EntregarSolicitud — asume instalación conectada, ya comprobado por
  // el llamador. Registra la solicitud, la entrega por el enlace activo y
  // deja pendiente su resolución hasta acuse, respuesta, plazo agotado,
  // desconexión o desplazamiento del enlace.
  private entregarSolicitudMcp(datos: {
    clienteId: string;
    sesionIdentificador: string;
    clase: ClaseDeOperacion;
    alcance: Alcance;
    bytes: number;
    bodyText: string;
  }): Promise<Response> {
    const ws = this.conexionDeEnlaceActiva();
    if (!ws) {
      // Cambió entre la comprobación y este punto: mismo resultado que
      // VeraNoConectadaAlEntregar.
      return Promise.resolve(this.respuestaMcpRechazada("vera_offline", datos.sesionIdentificador));
    }
    const identificadorEfimero = this.identificadorDeConexionActiva();
    const requestId = randomToken(BITS_ENTROPIA_REQUEST_ID);
    const now = Date.now();
    const plazoMs = datos.clase === "escritura" ? PLAZO_DE_ESCRITURA_MS : PLAZO_DE_SOLICITUD_MS;
    const plazoEn = now + plazoMs;

    this.ctx.storage.sql.exec(
      `INSERT INTO solicitudes_mcp
         (request_id, cliente_principal_id, sesion_identificador, clase, alcance_requerido, bytes,
          recibida_en, plazo_en, acusada, reintentos, estado, entregada_por_identificador_efimero)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'entregada', ?)`,
      requestId,
      datos.clienteId,
      datos.sesionIdentificador,
      datos.clase,
      datos.alcance,
      datos.bytes,
      now,
      plazoEn,
      identificadorEfimero,
    );
    void this.scheduleNextAlarm();

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => this.resolverPlazoAgotado(requestId), plazoMs);
      this.solicitudesMcpPendientes.set(requestId, { resolve, timer });
      ws.send(
        JSON.stringify({
          tipo: "sobre",
          request_id: requestId,
          sesion: datos.sesionIdentificador,
          alcance: datos.alcance,
          clase: datos.clase,
          plazo_en: new Date(plazoEn).toISOString(),
          cuerpo: datos.bodyText,
        }),
      );
    });
  }

  // rule DesktopAcusaRecibo
  private marcarSolicitudAcusada(requestId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE solicitudes_mcp SET acusada = 1 WHERE request_id = ? AND estado = 'entregada'`,
      requestId,
    );
  }

  // rule ActividadDeStreamingExtiendePlazo — un fragmento renueva el plazo
  // tanto en SQL (respaldo de alarm()) como en el temporizador en memoria que
  // de verdad resuelve la Response HTTP.
  private extenderPlazoPorFragmento(requestId: string): void {
    const fila = this.leerSolicitudMcp(requestId);
    if (!fila || fila.estado !== "entregada") return;

    const plazoMs = fila.clase === "escritura" ? PLAZO_DE_ESCRITURA_MS : PLAZO_DE_SOLICITUD_MS;
    const nuevoPlazo = Date.now() + plazoMs;
    this.ctx.storage.sql.exec(`UPDATE solicitudes_mcp SET plazo_en = ? WHERE request_id = ?`, nuevoPlazo, requestId);

    const pendiente = this.solicitudesMcpPendientes.get(requestId);
    if (pendiente) {
      clearTimeout(pendiente.timer);
      pendiente.timer = setTimeout(() => this.resolverPlazoAgotado(requestId), plazoMs);
    }
  }

  // rule ResponderSolicitud — sólo la conexión que recibió el sobre puede
  // responderlo; una respuesta por otro enlace se descarta en silencio.
  private resolverConRespuestaDeDesktop(requestId: string, payload: unknown, identificadorEfimero: string): void {
    const fila = this.leerSolicitudMcp(requestId);
    if (!fila || fila.estado !== "entregada") return;
    if (fila.entregada_por_identificador_efimero !== identificadorEfimero) return;

    this.ctx.storage.sql.exec(
      `UPDATE solicitudes_mcp SET estado = 'respondida', respondida_en = ? WHERE request_id = ?`,
      Date.now(),
      requestId,
    );

    const pendiente = this.solicitudesMcpPendientes.get(requestId);
    if (!pendiente) return; // Nadie esperando por HTTP (aislado reciclado); el estado ya quedó consistente.
    clearTimeout(pendiente.timer);
    this.solicitudesMcpPendientes.delete(requestId);
    pendiente.resolve(
      Response.json(payload, {
        status: 200,
        headers: { "cache-control": "no-store", "Mcp-Session-Id": fila.sesion_identificador ?? "" },
      }),
    );
  }

  // rule PlazoAgotadoTrasEntrega
  private resolverPlazoAgotado(requestId: string): void {
    const pendiente = this.solicitudesMcpPendientes.get(requestId);
    const fila = this.leerSolicitudMcp(requestId);
    if (fila && fila.estado === "entregada") {
      this.ctx.storage.sql.exec(
        `UPDATE solicitudes_mcp SET estado = 'resultado_incierto', codigo = 'plazo_agotado' WHERE request_id = ?`,
        requestId,
      );
    }
    if (!pendiente) return;
    this.solicitudesMcpPendientes.delete(requestId);
    pendiente.resolve(this.respuestaMcpRechazada("plazo_agotado", fila?.sesion_identificador ?? undefined));
  }

  // rules SolicitudEntregadaQuedaIncierta, SolicitudAutenticadaSinVera —
  // invocado cuando el enlace de esta instalación se cae (silencio, cierre,
  // error o revocación), nunca cuando sólo lo desplaza uno nuevo.
  private resolverSolicitudesPorVeraDesconectada(): void {
    const enVuelo = this.ctx.storage.sql
      .exec<SolicitudMcpRow>(`SELECT request_id, sesion_identificador FROM solicitudes_mcp WHERE estado = 'entregada'`)
      .toArray();
    if (enVuelo.length === 0) return;

    this.ctx.storage.sql.exec(
      `UPDATE solicitudes_mcp SET estado = 'resultado_incierto', codigo = 'vera_offline' WHERE estado = 'entregada'`,
    );
    for (const fila of enVuelo) {
      const pendiente = this.solicitudesMcpPendientes.get(fila.request_id);
      if (!pendiente) continue;
      clearTimeout(pendiente.timer);
      this.solicitudesMcpPendientes.delete(fila.request_id);
      pendiente.resolve(this.respuestaMcpRechazada("vera_offline", fila.sesion_identificador ?? undefined));
    }
  }

  // rules ReintentarLecturaNoAcusada, EntregaDesplazadaQuedaIncierta —
  // invocado cuando una conexión nueva desplaza a `identificadorAnterior`
  // sobre la misma instalación (la instalación sigue "conectada": el enlace
  // sólo cambió de conexión física).
  private manejarDesplazamientoDeSolicitudes(identificadorAnterior: string): void {
    const enVuelo = this.ctx.storage.sql
      .exec<SolicitudMcpRow>(
        `SELECT * FROM solicitudes_mcp WHERE estado = 'entregada' AND entregada_por_identificador_efimero = ?`,
        identificadorAnterior,
      )
      .toArray();

    for (const fila of enVuelo) {
      const puedeReintentar =
        fila.clase === "lectura" && fila.acusada === 0 && fila.reintentos < MAX_REINTENTOS_DE_LECTURA;

      if (puedeReintentar) {
        const ws = this.conexionDeEnlaceActiva();
        const nuevoIdentificador = this.identificadorDeConexionActiva();
        if (!ws || !nuevoIdentificador) {
          // No debería ocurrir (se llama justo tras aceptar la conexión
          // nueva), pero sin enlace activo el único resultado honesto es
          // incierto, igual que EntregaDesplazadaQuedaIncierta.
          this.concluirComoConflictoDeEnlace(fila);
          continue;
        }
        const plazoMs = fila.clase === "escritura" ? PLAZO_DE_ESCRITURA_MS : PLAZO_DE_SOLICITUD_MS;
        const plazoEn = Date.now() + plazoMs;
        this.ctx.storage.sql.exec(
          `UPDATE solicitudes_mcp
           SET entregada_por_identificador_efimero = ?, reintentos = reintentos + 1, plazo_en = ?
           WHERE request_id = ?`,
          nuevoIdentificador,
          plazoEn,
          fila.request_id,
        );
        const pendiente = this.solicitudesMcpPendientes.get(fila.request_id);
        if (pendiente) clearTimeout(pendiente.timer);
        const timer = setTimeout(() => this.resolverPlazoAgotado(fila.request_id), plazoMs);
        this.solicitudesMcpPendientes.set(fila.request_id, { resolve: pendiente?.resolve ?? (() => {}), timer });
        ws.send(
          JSON.stringify({
            tipo: "sobre",
            request_id: fila.request_id,
            sesion: fila.sesion_identificador,
            alcance: fila.alcance_requerido,
            clase: fila.clase,
            plazo_en: new Date(plazoEn).toISOString(),
            cuerpo: null,
            reintento: true,
          }),
        );
      } else {
        this.concluirComoConflictoDeEnlace(fila);
      }
    }
  }

  private concluirComoConflictoDeEnlace(fila: SolicitudMcpRow): void {
    this.ctx.storage.sql.exec(
      `UPDATE solicitudes_mcp SET estado = 'resultado_incierto', codigo = 'conflicto_de_enlace' WHERE request_id = ?`,
      fila.request_id,
    );
    const pendiente = this.solicitudesMcpPendientes.get(fila.request_id);
    if (!pendiente) return;
    clearTimeout(pendiente.timer);
    this.solicitudesMcpPendientes.delete(fila.request_id);
    pendiente.resolve(this.respuestaMcpRechazada("conflicto_de_enlace", fila.sesion_identificador ?? undefined));
  }

  // rules AbrirSesionMcp, CerrarSesionMcp — "ajena_o_inexistente" cubre tanto
  // una sesión que nunca existió como una de otro cliente: mismo resultado
  // observable, igual que el resto de motivos de rechazo de esta spec.
  private resolverSesionMcp(
    identificadorHeader: string | null,
    clientePrincipalId: string,
  ): SesionMcpRow | "ajena_o_inexistente" {
    if (!identificadorHeader) {
      const identificador = randomToken(BITS_ENTROPIA_IDENTIFICADOR_DE_SESION);
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO sesiones_mcp (identificador, cliente_principal_id, abierta_en, estado) VALUES (?, ?, ?, 'abierta')`,
        identificador,
        clientePrincipalId,
        now,
      );
      return { identificador, cliente_principal_id: clientePrincipalId, estado: "abierta" } as SesionMcpRow;
    }

    const sesion = this.ctx.storage.sql
      .exec<SesionMcpRow>(
        `SELECT identificador, cliente_principal_id, estado FROM sesiones_mcp WHERE identificador = ?`,
        identificadorHeader,
      )
      .toArray()[0];
    if (!sesion || sesion.estado !== "abierta" || sesion.cliente_principal_id !== clientePrincipalId) {
      return "ajena_o_inexistente";
    }
    return sesion;
  }

  // surface ResultadoDeSolicitudMcp: ClienteCierraSesionMcp(solicitud.sesion)
  // sólo la expone a ClienteMcpRemoto — quien conoce el identificador de
  // sesión no basta, tiene que ser el mismo cliente autenticado que la abrió.
  private async cerrarSesionMcpPorHeader(request: Request): Promise<Response> {
    const identificador = request.headers.get("Mcp-Session-Id");
    if (!identificador) return json(400, { error: "falta_mcp_session_id" });

    const auth = request.headers.get("Authorization");
    const credencial = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    const cliente = credencial ? await this.clientePorCredencialDeAcceso(credencial) : null;
    if (!cliente) return json(401, { error: "no_autenticada" });

    const now = Date.now();
    const resultado = this.ctx.storage.sql.exec(
      `UPDATE sesiones_mcp SET estado = 'cerrada', cerrada_en = ?
       WHERE identificador = ? AND estado = 'abierta' AND cliente_principal_id = ?`,
      now,
      identificador,
      cliente.principal_id,
    );
    if (resultado.rowsWritten === 0) return json(404, { error: "sesion_no_encontrada" });
    return json(200, { ok: true });
  }

  // rule CerrarSesionesAlTerminarElAcceso — se invoca desde revocarCliente y
  // desde el vencimiento de credencial en alarm(), los dos únicos lugares
  // donde termina el acceso de un cliente.
  private cerrarSesionesMcpDelCliente(clientePrincipalId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE sesiones_mcp SET estado = 'cerrada', cerrada_en = ? WHERE cliente_principal_id = ? AND estado = 'abierta'`,
      Date.now(),
      clientePrincipalId,
    );
  }

  private async actualizarServicio(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      prueba_de_secreto?: unknown;
      escrituras_admitidas?: unknown;
    } | null;
    const pruebaDeSecreto = body?.prueba_de_secreto;
    if (typeof pruebaDeSecreto !== "string" || pruebaDeSecreto.length === 0) {
      return json(401, { error: "credencial_de_enlace_invalida" });
    }
    const instalacion = await this.verificarSecretoDeEnlace(pruebaDeSecreto);
    if (!instalacion) return json(401, { error: "credencial_de_enlace_invalida" });

    if (typeof body?.escrituras_admitidas !== "boolean") {
      return json(400, { error: "escrituras_admitidas_invalido" });
    }
    this.ctx.storage.sql.exec(
      `UPDATE servicio SET escrituras_admitidas = ? WHERE id = 1`,
      body.escrituras_admitidas ? 1 : 0,
    );
    return json(200, { escrituras_admitidas: body.escrituras_admitidas });
  }

  private leerEscriturasAdmitidas(): boolean {
    const fila = this.ctx.storage.sql
      .exec<{ escrituras_admitidas: number }>(`SELECT escrituras_admitidas FROM servicio WHERE id = 1`)
      .toArray()[0];
    return (fila?.escrituras_admitidas ?? 1) === 1;
  }

  // Sin política de orígenes admitidos configurada todavía (no hay producto
  // decidido sobre qué front-ends además de MCP Inspector deban admitirse
  // desde un navegador), este relay admite cualquier solicitud sin
  // encabezado Origin —el caso normal de un cliente MCP que no es un
  // navegador— y rechaza cualquiera que sí lo traiga, para no reflejar un
  // origen arbitrario ni exponerse a rebinding de DNS mientras no exista esa
  // decisión.
  private esOrigenAdmitido(origen: string | null): boolean {
    return origen === null;
  }

  private async clientePorCredencialDeAcceso(credencial: string): Promise<ClienteRow | null> {
    const candidatos = this.ctx.storage.sql
      .exec<ClienteRow & { hash_de_credencial: string | null }>(
        `SELECT principal_id, etiqueta_de_aplicacion, estado, creado_en, expira_en, refresco_expira_en, hash_de_credencial
         FROM clientes WHERE estado = 'autorizado' AND hash_de_credencial IS NOT NULL`,
      )
      .toArray();
    for (const candidato of candidatos) {
      if (
        candidato.hash_de_credencial &&
        (await verifyWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, credencial, candidato.hash_de_credencial))
      ) {
        if (!candidato.expira_en || candidato.expira_en <= Date.now()) return null;
        return candidato;
      }
    }
    return null;
  }

  private leerSolicitudMcp(requestId: string): SolicitudMcpRow | null {
    return (
      this.ctx.storage.sql.exec<SolicitudMcpRow>(`SELECT * FROM solicitudes_mcp WHERE request_id = ?`, requestId).toArray()[0] ??
      null
    );
  }

  private contarSolicitudesEnVueloDeInstalacion(): number {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM solicitudes_mcp WHERE estado = 'entregada'`)
        .toArray()[0]?.n ?? 0
    );
  }

  private contarSolicitudesEnVueloDeCliente(clientePrincipalId: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM solicitudes_mcp WHERE estado = 'entregada' AND cliente_principal_id = ?`,
          clientePrincipalId,
        )
        .toArray()[0]?.n ?? 0
    );
  }

  // Resuelve por la fila 'activa' de conexiones, no por "el primer WebSocket
  // marcado 'link'": justo después de un desplazamiento, el socket antiguo
  // puede seguir apareciendo en ctx.getWebSockets("link") mientras su cierre
  // termina de propagarse, y enviarle igual lanzaría sobre un socket cerrado.
  private identificadorDeConexionActiva(): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ identificador_efimero: string }>(`SELECT identificador_efimero FROM conexiones WHERE estado = 'activa' LIMIT 1`)
        .toArray()[0]?.identificador_efimero ?? null
    );
  }

  private conexionDeEnlaceActiva(): WebSocket | null {
    const identificador = this.identificadorDeConexionActiva();
    if (!identificador) return null;
    for (const ws of this.ctx.getWebSockets("link")) {
      const attachment = ws.deserializeAttachment() as LinkAttachment | null;
      if (attachment?.identificador_efimero === identificador) return ws;
    }
    return null;
  }

  private respuestaMcpRechazada(codigo: CodigoPublico, sesionIdentificador?: string): Response {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (sesionIdentificador) headers["Mcp-Session-Id"] = sesionIdentificador;
    return Response.json({ codigo }, { status: CODIGO_HTTP[codigo], headers });
  }

  private validarAlcances(valor: unknown): Alcance[] | null {
    if (!Array.isArray(valor) || valor.length === 0) return null;
    const alcances = new Set<Alcance>();
    for (const item of valor) {
      if (typeof item !== "string" || !(ALCANCES_VALIDOS as readonly string[]).includes(item)) return null;
      alcances.add(item as Alcance);
    }
    return Array.from(alcances);
  }

  private validarEvidencia(valor: unknown): Evidencia | null {
    if (typeof valor !== "string" || !(EVIDENCIAS_VALIDAS as readonly string[]).includes(valor)) return null;
    return valor as Evidencia;
  }

  private leerCliente(principalId: string): ClienteRow | null {
    return (
      this.ctx.storage.sql
        .exec<ClienteRow>(
          `SELECT principal_id, etiqueta_de_aplicacion, estado, creado_en, expira_en, refresco_expira_en
           FROM clientes WHERE principal_id = ?`,
          principalId,
        )
        .toArray()[0] ?? null
    );
  }

  private leerConcesion(principalId: string): { alcances: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ alcances: string } & Record<string, SqlStorageValue>>(
          `SELECT alcances FROM concesiones WHERE cliente_principal_id = ?`,
          principalId,
        )
        .toArray()[0] ?? null
    );
  }

  private leerHashDeRefresco(principalId: string): string | null {
    const fila = this.ctx.storage.sql
      .exec<{ hash_de_refresco: string | null }>(
        `SELECT hash_de_refresco FROM clientes WHERE principal_id = ?`,
        principalId,
      )
      .toArray()[0];
    return fila?.hash_de_refresco ?? null;
  }

  // Verifica posesión del secreto de enlace sin exigir el resto del cuerpo
  // que espera leerCredencialDesdeBody (autorizarCliente ya extrajo su propio
  // body con campos adicionales antes de llegar aquí).
  private async verificarSecretoDeEnlace(pruebaDeSecreto: string): Promise<InstalacionRow | null> {
    const instalacion = this.leerInstalacion();
    if (!instalacion) return null;

    const secretosUtilizables = this.ctx.storage.sql
      .exec<{ hash: string }>(`SELECT hash FROM secretos WHERE estado IN ('vigente', 'solapado')`)
      .toArray();
    for (const secreto of secretosUtilizables) {
      if (await verifyWithPepper(this.env.VERA_CONECTA_TOKEN_PEPPER, pruebaDeSecreto, secreto.hash)) {
        return instalacion;
      }
    }
    return null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let parsed: { tipo?: unknown; request_id?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    const attachment = ws.deserializeAttachment() as LinkAttachment | null;
    if (!attachment?.identificador_efimero) return;

    // rule RegistrarLatido
    if (parsed.tipo === "latido") {
      this.ctx.storage.sql.exec(
        `UPDATE conexiones SET ultimo_latido_en = ? WHERE identificador_efimero = ? AND estado = 'activa'`,
        Date.now(),
        attachment.identificador_efimero,
      );
      ws.send(JSON.stringify({ tipo: "latido_ack", instante: new Date().toISOString() }));
      return;
    }

    // Eco autenticado, correlacionado por request_id: se mantiene por
    // compatibilidad con el walking skeleton de M1; mcp-relay usa los tipos
    // de mensaje "sobre_*" de abajo.
    if (parsed.tipo === "eco" && typeof parsed.request_id === "string") {
      ws.send(JSON.stringify({ tipo: "eco", request_id: parsed.request_id, payload: parsed.payload ?? null }));
      return;
    }

    if (typeof parsed.request_id !== "string") return;

    // rule DesktopAcusaRecibo
    if (parsed.tipo === "sobre_acuse") {
      this.marcarSolicitudAcusada(parsed.request_id);
      return;
    }

    // rule ActividadDeStreamingExtiendePlazo
    if (parsed.tipo === "sobre_fragmento") {
      this.extenderPlazoPorFragmento(parsed.request_id);
      return;
    }

    // rule ResponderSolicitud
    if (parsed.tipo === "sobre_respuesta") {
      this.resolverConRespuestaDeDesktop(parsed.request_id, parsed.payload ?? null, attachment.identificador_efimero);
    }
  }

  // rule CanalDeEnlaceSeCierra
  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.cerrarConexionDeSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.cerrarConexionDeSocket(ws);
  }

  private async cerrarConexionDeSocket(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as LinkAttachment | null;
    if (!attachment?.identificador_efimero) return;

    const now = Date.now();
    const resultado = this.ctx.storage.sql.exec(
      `UPDATE conexiones SET estado = 'cerrada', cerrada_en = ? WHERE identificador_efimero = ? AND estado = 'activa'`,
      now,
      attachment.identificador_efimero,
    );
    // Si ya estaba 'desplazada' (por una conexión nueva) esto no reabre nada:
    // sólo la conexión activa vigente puede degradar la instalación. Ese
    // mismo condicional distingue un desplazamiento (ya resuelto en
    // abrirCanal) de una desconexión real, que es cuando corren
    // SolicitudEntregadaQuedaIncierta / SolicitudAutenticadaSinVera.
    if (resultado.rowsWritten > 0) {
      this.ctx.storage.sql.exec(`UPDATE instalacion SET estado = 'desconectada' WHERE estado = 'conectada'`);
      this.resolverSolicitudesPorVeraDesconectada();
    }
  }

  // rules DesafioDeEmparejamientoCaduca, EmparejamientoNoCompletadoSeRevoca,
  // CaidaDeConexionDetectadaPorSilencio, SolapamientoDeRotacionExpira
  async alarm(): Promise<void> {
    const now = Date.now();

    this.ctx.storage.sql.exec(`UPDATE desafios SET estado = 'caducado' WHERE estado = 'pendiente' AND expira_en <= ?`, now);

    const abandonos = this.ctx.storage.sql
      .exec<InstalacionRow>(
        `SELECT id_publico, estado FROM instalacion WHERE estado = 'emparejando' AND creada_en + ? <= ?`,
        VIGENCIA_DEL_DESAFIO_MS,
        now,
      )
      .toArray();
    if (abandonos.length > 0) {
      this.ctx.storage.sql.exec(
        `UPDATE instalacion SET estado = 'revocada', revocada_en = ? WHERE estado = 'emparejando' AND creada_en + ? <= ?`,
        now,
        VIGENCIA_DEL_DESAFIO_MS,
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE secretos SET estado = 'invalidado' WHERE estado = 'vigente'`);
    }

    const silenciosas = this.ctx.storage.sql
      .exec<{ identificador_efimero: string }>(
        `SELECT identificador_efimero FROM conexiones WHERE estado = 'activa' AND ultimo_latido_en + ? <= ?`,
        UMBRAL_DE_LATIDO_MS,
        now,
      )
      .toArray();
    if (silenciosas.length > 0) {
      const idsSilenciosos = new Set(silenciosas.map((c) => c.identificador_efimero));
      for (const ws of this.ctx.getWebSockets("link")) {
        const attachment = ws.deserializeAttachment() as LinkAttachment | null;
        if (attachment && idsSilenciosos.has(attachment.identificador_efimero)) {
          ws.close(4001, "silencio_del_canal");
        }
      }
      this.ctx.storage.sql.exec(
        `UPDATE conexiones SET estado = 'cerrada', cerrada_en = ? WHERE estado = 'activa' AND ultimo_latido_en + ? <= ?`,
        now,
        UMBRAL_DE_LATIDO_MS,
        now,
      );
      this.ctx.storage.sql.exec(`UPDATE instalacion SET estado = 'desconectada' WHERE estado = 'conectada'`);
    }

    this.ctx.storage.sql.exec(
      `UPDATE secretos SET estado = 'invalidado', solapamiento_expira_en = NULL
       WHERE estado = 'solapado' AND solapamiento_expira_en <= ?`,
      now,
    );

    // rule AutorizacionPendienteCaduca
    this.ctx.storage.sql.exec(
      `UPDATE concesiones SET estado = 'retirada', retirada_en = ?
       WHERE estado = 'vigente' AND cliente_principal_id IN (
         SELECT principal_id FROM clientes WHERE estado = 'pendiente' AND expira_en <= ?
       )`,
      now,
      now,
    );
    this.ctx.storage.sql.exec(
      `UPDATE clientes SET estado = 'expirado', expira_en = NULL WHERE estado = 'pendiente' AND expira_en <= ?`,
      now,
    );
    // Una autorización pendiente jamás llegó a abrir sesiones MCP, así que no
    // hay nada que cerrar acá (a diferencia de las dos expiraciones de abajo).

    // rule CredencialDeClienteExpira — caso límite: la ventana de refresco se
    // agotó sin que nadie tocara la credencial de acceso todavía vigente.
    this.ctx.storage.sql.exec(
      `UPDATE concesiones SET estado = 'retirada', retirada_en = ?
       WHERE estado = 'vigente' AND cliente_principal_id IN (
         SELECT principal_id FROM clientes WHERE estado = 'autorizado' AND refresco_expira_en <= ?
       )`,
      now,
      now,
    );
    const expiranPorRefrescoAgotado = this.ctx.storage.sql
      .exec<{ principal_id: string }>(
        `SELECT principal_id FROM clientes WHERE estado = 'autorizado' AND refresco_expira_en <= ?`,
        now,
      )
      .toArray();
    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'expirado', expira_en = NULL, hash_de_credencial = NULL,
           hash_de_refresco = NULL, refresco_expira_en = NULL
       WHERE estado = 'autorizado' AND refresco_expira_en <= ?`,
      now,
    );
    // specs/mcp-relay.allium rule CerrarSesionesAlTerminarElAcceso
    for (const { principal_id } of expiranPorRefrescoAgotado) this.cerrarSesionesMcpDelCliente(principal_id);

    // rule CredencialDeAccesoVence — sólo lo que sigue autorizado tras el
    // paso anterior: vencer no retira la concesión, sólo la credencial corta.
    this.ctx.storage.sql.exec(
      `UPDATE clientes SET estado = 'credencial_vencida', expira_en = NULL, hash_de_credencial = NULL
       WHERE estado = 'autorizado' AND expira_en <= ?`,
      now,
    );

    // rule VentanaDeRefrescoSeAgota
    this.ctx.storage.sql.exec(
      `UPDATE concesiones SET estado = 'retirada', retirada_en = ?
       WHERE estado = 'vigente' AND cliente_principal_id IN (
         SELECT principal_id FROM clientes WHERE estado = 'credencial_vencida' AND refresco_expira_en <= ?
       )`,
      now,
      now,
    );
    const expiranTrasCredencialVencida = this.ctx.storage.sql
      .exec<{ principal_id: string }>(
        `SELECT principal_id FROM clientes WHERE estado = 'credencial_vencida' AND refresco_expira_en <= ?`,
        now,
      )
      .toArray();
    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'expirado', hash_de_refresco = NULL, refresco_expira_en = NULL
       WHERE estado = 'credencial_vencida' AND refresco_expira_en <= ?`,
      now,
    );
    // specs/mcp-relay.allium rule CerrarSesionesAlTerminarElAcceso
    for (const { principal_id } of expiranTrasCredencialVencida) this.cerrarSesionesMcpDelCliente(principal_id);

    // rule PlazoAgotadoTrasEntrega — respaldo del temporizador en memoria de
    // aceptarSolicitudMcp/entregarSolicitudMcp. Sólo importa por sí solo si
    // el aislado se reciclara con una solicitud entregada en curso; en ese
    // caso ya no hay Response HTTP pendiente a quien resolver, sólo estado
    // que dejar consistente.
    this.ctx.storage.sql.exec(
      `UPDATE solicitudes_mcp SET estado = 'resultado_incierto', codigo = 'plazo_agotado'
       WHERE estado = 'entregada' AND plazo_en <= ?`,
      now,
    );

    await this.scheduleNextAlarm();
  }

  private leerInstalacion(): InstalacionRow | null {
    return (
      this.ctx.storage.sql.exec<InstalacionRow>(`SELECT id_publico, estado FROM instalacion LIMIT 1`).toArray()[0] ?? null
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const hayPendientes =
      sql.exec(`SELECT 1 FROM desafios WHERE estado = 'pendiente' LIMIT 1`).toArray().length > 0 ||
      sql.exec(`SELECT 1 FROM instalacion WHERE estado = 'emparejando' LIMIT 1`).toArray().length > 0 ||
      sql.exec(`SELECT 1 FROM conexiones WHERE estado = 'activa' LIMIT 1`).toArray().length > 0 ||
      sql.exec(`SELECT 1 FROM secretos WHERE estado = 'solapado' LIMIT 1`).toArray().length > 0 ||
      sql.exec(`SELECT 1 FROM clientes WHERE estado IN ('pendiente', 'autorizado', 'credencial_vencida') LIMIT 1`).toArray()
        .length > 0 ||
      sql.exec(`SELECT 1 FROM solicitudes_mcp WHERE estado = 'entregada' LIMIT 1`).toArray().length > 0;

    if (hayPendientes) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_TICK_MS);
    }
  }
}
