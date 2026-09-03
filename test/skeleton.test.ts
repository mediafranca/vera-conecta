import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("borde del relay", () => {
  it("/health responde sin exponer estado de instalaciones", async () => {
    const response = await SELF.fetch("https://vera-conecta.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: "vera-conecta" });
  });

  it("cierra las rutas de producto que aún no están probadas extremo a extremo", async () => {
    const response = await SELF.fetch("https://vera-conecta.test/v/inexistente/mcp");
    expect(response.status).toBe(501);
  });
});
