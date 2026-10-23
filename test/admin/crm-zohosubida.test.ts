/** Subida de clientes a Zoho: elegibilidad, duplicados y lo que se escribe. Zoho está simulado. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { armarNota, elegirOpcion, resumirNotas } from "../../member/crm-zohosubida.local";

describe("elegirOpcion", () => {
  const ciudades = ["Medellín", "Bogotá", "Neiva", "Armenia", "Otra"];
  it("encuentra la opción dentro del texto y sin tildes", () => {
    expect(elegirOpcion("Neiva, Huila", ciudades)).toBe("Neiva");
    expect(elegirOpcion("medellin y alrededores", ciudades)).toBe("Medellín");
    expect(elegirOpcion("Mosquera", ciudades)).toBe("");
  });
  it("usa alias (EEUU → Estados Unidos)", () => {
    expect(elegirOpcion("EEUU", ["España", "Estados Unidos"], { eeuu: "Estados Unidos" })).toBe("Estados Unidos");
  });
});

describe("resumirNotas", () => {
  it("quita las repeticiones de «Autorizo el registro de datos»", () => {
    const r = resumirNotas("Autorizo el registro de datos: si (2026-10-19). Origen: Instagram. | Autorizo el registro de datos: si (2026-10-20). Origen: Instagram. Pregunta: cuota inicial.");
    expect(r).toBe("Origen: Instagram. Pregunta: cuota inicial.");
  });
});

describe("armarNota con prospección incompleta", () => {
  const lead = { ficha: { metadata: { ciudadCompra: "Cali" }, notas: "" } } as never;
  it("avisa qué falta y que se sube para activarlo", () => {
    const n = armarNota(lead, false, "", "WhatsApp", Date.UTC(2026, 9, 23, 12), ["ingresosMensuales", "capacidadMensual"]);
    expect(n).toContain("Prospección incompleta: faltan ingresos, cuánto puede pagar al mes");
    expect(n).toContain("intentar activarlo");
    expect(n.toLowerCase()).not.toMatch(/\bbot\b/);
  });
  it("completa: no lleva ese aviso", () => {
    expect(armarNota(lead, false, "", "WhatsApp", Date.UTC(2026, 9, 23, 12))).not.toContain("incompleta");
  });
});
