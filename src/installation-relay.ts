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

export class InstallationRelay extends DurableObject<Env> {
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
      for (const ws of this.ctx.getWebSockets("link")) {
        if (ws === server) continue;
        ws.close(4000, "enlace_desplazado");
      }
      this.ctx.storage.sql.exec(
        `UPDATE conexiones SET estado = 'desplazada', cerrada_en = ? WHERE estado = 'activa'`,
        now,
      );
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

    // Eco autenticado, correlacionado por request_id: el eco extremo a extremo
    // que M1 exige, sin transportar MCP todavía.
    if (parsed.tipo === "eco" && typeof parsed.request_id === "string") {
      ws.send(JSON.stringify({ tipo: "eco", request_id: parsed.request_id, payload: parsed.payload ?? null }));
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
    // sólo la conexión activa vigente puede degradar la instalación.
    if (resultado.rowsWritten > 0) {
      this.ctx.storage.sql.exec(`UPDATE instalacion SET estado = 'desconectada' WHERE estado = 'conectada'`);
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
    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'expirado', expira_en = NULL, hash_de_credencial = NULL,
           hash_de_refresco = NULL, refresco_expira_en = NULL
       WHERE estado = 'autorizado' AND refresco_expira_en <= ?`,
      now,
    );

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
    this.ctx.storage.sql.exec(
      `UPDATE clientes
       SET estado = 'expirado', hash_de_refresco = NULL, refresco_expira_en = NULL
       WHERE estado = 'credencial_vencida' AND refresco_expira_en <= ?`,
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
        .length > 0;

    if (hayPendientes) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_TICK_MS);
    }
  }
}
