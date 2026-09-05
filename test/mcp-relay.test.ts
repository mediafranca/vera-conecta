import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Reclamo {
  id_publico: string;
  secreto_de_enlace: string;
}

interface CredencialDeCliente {
  secreto_de_cliente: string;
  alcances: string[];
}

async function emparejarInstalacion(): Promise<Reclamo> {
  const pairing = await SELF.fetch("https://vera-conecta.test/pairings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version_ofrecida: 1 }),
  });
  const { codigo } = (await pairing.json()) as { codigo: string };
  const claim = await SELF.fetch(`https://vera-conecta.test/pairings/${encodeURIComponent(codigo)}/claim`, {
    method: "POST",
  });
  return (await claim.json()) as Reclamo;
}

async function abrirEnlace(idPublico: string, secreto: string, identificadorEfimero: string): Promise<WebSocket> {
  const url = new URL(`https://vera-conecta.test/v/${idPublico}/link`);
  url.searchParams.set("prueba_de_secreto", secreto);
  url.searchParams.set("version_ofrecida", "1");
  url.searchParams.set("identificador_efimero", identificadorEfimero);
  const respuesta = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = respuesta.webSocket;
  if (!ws) throw new Error("se esperaba un WebSocket en la respuesta");
  ws.accept();
  return ws;
}

async function autorizarYReclamarCliente(
  idPublico: string,
  secretoDeEnlace: string,
  alcances = ["read"],
): Promise<CredencialDeCliente> {
  const autorizacion = await SELF.fetch(`https://vera-conecta.test/v/${idPublico}/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prueba_de_secreto: secretoDeEnlace,
      etiqueta_de_aplicacion: "cliente de prueba",
      alcances,
      evidencia: "bearer_del_piloto",
    }),
  });
  const { principal_id } = (await autorizacion.json()) as { principal_id: string };
  const reclamo = await SELF.fetch(`https://vera-conecta.test/v/${idPublico}/clients/${principal_id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prueba_de_consentimiento: principal_id }),
  });
  return (await reclamo.json()) as CredencialDeCliente;
}

async function instalacionConectadaYCliente(alcances = ["read", "write"]) {
  const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
  const desktop = await abrirEnlace(id_publico, secreto_de_enlace, "conexion-1");
  const credencial = await autorizarYReclamarCliente(id_publico, secreto_de_enlace, alcances);
  return { id_publico, secreto_de_enlace, desktop, credencial };
}

function esperarMensaje(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event: MessageEvent) => resolve(JSON.parse(event.data as string)), { once: true });
  });
}

function solicitudMcp(idPublico: string, secreto: string, metodo = "tools/list", init: RequestInit = {}): Promise<Response> {
  const { headers, ...resto } = init;
  return SELF.fetch(`https://vera-conecta.test/v/${idPublico}/mcp`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: metodo }),
    ...resto,
    headers: { authorization: `Bearer ${secreto}`, ...headers },
  });
}

function llamadaDeHerramienta(idPublico: string, secreto: string, nombre: string): Promise<Response> {
  return SELF.fetch(`https://vera-conecta.test/v/${idPublico}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${secreto}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: nombre, arguments: {} } }),
  });
}

describe("aceptación de una solicitud MCP", () => {
  it("entrega una lectura por el enlace y responde con lo que Desktop contesta", async () => {
    const { id_publico, desktop, credencial } = await instalacionConectadaYCliente(["read"]);

    const respuestaPromise = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/list");
    const sobre = await esperarMensaje(desktop);
    expect(sobre.tipo).toBe("sobre");
    expect(sobre.clase).toBe("lectura");
    expect(sobre.alcance).toBe("read");
    expect(sobre.principal_id).toBeTypeOf("string");
    expect(sobre.alcances).toEqual(["read"]);

    desktop.send(JSON.stringify({ tipo: "sobre_acuse", request_id: sobre.request_id }));
    desktop.send(
      JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre.request_id, payload: { resultado: "ok" } }),
    );

    const respuesta = await respuestaPromise;
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("Mcp-Session-Id")).toBeTruthy();
    expect(await respuesta.json()).toEqual({ resultado: "ok" });
  });

  it("clasifica un método no reconocido (p. ej. tools/call) como escritura", async () => {
    const { id_publico, desktop, credencial } = await instalacionConectadaYCliente(["read", "write"]);

    const respuestaPromise = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/call");
    const sobre = await esperarMensaje(desktop);
    expect(sobre.clase).toBe("escritura");
    expect(sobre.alcance).toBe("write");

    desktop.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre.request_id, payload: {} }));
    await respuestaPromise;
  });

  it("permite una herramienta Vera conocida de lectura a un cliente read", async () => {
    const { id_publico, desktop, credencial } = await instalacionConectadaYCliente(["read"]);

    const respuestaPromise = llamadaDeHerramienta(id_publico, credencial.secreto_de_cliente, "vera_buscar");
    const sobre = await esperarMensaje(desktop);
    expect(sobre.clase).toBe("lectura");
    expect(sobre.alcance).toBe("read");

    desktop.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre.request_id, payload: { resultado: "ok" } }));
    expect((await respuestaPromise).status).toBe(200);
  });

  it("trata una herramienta desconocida como escritura y no amplía un cliente read", async () => {
    const { id_publico, credencial } = await instalacionConectadaYCliente(["read"]);
    const respuesta = await llamadaDeHerramienta(id_publico, credencial.secreto_de_cliente, "vera_herramienta_futura");
    expect(respuesta.status).toBe(403);
    expect((await respuesta.json())).toMatchObject({ codigo: "sin_alcance" });
  });

  it("rechaza sin credencial con no_autenticada", async () => {
    const { id_publico } = await instalacionConectadaYCliente();
    const respuesta = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(respuesta.status).toBe(401);
    expect((await respuesta.json())).toMatchObject({ codigo: "no_autenticada" });
  });

  it("rechaza una instalación inexistente con instalacion_desconocida", async () => {
    const respuesta = await SELF.fetch("https://vera-conecta.test/v/no-existe/mcp", {
      method: "POST",
      headers: { authorization: "Bearer lo-que-sea" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(respuesta.status).toBe(404);
    expect((await respuesta.json())).toMatchObject({ codigo: "instalacion_desconocida" });
  });

  it("rechaza un método sin el alcance concedido", async () => {
    const { id_publico, credencial } = await instalacionConectadaYCliente(["read"]);
    const respuesta = await solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/call");
    expect(respuesta.status).toBe(403);
    expect((await respuesta.json())).toMatchObject({ codigo: "sin_alcance" });
  });

  it("rechaza un cuerpo que excede el límite de tamaño", async () => {
    const { id_publico, credencial } = await instalacionConectadaYCliente(["read"]);
    const cuerpoEnorme = "x".repeat(10_485_760 + 1);
    const respuesta = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${credencial.secreto_de_cliente}` },
      body: cuerpoEnorme,
    });
    expect(respuesta.status).toBe(413);
    expect((await respuesta.json())).toMatchObject({ codigo: "excede_limite" });
  });

  it("rechaza escrituras cuando el servicio las tiene suspendidas", async () => {
    const { id_publico, secreto_de_enlace, credencial } = await instalacionConectadaYCliente(["read", "write"]);
    const toggle = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/servicio`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prueba_de_secreto: secreto_de_enlace, escrituras_admitidas: false }),
    });
    expect(toggle.status).toBe(200);

    const respuesta = await solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/call");
    expect(respuesta.status).toBe(503);
    expect((await respuesta.json())).toMatchObject({ codigo: "escrituras_suspendidas" });
  });

  it("Vera desconectada mientras hay una solicitud entregada resuelve en resultado incierto", async () => {
    const { id_publico, desktop, credencial } = await instalacionConectadaYCliente(["read"]);

    const respuestaPromise = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/list");
    await esperarMensaje(desktop);
    desktop.close();

    const respuesta = await respuestaPromise;
    expect(respuesta.status).toBe(503);
    expect((await respuesta.json())).toMatchObject({ codigo: "vera_offline" });
  });
});

describe("sesión MCP", () => {
  it("reutiliza la sesión abierta cuando se envía Mcp-Session-Id", async () => {
    const { id_publico, desktop, credencial } = await instalacionConectadaYCliente(["read"]);

    const primera = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/list");
    const sobre1 = await esperarMensaje(desktop);
    desktop.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre1.request_id, payload: {} }));
    const respuesta1 = await primera;
    const sesion = respuesta1.headers.get("Mcp-Session-Id");
    expect(sesion).toBeTruthy();

    const segunda = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/list", {
      headers: { "Mcp-Session-Id": sesion! },
    });
    const sobre2 = await esperarMensaje(desktop);
    expect(sobre2.sesion).toBe(sesion);
    desktop.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre2.request_id, payload: {} }));
    const respuesta2 = await segunda;
    expect(respuesta2.headers.get("Mcp-Session-Id")).toBe(sesion);
  });

  it("cierra la sesión con DELETE", async () => {
    const { id_publico, desktop, credencial } = await instalacionConectadaYCliente(["read"]);

    const primera = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/list");
    const sobre = await esperarMensaje(desktop);
    desktop.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre.request_id, payload: {} }));
    const respuesta = await primera;
    const sesion = respuesta.headers.get("Mcp-Session-Id")!;

    const sinCredencial = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sesion },
    });
    expect(sinCredencial.status).toBe(401);

    const cierre = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sesion, authorization: `Bearer ${credencial.secreto_de_cliente}` },
    });
    expect(cierre.status).toBe(200);

    const segundoCierre = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sesion, authorization: `Bearer ${credencial.secreto_de_cliente}` },
    });
    expect(segundoCierre.status).toBe(404);
  });
});

describe("desplazamiento del enlace", () => {
  it("reintenta una lectura no acusada sobre la conexión nueva", async () => {
    const { id_publico, secreto_de_enlace, desktop, credencial } = await instalacionConectadaYCliente(["read"]);

    const respuestaPromise = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/list");
    const sobre1 = await esperarMensaje(desktop);
    expect(sobre1.reintento).toBeFalsy();

    // Nueva conexión de Desktop desplaza a la anterior sin que se haya
    // acusado recibo todavía.
    const desktop2 = await abrirEnlace(id_publico, secreto_de_enlace, "conexion-2");
    const sobre2 = await esperarMensaje(desktop2);
    expect(sobre2.request_id).toBe(sobre1.request_id);
    expect(sobre2.reintento).toBe(true);

    desktop2.send(JSON.stringify({ tipo: "sobre_respuesta", request_id: sobre2.request_id, payload: { via: "reintento" } }));
    const respuesta = await respuestaPromise;
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json()).toEqual({ via: "reintento" });
  });

  it("una escritura entregada y desplazada termina en conflicto_de_enlace, nunca se reintenta", async () => {
    const { id_publico, secreto_de_enlace, desktop, credencial } = await instalacionConectadaYCliente(["read", "write"]);

    const respuestaPromise = solicitudMcp(id_publico, credencial.secreto_de_cliente, "tools/call");
    await esperarMensaje(desktop);

    await abrirEnlace(id_publico, secreto_de_enlace, "conexion-2");

    const respuesta = await respuestaPromise;
    expect(respuesta.status).toBe(409);
    expect((await respuesta.json())).toMatchObject({ codigo: "conflicto_de_enlace" });
  });
});
