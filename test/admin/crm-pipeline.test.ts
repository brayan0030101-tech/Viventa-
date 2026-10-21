/**
 * CRM de Maricela: pipeline por etapas.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { cargarPipeline, fijarEtapa, avanzarPorResultado, renderCrmPipeline } from "../../member/crm-pipeline.local";
import { analizarLlamada } from "../../member/crm-resultados.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const LARGA = "Maricela: Hola, ¿cómo estás? ".repeat(15) + "Cliente: quiero comprar.";

async function cliente(id: string, nombre: string, conDatos = true) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", id.slice(-11), conDatos ? nombre : null, NOW - 9e6, NOW - 1e6]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [`l-${id}`, id, conDatos ? nombre : "", conDatos ? id.slice(-11) : "", "compra", JSON.stringify(conDatos ? { ciudadCompra: "Medellín", ahorroDisponible: "20 mil euros", cuotaMensual: "800 euros", ingresosMensuales: "3000", tipoEmpleo: "empleado", ciudadResidencia: "Madrid" } : {}), "new", NOW - 5e6, NOW - 5e6]);
}
const etapaDe = async (id: string) => (await cargarPipeline(env, NOW)).find((t) => t.fila.lead.convId === id)?.etapa;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
  generarMock.mockReset().mockResolvedValue({ text: JSON.stringify({ resultado: "concretado", resumen: "Todo bien", interes: 5, pendientes: [] }) });
  await cliente("ycloud:34600000001", "Ana López");
  await cliente("ycloud:34600000002", "Sin Datos", false);
});

describe("pipeline", () => {
  it("calcula la etapa sola y respeta lo que se mueve a mano", async () => {
    expect(await etapaDe("ycloud:34600000001")).toBe("calificado");
    expect(await etapaDe("ycloud:34600000002")).toBe("nuevo");
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["cita1", "ycloud:34600000001", "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: "2026-10-14T09:00:00.000Z", estado: "Reservada (Cal.com)" }), "new", NOW - 1000, NOW - 1000]);
    expect(await etapaDe("ycloud:34600000001")).toBe("agendada");
    expect(await fijarEtapa(env, "ycloud:34600000001", "cerrado")).toBe(true);
    expect(await etapaDe("ycloud:34600000001")).toBe("cerrado");
    expect(await fijarEtapa(env, "ycloud:34600000001", "inventada")).toBe(false);
    await fijarEtapa(env, "ycloud:34600000001", "auto");
    expect(await etapaDe("ycloud:34600000001")).toBe("agendada");
  });

  it("al interpretar la llamada el cliente avanza a «Negociando», salvo que esté cerrado a mano", async () => {
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["cita1", "ycloud:34600000001", "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: "2026-10-12T09:00:00.000Z", estado: "Reservada (Cal.com)" }), "new", NOW - 9e6, NOW - 9e6]);
    expect(await etapaDe("ycloud:34600000001")).toBe("hecha");
    await analizarLlamada(env, "cita1", LARGA, NOW);
    expect(await etapaDe("ycloud:34600000001")).toBe("negociando");
    await fijarEtapa(env, "ycloud:34600000001", "perdido");
    await analizarLlamada(env, "cita1", LARGA, NOW + 1000);
    expect(await etapaDe("ycloud:34600000001")).toBe("perdido");
  });

  it("«En cierre»: caliente + ya habló con Maricela + estado «Formulario CC» en Zoho", async () => {
    const id = "ycloud:34600000001";
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["cita1", id, "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: "2026-10-12T09:00:00.000Z", estado: "Reservada (Cal.com)" }), "new", NOW - 9e6, NOW - 9e6]);
    // Habló con Maricela y es caliente, pero aún no se le envió el formulario: sigue en «Llamada hecha».
    await db.run("UPDATE leads SET metadata = ? WHERE id = ?", [JSON.stringify({ ciudadCompra: "Medellín", ahorroDisponible: "20 mil euros", capacidadMensual: "500 euros", ingresosMensuales: "3000", tipoEmpleo: "empleado", ciudadResidencia: "Madrid" }), `l-${id}`]);
    expect(await etapaDe(id)).toBe("hecha");
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.zoho_estado', 'Formulario CC') WHERE id = ?", [id]);
    expect(await etapaDe(id)).toBe("cierre");
    // Sin ser caliente no entra, aunque esté registrado.
    await db.run("UPDATE leads SET metadata = ? WHERE id = ?", [JSON.stringify({ ciudadCompra: "Medellín" }), `l-${id}`]);
    expect(await etapaDe(id)).toBe("hecha");
  });

  it("dibuja el tablero con todas las columnas", async () => {
    const html = await renderCrmPipeline(env, NOW);
    for (const n of ["Nuevo", "Calificado", "Llamada agendada", "Llamada hecha", "En cierre", "Negociando", "Cerrado", "Perdido"]) expect(html).toContain(n);
    expect(html).toContain("Ana López");
    expect(html).toContain('hx-post="/crm/etapa"');
  });
});

describe("«Más probables de comprar»", () => {
  it("Maricela agrega, el cliente se queda ahí y se va al negociar/cerrar/quitar; lo recién agregado va arriba", async () => {
    await cliente("ycloud:34600000003", "Beto Ruiz");
    expect(await fijarEtapa(env, "ycloud:34600000001", "probable")).toBe(true);
    expect(await etapaDe("ycloud:34600000001")).toBe("probable");
    await new Promise((r) => setTimeout(r, 5));
    await fijarEtapa(env, "ycloud:34600000003", "probable");
    const t = (await cargarPipeline(env, NOW)).filter((x) => x.etapa === "probable").sort((a, b) => (b.probableEn ?? 0) - (a.probableEn ?? 0));
    expect(t.map((x) => x.fila.lead.convId)).toEqual(["ycloud:34600000003", "ycloud:34600000001"]);
    // volver a pulsar no cambia la fecha original
    const antes = (await cargarPipeline(env, NOW)).find((x) => x.fila.lead.convId === "ycloud:34600000001")!.probableEn;
    await fijarEtapa(env, "ycloud:34600000001", "probable");
    expect((await cargarPipeline(env, NOW)).find((x) => x.fila.lead.convId === "ycloud:34600000001")!.probableEn).toBe(antes);
    // negociando / cerrado / quitar → sale de la lista y se borra la marca
    await fijarEtapa(env, "ycloud:34600000001", "negociando");
    expect(await etapaDe("ycloud:34600000001")).toBe("negociando");
    expect((await cargarPipeline(env, NOW)).find((x) => x.fila.lead.convId === "ycloud:34600000001")!.probableEn).toBeUndefined();
    await fijarEtapa(env, "ycloud:34600000003", "auto");
    expect(await etapaDe("ycloud:34600000003")).not.toBe("probable");
  });

  it("una llamada sin avance no lo saca de la lista; una con avance concreto sí", async () => {
    await fijarEtapa(env, "ycloud:34600000001", "probable");
    await avanzarPorResultado(env, "ycloud:34600000001", "sin_avance");
    expect(await etapaDe("ycloud:34600000001")).toBe("probable");
    await avanzarPorResultado(env, "ycloud:34600000001", "concretado");
    expect(await etapaDe("ycloud:34600000001")).toBe("negociando");
  });

  it("el tablero trae la columna, el buscador con los clientes de la base y un script válido", async () => {
    await fijarEtapa(env, "ycloud:34600000001", "probable");
    const html = await renderCrmPipeline(env, NOW);
    expect(html).toContain("Más probables de comprar");
    expect(html).toContain('id="pl-q"');
    expect(html).toContain('"n":"(sin nombre)"'); // todos los clientes de la base van en el buscador (también los sin nombre)
    expect(html).toContain('"n":"Ana López","t":"+34600000001"');
    expect(html).toContain("Quitar de esta lista");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const sc of scripts) expect(() => new Function(sc)).not.toThrow();
  });

  it("el buscador del navegador encuentra por nombre (sin tildes), correo o teléfono y no ofrece a los que ya están", async () => {
    await db.run("UPDATE leads SET contact = ? WHERE id = 'l-ycloud:34600000001'", ["ana@correo.com"]);
    await cliente("ycloud:34600000003", "Beto Ruiz");
    await fijarEtapa(env, "ycloud:34600000003", "probable");
    const html = await renderCrmPipeline(env, NOW);
    const sc = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((x) => x.includes("pl-q"))!;
    const handlers: Record<string, Array<(e: any) => void>> = {};
    const q = { value: "", addEventListener: (ev: string, f: (e: any) => void) => (handlers["q" + ev] ??= []).push(f) };
    const res = { innerHTML: "", addEventListener: (ev: string, f: (e: any) => void) => (handlers["r" + ev] ??= []).push(f) };
    const doc = { getElementById: (id: string) => (id === "pl-q" ? q : id === "pl-res" ? res : { getAttribute: () => "/crm/etapa" }), querySelectorAll: () => ({ forEach() {} }) };
    new Function("document", "fetch", "location", sc)(doc, async () => ({ ok: true }), { reload() {} });
    const buscar = (v: string) => { q.value = v; handlers["qinput"]!.forEach((f) => f({})); return res.innerHTML; };
    expect(buscar("lópez")).toContain("Ana López");
    expect(buscar("lopez")).toContain("Ana López"); // sin tildes
    expect(buscar("ana@corr")).toContain("Ana López");
    expect(buscar("0000001")).toContain("Ana López"); // por teléfono
    expect(buscar("beto")).toContain("No encuentro"); // ya está en la lista
    expect(buscar("zzzzzz")).toContain("No encuentro");
    expect(buscar("a")).toBe(""); // menos de 2 letras no busca
  });
});
