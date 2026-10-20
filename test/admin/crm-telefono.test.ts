import { describe, it, expect } from "vitest";
import { normalizarTelefono } from "../../member/crm.local";

describe("normalizarTelefono", () => {
  it("acepta número con indicativo", () => {
    expect(normalizarTelefono("+34 612 345 678")).toBe("+34612345678");
    expect(normalizarTelefono("0057 300 123 4567")).toBe("+573001234567");
  });
  it("completa +34 solo a móviles españoles de 9 dígitos", () => {
    expect(normalizarTelefono("612345678")).toBe("+34612345678");
    expect(normalizarTelefono("3001234567")).toBeNull();
  });
  it("rechaza números cortos o con letras", () => {
    expect(normalizarTelefono("1234")).toBeNull();
    expect(normalizarTelefono("hola")).toBeNull();
  });
});
