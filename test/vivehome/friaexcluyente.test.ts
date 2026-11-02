import { describe, it, expect } from "vitest";
import { friaExcluyente } from "../../src/vivehome/cola";

const lead = (nivel: string, meta: Record<string, string>) => ({ prioridad: { nivel }, ficha: { metadata: meta } }) as never;

describe("friaExcluyente", () => {
  it("frío solo por cuota baja NO se excluye: recibe la cotización con los más económicos (Pilar, 2 nov 2026)", () => {
    expect(friaExcluyente(lead("frio", { capacidadMensual: "100 euros" }))).toBe(false);
  });
  it("frío por ingresos bajos sí se excluye", () => {
    expect(friaExcluyente(lead("frio", { ingresosMensuales: "1000 euros", capacidadMensual: "500 euros" }))).toBe(true);
  });
  it("tibio y caliente no se excluyen", () => {
    expect(friaExcluyente(lead("tibio", {}))).toBe(false);
  });
});
