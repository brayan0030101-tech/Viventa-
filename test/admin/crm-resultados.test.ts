/**
 * CRM de Maricela: resultado de la videollamada a partir de la transcripción.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { analizarLlamada, limpiarTranscripcion, leerAnalisis, pendientesDe, alternarPendiente, seccionResultado, tarjetaPendientes } from "../../member/crm-resultados.local";
import { renderLlamadaDetalle } from "../../member/crm-calendario.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const CONV = "ycloud:34600000001";
const LARGA = "Maricela: Hola Ana, ¿cómo estás? ".repeat(15) + "Ana: Quiero comprar en Medellín con 20 mil euros.";

const JSON_OK = JSON.stringify({
  resultado: "parcial",
  resumen: "Ana quiere comprar en Medellín. Falta enviar el listado de proyectos.",
  concretado: ["Maricela enviará proyectos"],
  no_concretado: ["No definió el presupuesto final"],
  objeciones: ["Teme la tasa de cambio"],
  interes: 4,
  proximo_paso: "Enviar proyectos por WhatsApp",
  pendientes: [{ tarea: "Enviar listado de proyectos", responsable: "Maricela", cuando: "esta semana" }, { tarea: "Enviar pasaporte", responsable: "Cliente", cuando: "" }],
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
  generarMock.mockReset().mockResolvedValue({ text: "```json\n" + JSON_OK + "\n```" });
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [CONV, "ycloud", "34600000001", "Ana López", NOW - 9e6, NOW - 8e6]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ["cita1", CONV, "Ana López", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: "2026-10-12T09:00:00.000Z", estado: "Reservada (Cal.com)" }), "new", NOW - 9e6, NOW - 9e6]);
});

describe("resultado de la llamada", () => {
  it("interpreta la transcripción, la guarda y crea los pendientes", async () => {
    const r = await analizarLlamada(env, "cita1", LARGA, NOW);
    expect(r.ok).toBe(true);
    const prompt = (generarMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Ana López");
    expect(prompt).toContain("Medellín");
    const ps = await pendientesDe(env, { leadId: "cita1" });
    expect(ps.map((p) => p.texto)).toEqual(expect.arrayContaining(["Enviar listado de proyectos", "Enviar pasaporte"]));
    const html = await seccionResultado(env, "cita1");
    expect(html).toContain("Avance parcial");
    expect(html).toContain("Teme la tasa de cambio");
    expect(html).toContain("Enviar pasaporte");
    expect(await tarjetaPendientes(env, CONV)).toContain("2 por hacer");
    expect(await renderLlamadaDetalle(env, "cita1", NOW)).toContain("Resultado de la llamada");
  });

  it("marca un pendiente como hecho y lo reabre", async () => {
    await analizarLlamada(env, "cita1", LARGA, NOW);
    const [p] = await pendientesDe(env, { leadId: "cita1" });
    expect((await alternarPendiente(env, p.id, NOW))?.hecho).toBe(true);
    expect((await alternarPendiente(env, p.id, NOW))?.hecho).toBe(false);
  });

  it("falla con gracia: transcripción corta, llamada inexistente, IA caída o respuesta ilegible", async () => {
    expect((await analizarLlamada(env, "cita1", "hola", NOW)).ok).toBe(false);
    expect((await analizarLlamada(env, "nada", LARGA, NOW)).ok).toBe(false);
    generarMock.mockRejectedValueOnce(new Error("boom"));
    expect((await analizarLlamada(env, "cita1", LARGA, NOW)).ok).toBe(false);
    generarMock.mockResolvedValueOnce({ text: "no es json" });
    expect((await analizarLlamada(env, "cita1", LARGA, NOW)).ok).toBe(false);
    expect(await pendientesDe(env, { leadId: "cita1" })).toHaveLength(0);
  });

  it("limpia subtítulos .vtt/.srt y lee JSON con valores raros", () => {
    expect(limpiarTranscripcion("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Ana>Hola\n\n2\n00:00:04.000 --> 00:00:05.000\nAdiós")).toBe("Hola\nAdiós");
    const a = leerAnalisis('{"resultado":"raro","resumen":"ok","interes":99,"pendientes":[{"tarea":""},{"tarea":"x"}]}');
    expect(a?.resultado).toBe("no_concretado");
    expect(a?.interes).toBe(5);
    expect(a?.pendientes).toHaveLength(1);
  });
});
