import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("página pública en la raíz", () => {
  it("GET / muestra el estado de staging sin exponer nada del relay", async () => {
    const response = await SELF.fetch("https://vera-conecta.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain("Vera Conecta");
    expect(body).toContain("Entorno de prueba activo");
    expect(body).toContain("El corpus, sus objetos, su historia");
    expect(body).toContain("La URL no autoriza");
    expect(body).not.toContain("<script");
  });

  it("distingue el dominio productivo", async () => {
    const response = await SELF.fetch("https://conecta.mediafranca.net/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Servicio comunitario disponible");
  });

  it("no interfiere con las rutas del relay", async () => {
    const health = await SELF.fetch("https://vera-conecta.test/health");
    expect(health.status).toBe(200);
    const closed = await SELF.fetch("https://vera-conecta.test/v/inexistente/mcp");
    expect(closed.status).toBe(501);
  });

  it("no responde HTML para métodos que no son GET", async () => {
    const response = await SELF.fetch("https://vera-conecta.test/", { method: "POST" });
    expect(response.status).toBe(501);
  });
});
