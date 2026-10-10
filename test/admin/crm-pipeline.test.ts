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
import { cargarPipeline, fijarEtapa, renderCrmPipeline } from "../../member/crm-pipeline.local";
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

  it("dibuja el tablero con todas las columnas", async () => {
    const html = await renderCrmPipeline(env, NOW);
    for (const n of ["Nuevo", "Calificado", "Llamada agendada", "Llamada hecha", "Negociando", "Cerrado", "Perdido"]) expect(html).toContain(n);
    expect(html).toContain("Ana López");
    expect(html).toContain('hx-post="/crm/etapa"');
  });
});
