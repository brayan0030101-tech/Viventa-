/**
 * CRM de Maricela: «Gastos ChatBot» — carga inicial única, alta con validación, borrado y totales.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { agregarGasto, borrarGasto, cop, listarGastos, renderGastos, validarGasto } from "../../member/crm-gastos.local";
import type { Env } from "../../src/env";

let env: Env;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  env = { DB: (await mf.getD1Database("DB")) as any, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
});

describe("gastos del chatbot", () => {
  it("carga los 6 gastos iniciales y suman 430.000", async () => {
    const g = await listarGastos(env);
    expect(g).toHaveLength(6);
    expect(g.reduce((s, x) => s + x.monto, 0)).toBe(430000);
    expect(g.filter((x) => x.categoria === "API (Claude)").map((x) => x.monto).sort()).toEqual([35000, 50000, 67000]);
  });

  it("la carga inicial no se repite ni revive lo borrado", async () => {
    await listarGastos(env);
    await borrarGasto(env, "ini-1");
    const g = await listarGastos(env);
    expect(g).toHaveLength(5);
    expect(g.some((x) => x.id === "ini-1")).toBe(false);
  });

  it("agrega un gasto con monto escrito con puntos y valida los datos", async () => {
    expect(await agregarGasto(env, { fecha: "2026-10-20", categoria: "YCloud", detalle: "Recarga", monto: "$120.000" })).toEqual({ ok: true });
    expect((await listarGastos(env)).find((x) => x.detalle === "Recarga")?.monto).toBe(120000);
    expect(validarGasto({ fecha: "mañana", monto: "100" }).ok).toBe(false);
    expect(validarGasto({ fecha: "2026-10-20", monto: "0" }).ok).toBe(false);
    expect(validarGasto({ fecha: "2026-10-20", monto: "abc" }).ok).toBe(false);
    const r = validarGasto({ fecha: "2026-10-20", categoria: "inventada", monto: "5000" });
    expect(r.ok && r.g.categoria).toBe("Otro");
  });

  it("la página muestra total, categorías y escapa el detalle", async () => {
    await agregarGasto(env, { fecha: "2026-10-21", categoria: "Otro", detalle: "<b>x</b>", monto: "1000" });
    const html = await renderGastos(env);
    expect(html).toContain("Gastos ChatBot");
    expect(html).toContain(cop(431000));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});
