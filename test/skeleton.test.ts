import { describe, expect, it } from "vitest";

describe("esqueleto de Vera Conecta", () => {
  it("no declara el relay listo antes de implementarlo", () => {
    expect("design-skeleton").not.toBe("ready");
  });
});
