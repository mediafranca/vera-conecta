import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function crearInstalacion(): Promise<{ id: string; secreto: string }> {
  const pairing = await SELF.fetch("https://vera-conecta.test/pairings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version_ofrecida: 1 }),
  });
  const { codigo } = await pairing.json<{ codigo: string }>();
  const claim = await SELF.fetch(`https://vera-conecta.test/pairings/${encodeURIComponent(codigo)}/claim`, { method: "POST" });
  const body = await claim.json<{ id_publico: string; secreto_de_enlace: string }>();
  return { id: body.id_publico, secreto: body.secreto_de_enlace };
}

async function abrirEnlace(instalacion: { id: string; secreto: string }, efimero: string): Promise<WebSocket> {
  const url = new URL(`https://vera-conecta.test/v/${instalacion.id}/link`);
  url.searchParams.set("prueba_de_secreto", instalacion.secreto);
  url.searchParams.set("identificador_efimero", efimero);
  url.searchParams.set("version_ofrecida", "1");
  const response = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (!ws) throw new Error("se esperaba websocket");
  ws.accept();
  return ws;
}

async function autorizarCaptura(instalacion: { id: string; secreto: string }): Promise<string> {
  const response = await SELF.fetch(`https://vera-conecta.test/v/${instalacion.id}/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prueba_de_secreto: instalacion.secreto,
      etiqueta_de_aplicacion: "Vera Clip",
      alcances: ["capture"],
      evidencia: "confirmacion_en_desktop",
    }),
  });
  const { principal_id } = await response.json<{ principal_id: string }>();
  const claim = await SELF.fetch(`https://vera-conecta.test/v/${instalacion.id}/clients/${principal_id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prueba_de_consentimiento: principal_id }),
  });
  return (await claim.json<{ secreto_de_cliente: string }>()).secreto_de_cliente;
}

function siguienteMensaje(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise(resolve => ws.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
}

describe("capture relay", () => {
  it("transporta una captura sin conservarla y devuelve el acuse de Vera", async () => {
    const instalacion = await crearInstalacion();
    const ws = await abrirEnlace(instalacion, "desktop-capture");
    const token = await autorizarCaptura(instalacion);
    const mensaje = siguienteMensaje(ws);

    const responsePromise = SELF.fetch(`https://vera-conecta.test/v/${instalacion.id}/captures`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "capture-1", content: "Texto privado" }),
    });
    const sobre = await mensaje;
    expect(sobre).toMatchObject({ tipo: "captura", identificador_de_idempotencia: "capture-1" });
    ws.send(JSON.stringify({ tipo: "captura_aceptada", request_id: sobre.request_id, payload: { aceptada: true } }));

    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ aceptada: true });
  });

  it("una credencial MCP de lectura no puede depositar capturas", async () => {
    const instalacion = await crearInstalacion();
    await abrirEnlace(instalacion, "desktop-read");
    const grant = await SELF.fetch(`https://vera-conecta.test/v/${instalacion.id}/clients`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prueba_de_secreto: instalacion.secreto, etiqueta_de_aplicacion: "lector", alcances: ["read"], evidencia: "bearer_del_piloto" }),
    });
    const { principal_id } = await grant.json<{ principal_id: string }>();
    const claim = await SELF.fetch(`https://vera-conecta.test/v/${instalacion.id}/clients/${principal_id}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prueba_de_consentimiento: principal_id }),
    });
    const { secreto_de_cliente } = await claim.json<{ secreto_de_cliente: string }>();
    const response = await SELF.fetch(`https://vera-conecta.test/v/${instalacion.id}/captures`, {
      method: "POST",
      headers: { authorization: `Bearer ${secreto_de_cliente}` },
      body: JSON.stringify({ idempotencyKey: "forbidden" }),
    });
    expect(response.status).toBe(403);
  });

  it("aísla la credencial de captura entre instalaciones", async () => {
    const [a, b] = await Promise.all([crearInstalacion(), crearInstalacion()]);
    await Promise.all([abrirEnlace(a, "desktop-a"), abrirEnlace(b, "desktop-b")]);
    const tokenA = await autorizarCaptura(a);
    const response = await SELF.fetch(`https://vera-conecta.test/v/${b.id}/captures`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ idempotencyKey: "cross-installation" }),
    });
    expect(response.status).toBe(401);
  });
});
