import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface Reclamo {
  id_publico: string;
  secreto_de_enlace: string;
  version_ofrecida: number;
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

async function abrirEnlaceParaConectar(idPublico: string, secreto: string): Promise<void> {
  const url = new URL(`https://vera-conecta.test/v/${idPublico}/link`);
  url.searchParams.set("prueba_de_secreto", secreto);
  url.searchParams.set("version_ofrecida", "1");
  url.searchParams.set("identificador_efimero", "conexion-de-prueba");
  const respuesta = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  respuesta.webSocket?.accept();
}

interface AutorizacionPendiente {
  principal_id: string;
  etiqueta_de_aplicacion: string;
  alcances: string[];
  expira_en: string;
}

async function autorizarCliente(
  idPublico: string,
  secretoDeEnlace: string,
  etiqueta = "Claude Desktop",
  alcances = ["read"],
): Promise<Response> {
  return SELF.fetch(`https://vera-conecta.test/v/${idPublico}/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prueba_de_secreto: secretoDeEnlace,
      etiqueta_de_aplicacion: etiqueta,
      alcances,
      evidencia: "bearer_del_piloto",
    }),
  });
}

async function reclamarCredencial(idPublico: string, principalId: string, prueba = principalId): Promise<Response> {
  return SELF.fetch(`https://vera-conecta.test/v/${idPublico}/clients/${principalId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prueba_de_consentimiento: prueba }),
  });
}

async function revocarCliente(idPublico: string, principalId: string, secretoDeEnlace: string): Promise<Response> {
  return SELF.fetch(`https://vera-conecta.test/v/${idPublico}/clients/${principalId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prueba_de_secreto: secretoDeEnlace }),
  });
}

async function refrescarCredencial(idPublico: string, principalId: string, pruebaDeRefresco: string): Promise<Response> {
  return SELF.fetch(`https://vera-conecta.test/v/${idPublico}/clients/${principalId}/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prueba_de_refresco: pruebaDeRefresco }),
  });
}

describe("autorización de clientes", () => {
  it("autoriza un cliente nuevo mientras la instalación está conectada", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);

    const respuesta = await autorizarCliente(id_publico, secreto_de_enlace);
    expect(respuesta.status).toBe(201);
    const cuerpo = (await respuesta.json()) as AutorizacionPendiente;
    expect(cuerpo.principal_id).toBeTruthy();
    expect(cuerpo.alcances).toEqual(["read"]);
  });

  it("no autoriza sin canal abierto ni previamente conectado (estado emparejando)", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    const respuesta = await autorizarCliente(id_publico, secreto_de_enlace);
    expect(respuesta.status).toBe(409);
  });

  it("rechaza autorizar con credencial de enlace inválida", async () => {
    const { id_publico } = await emparejarInstalacion();
    const respuesta = await autorizarCliente(id_publico, "secreto-falso");
    expect(respuesta.status).toBe(401);
  });

  it("rechaza alcances vacíos o desconocidos", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);

    const vacio = await autorizarCliente(id_publico, secreto_de_enlace, "app", []);
    expect(vacio.status).toBe(400);

    const desconocido = await autorizarCliente(id_publico, secreto_de_enlace, "app", ["admin"]);
    expect(desconocido.status).toBe(400);
  });

  it("acepta el alcance delete junto a read y write", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);

    const respuesta = await autorizarCliente(id_publico, secreto_de_enlace, "app", ["read", "write", "delete"]);
    expect(respuesta.status).toBe(201);
    const cuerpo = (await respuesta.json()) as AutorizacionPendiente;
    expect(cuerpo.alcances.sort()).toEqual(["delete", "read", "write"]);
  });
});

describe("reclamo de credencial", () => {
  it("reclama la credencial presentando el principal_id como prueba de consentimiento", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);
    const autorizacion = await autorizarCliente(id_publico, secreto_de_enlace);
    const { principal_id } = (await autorizacion.json()) as AutorizacionPendiente;

    const reclamo = await reclamarCredencial(id_publico, principal_id);
    expect(reclamo.status).toBe(201);
    const cuerpo = (await reclamo.json()) as {
      secreto_de_cliente: string;
      secreto_de_refresco: string;
      alcances: string[];
      expira_en: string;
      refresco_expira_en: string;
    };
    expect(cuerpo.secreto_de_cliente).toBeTruthy();
    expect(cuerpo.secreto_de_refresco).toBeTruthy();
    expect(cuerpo.secreto_de_cliente).not.toBe(cuerpo.secreto_de_refresco);
    expect(cuerpo.alcances).toEqual(["read"]);
    expect(new Date(cuerpo.refresco_expira_en).getTime()).toBeGreaterThan(new Date(cuerpo.expira_en).getTime());
  });

  it("un segundo reclamo del mismo cliente falla: ya no está pendiente", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);
    const autorizacion = await autorizarCliente(id_publico, secreto_de_enlace);
    const { principal_id } = (await autorizacion.json()) as AutorizacionPendiente;

    await reclamarCredencial(id_publico, principal_id);
    const segundo = await reclamarCredencial(id_publico, principal_id);
    expect(segundo.status).toBe(409);
  });

  it("rechaza una prueba de consentimiento que no coincide con el principal_id", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);
    const autorizacion = await autorizarCliente(id_publico, secreto_de_enlace);
    const { principal_id } = (await autorizacion.json()) as AutorizacionPendiente;

    const reclamo = await reclamarCredencial(id_publico, principal_id, "no-es-el-principal-id");
    expect(reclamo.status).toBe(401);
  });
});

describe("refresco de credencial", () => {
  it("rechaza refrescar un cliente cuya credencial de acceso sigue vigente", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);
    const autorizacion = await autorizarCliente(id_publico, secreto_de_enlace);
    const { principal_id } = (await autorizacion.json()) as AutorizacionPendiente;
    const reclamo = await reclamarCredencial(id_publico, principal_id);
    const { secreto_de_refresco } = (await reclamo.json()) as { secreto_de_refresco: string };

    // RefrescarCredencialDeCliente exige estado credencial_vencida:
    // "autorizado" (recién reclamado, sin haber vencido) no basta.
    const respuesta = await refrescarCredencial(id_publico, principal_id, secreto_de_refresco);
    expect(respuesta.status).toBe(409);
  });

  it("rechaza refrescar un cliente pendiente (nunca reclamó su primera credencial)", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);
    const autorizacion = await autorizarCliente(id_publico, secreto_de_enlace);
    const { principal_id } = (await autorizacion.json()) as AutorizacionPendiente;

    const respuesta = await refrescarCredencial(id_publico, principal_id, "cualquier-cosa");
    expect(respuesta.status).toBe(409);
  });

  it("rechaza refrescar un cliente inexistente", async () => {
    const { id_publico } = await emparejarInstalacion();
    const respuesta = await refrescarCredencial(id_publico, "principal-inexistente", "cualquier-cosa");
    expect(respuesta.status).toBe(404);
  });
});

describe("revocación de clientes", () => {
  it("revoca un cliente autorizado sin afectar a otro de la misma instalación", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);

    const autorizacionA = await autorizarCliente(id_publico, secreto_de_enlace, "Claude");
    const { principal_id: principalA } = (await autorizacionA.json()) as AutorizacionPendiente;
    await reclamarCredencial(id_publico, principalA);

    const autorizacionB = await autorizarCliente(id_publico, secreto_de_enlace, "ChatGPT");
    const { principal_id: principalB } = (await autorizacionB.json()) as AutorizacionPendiente;
    await reclamarCredencial(id_publico, principalB);

    const revocacion = await revocarCliente(id_publico, principalA, secreto_de_enlace);
    expect(revocacion.status).toBe(200);

    // Revocar A no interrumpe a B: B sigue pudiendo reclamar... salvo que ya
    // reclamó, así que verificamos que su estado siga siendo 'autorizado'
    // consultando el listado de clientes.
    const listado = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/clients`);
    const { clientes } = (await listado.json()) as { clientes: { principal_id: string; estado: string }[] };
    const estadoA = clientes.find((c) => c.principal_id === principalA)?.estado;
    const estadoB = clientes.find((c) => c.principal_id === principalB)?.estado;
    expect(estadoA).toBe("revocado");
    expect(estadoB).toBe("autorizado");
  });

  it("revocar la instalación arrastra a todos sus clientes", async () => {
    const { id_publico, secreto_de_enlace } = await emparejarInstalacion();
    await abrirEnlaceParaConectar(id_publico, secreto_de_enlace);

    const autorizacion = await autorizarCliente(id_publico, secreto_de_enlace);
    const { principal_id } = (await autorizacion.json()) as AutorizacionPendiente;
    await reclamarCredencial(id_publico, principal_id);

    const revocacionInstalacion = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prueba_de_secreto: secreto_de_enlace }),
    });
    expect(revocacionInstalacion.status).toBe(200);

    const listado = await SELF.fetch(`https://vera-conecta.test/v/${id_publico}/clients`);
    const { clientes } = (await listado.json()) as { clientes: { principal_id: string; estado: string }[] };
    expect(clientes.find((c) => c.principal_id === principal_id)?.estado).toBe("revocado");
  });
});
