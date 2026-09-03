import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Reclamo {
  id_publico: string;
  secreto_de_enlace: string;
  version_ofrecida: number;
}

async function emparejarInstalacion(versionOfrecida = 1): Promise<Reclamo> {
  const pairing = await SELF.fetch("https://vera-conecta.test/pairings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version_ofrecida: versionOfrecida }),
  });
  expect(pairing.status).toBe(201);
  const { codigo } = (await pairing.json()) as { codigo: string };

  const claim = await SELF.fetch(`https://vera-conecta.test/pairings/${encodeURIComponent(codigo)}/claim`, {
    method: "POST",
  });
  expect(claim.status).toBe(201);
  return (await claim.json()) as Reclamo;
}

function urlDeEnlace(idPublico: string, secreto: string, identificadorEfimero: string, version = 1): string {
  const url = new URL(`https://vera-conecta.test/v/${idPublico}/link`);
  url.searchParams.set("prueba_de_secreto", secreto);
  url.searchParams.set("version_ofrecida", String(version));
  url.searchParams.set("identificador_efimero", identificadorEfimero);
  return url.toString();
}

async function abrirEnlace(idPublico: string, secreto: string, identificadorEfimero: string, version = 1): Promise<Response> {
  return SELF.fetch(urlDeEnlace(idPublico, secreto, identificadorEfimero, version), {
    headers: { Upgrade: "websocket" },
  });
}

function esperarMensaje(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (event: MessageEvent) => resolve(JSON.parse(event.data as string)),
      { once: true },
    );
  });
}

function esperarCierre(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "close",
      (event: CloseEvent) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
}

describe("emparejamiento", () => {
  it("emite un desafío y lo reclama en una instalación nueva", async () => {
    const reclamo = await emparejarInstalacion();
    expect(reclamo.id_publico).toBeTruthy();
    expect(reclamo.secreto_de_enlace).toBeTruthy();
    expect(reclamo.version_ofrecida).toBe(1);
  });

  it("un código ya reclamado no produce una segunda instalación", async () => {
    const pairing = await SELF.fetch("https://vera-conecta.test/pairings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_ofrecida: 1 }),
    });
    const { codigo } = (await pairing.json()) as { codigo: string };

    const primerReclamo = await SELF.fetch(`https://vera-conecta.test/pairings/${codigo}/claim`, { method: "POST" });
    expect(primerReclamo.status).toBe(201);

    const segundoReclamo = await SELF.fetch(`https://vera-conecta.test/pairings/${codigo}/claim`, { method: "POST" });
    expect(segundoReclamo.status).toBe(409);
  });

  it("rechaza un código inexistente", async () => {
    const respuesta = await SELF.fetch("https://vera-conecta.test/pairings/codigo-que-nunca-existio/claim", {
      method: "POST",
    });
    expect(respuesta.status).toBe(404);
  });
});

describe("canal de enlace", () => {
  it("abre el canal, confirma un latido y correlaciona un eco por request_id", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();

    const upgrade = await abrirEnlace(id_publico, secreto_de_enlace, "conexion-1");
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("se esperaba un WebSocket en la respuesta");
    ws.accept();

    ws.send(JSON.stringify({ tipo: "latido" }));
    const latido = await esperarMensaje(ws);
    expect(latido.tipo).toBe("latido_ack");

    ws.send(JSON.stringify({ tipo: "eco", request_id: "req-42", payload: { hola: "vera" } }));
    const eco = await esperarMensaje(ws);
    expect(eco).toMatchObject({ tipo: "eco", request_id: "req-42", payload: { hola: "vera" } });

    ws.close();
  });

  it("rechaza una prueba de secreto inválida", async () => {
    const { id_publico } = await emparejarInstalacion();
    const respuesta = await abrirEnlace(id_publico, "secreto-incorrecto", "conexion-x");
    expect(respuesta.status).toBe(401);
  });

  it("rechaza una instalación inexistente con el mismo motivo que una revocada", async () => {
    const respuesta = await abrirEnlace("instalacion-que-nunca-existio", "cualquier-secreto", "conexion-y");
    expect(respuesta.status).toBe(401);
  });

  it("rechaza una versión de protocolo fuera de rango", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    const respuesta = await abrirEnlace(id_publico, secreto_de_enlace, "conexion-z", 99);
    expect(respuesta.status).toBe(400);
  });

  it("una conexión nueva desplaza a la anterior de la misma instalación", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();

    const primera = await abrirEnlace(id_publico, secreto_de_enlace, "conexion-a");
    const wsA = primera.webSocket;
    if (!wsA) throw new Error("se esperaba un WebSocket");
    wsA.accept();
    const cierre = esperarCierre(wsA);

    const segunda = await abrirEnlace(id_publico, secreto_de_enlace, "conexion-b");
    expect(segunda.status).toBe(101);
    const wsB = segunda.webSocket;
    if (!wsB) throw new Error("se esperaba un WebSocket");
    wsB.accept();

    const evento = await cierre;
    expect(evento.code).toBe(4000);

    wsB.close();
  });
});

describe("aislamiento entre instalaciones", () => {
  it("dos instalaciones no comparten canal ni credenciales", async () => {
    const a = await emparejarInstalacion();
    const b = await emparejarInstalacion();
    expect(a.id_publico).not.toBe(b.id_publico);

    // El secreto de A no abre el canal de B.
    const cruzado = await abrirEnlace(b.id_publico, a.secreto_de_enlace, "conexion-cruzada");
    expect(cruzado.status).toBe(401);

    const canalA = await abrirEnlace(a.id_publico, a.secreto_de_enlace, "conexion-a");
    const canalB = await abrirEnlace(b.id_publico, b.secreto_de_enlace, "conexion-b");
    expect(canalA.status).toBe(101);
    expect(canalB.status).toBe(101);

    const wsA = canalA.webSocket!;
    const wsB = canalB.webSocket!;
    wsA.accept();
    wsB.accept();

    // Un eco en el canal de A nunca llega al canal de B.
    const mensajesEnB: unknown[] = [];
    wsB.addEventListener("message", (event: MessageEvent) => mensajesEnB.push(JSON.parse(event.data as string)));

    wsA.send(JSON.stringify({ tipo: "eco", request_id: "solo-a", payload: null }));
    await esperarMensaje(wsA);

    expect(mensajesEnB).toHaveLength(0);

    wsA.close();
    wsB.close();
  });
});
