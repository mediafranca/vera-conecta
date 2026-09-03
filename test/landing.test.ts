import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("página pública en la raíz", () => {
  it("GET / responde HTML sin exponer nada del relay", async () => {
    const response = await SELF.fetch("https://vera-conecta.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Vera Conecta");
    expect(body).toContain("todavía no operativo");
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
