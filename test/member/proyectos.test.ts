import { describe, it, expect } from "vitest";
import { masEconomicos } from "../../member/proyectos.local";
import type { Catalogo } from "../../src/vivehome/navegador";

const cat: Catalogo = {
  eur: 4000,
  usd: 3700,
  tipologias: [
    { proyecto: "Altos del Norte", ciudad: "Medellín", area: "52", meses: 30, valor: 238_000_000, pctMin: 20, segmento: "VIS" },
    { proyecto: "Altos del Norte", ciudad: "Medellín", area: "60", meses: 30, valor: 290_000_000, pctMin: 20, segmento: "VIS" },
    { proyecto: "Bello Verde", ciudad: "Bello", area: "48", meses: 24, valor: 215_000_000, pctMin: 20, segmento: "VIS" },
    { proyecto: "Sabaneta Alta", ciudad: "Sabaneta", area: "70", meses: 36, valor: 420_000_000, pctMin: 20, segmento: "NO VIS" },
    { proyecto: "Torre Bogotá", ciudad: "Bogotá D.C.", area: "45", meses: 30, valor: 260_000_000, pctMin: 20, segmento: "VIS" },
    { proyecto: "Caro", ciudad: "Medellín", area: "80", meses: 30, valor: 150_000_000, pctMin: 40, segmento: "VIS" },
  ],
};

describe("proyectos más económicos para atender lo que pide el cliente", () => {
  it("Medellín y su área: uno por proyecto, del más barato al más caro, sin los que piden más de 30 % de inicial", () => {
    const r = masEconomicos(cat, "Medellín");
    expect(r.opciones.map((o) => o.proyecto)).toEqual(["Bello Verde", "Altos del Norte", "Sabaneta Alta"]);
    expect(r.opciones[1].valor).toBe(238_000_000); // el apartamento más económico de ese proyecto
    expect(r.opciones.find((o) => o.proyecto === "Caro")).toBeUndefined();
    expect(r.opciones[0].cuotaMensualPesos).toBeGreaterThan(0);
  });

  it("varias ciudades a la vez", () => {
    const r = masEconomicos(cat, "Bogotá y Medellín");
    expect(r.opciones.map((o) => o.proyecto)).toContain("Torre Bogotá");
    expect(r.opciones.map((o) => o.proyecto)).toContain("Bello Verde");
  });

  it("sin ciudad dicha usa todo el catálogo", () => {
    const r = masEconomicos(cat, "");
    expect(r.sinCiudad).toBe(true);
    expect(r.opciones.length).toBeGreaterThan(0);
  });
});

describe("mensaje con los proyectos más económicos", () => {
  it("dice la verdad del tope, nombra los proyectos y no promete lo que no hay", async () => {
    const { mensajeProyectosEconomicos } = await import("../../member/proyectos.local");
    const r = masEconomicos(cat, "Medellín");
    const t = mensajeProyectosEconomicos("Veronica", "Medellín", r.opciones, 200);
    expect(t).toContain("por menos de 200 millones no hay hoy en Medellín");
    expect(t).toContain("Bello Verde");
    expect(t).toContain("Altos del Norte");
    expect(t.startsWith("Veronica, ")).toBe(true);
    expect(t).toMatch(/¿Alguno te llama la atención\?$/);
  });
});

describe("entrega muy cercana: no se inventa una cuota mensual enorme", () => {
  it("con menos de 12 meses no muestra cuota mensual y lo explica", async () => {
    const { mensajeProyectosEconomicos } = await import("../../member/proyectos.local");
    const t = mensajeProyectosEconomicos("Ana", "Medellín", [
      { proyecto: "Listo Ya", ciudad: "La Estrella", valor: 235_000_000, entregaMeses: 1, area: "50", cuotaMensualPesos: 69_500_000, cuotaMensualEuros: 17_000, pctInicial: 20 },
      { proyecto: "Largo Plazo", ciudad: "Bello", valor: 209_000_000, entregaMeses: 19, area: "50", cuotaMensualPesos: 2_150_000, cuotaMensualEuros: 540, pctInicial: 20 },
    ], null);
    expect(t).toContain("entrega inmediata o casi inmediata");
    expect(t).not.toMatch(/69\.500\.000/);
    expect(t).toMatch(/2\.150\.000 pesos al mes/);
    expect(t).not.toMatch(/en unos 1 meses/);
  });
});
