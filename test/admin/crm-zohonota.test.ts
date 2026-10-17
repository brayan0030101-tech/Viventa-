/**
 * CRM de Maricela: nota y tarea listas para Zoho.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { notaZoho, tarjetaNotaZoho, tarjetaNotaZohoContenido } from "../../member/crm-zohonota.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const CONV = "ycloud:34600000001";

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
  generarMock.mockReset().mockResolvedValue({ text: '```json\n{"nota":"El cliente vive en Madrid y busca casa en Medellín con 20 mil euros de ahorro.","tarea":"Llamar para ofrecer proyectos","cuando":""}\n```' });
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [CONV, "ycloud", "34600000001", "Ana López", NOW - 9e6, NOW - 8e6]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ["l1", CONV, "Ana López", "34600000001", "compra", JSON.stringify({ ciudadCompra: "Medellín", ahorroDisponible: "20 mil euros" }), "new", NOW - 9e6, NOW - 9e6]);
  for (let i = 0; i < 4; i++) await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), CONV, i % 2 ? "assistant" : "user", i % 2 ? "¿Cuál es tu presupuesto?" : "Hola soy Ana López, mi correo ana@correo.com", NOW - 9e6 + i]);
});

describe("nota y tarea para Zoho", () => {
  it("genera la nota sin datos personales y no gasta IA si no hay novedades", async () => {
    const r = await notaZoho(env, CONV, {}, NOW);
    expect(r.ok && r.nota.nota).toContain("Madrid");
    const prompt = (generarMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Ana López");
    expect(prompt).not.toContain("ana@correo.com");
    expect(r.ok && r.nota.tarea).toBe("Llamar para ofrecer proyectos");
    const otra = await notaZoho(env, CONV, {}, NOW + 1000);
    expect(otra.ok && otra.reutilizada).toBe(true);
    expect(generarMock).toHaveBeenCalledTimes(1);
    await notaZoho(env, CONV, { forzar: true }, NOW + 2000);
    expect(generarMock).toHaveBeenCalledTimes(2);
  });

  it("con videollamada agendada la tarea es «Videollamada programada» con su fecha", async () => {
    // La tarjeta usa el reloj real: la llamada se fija 3 días por delante de hoy para que siga «agendada» (antes era una fecha fija que venció).
    const inicio = Date.now() + 3 * 86_400_000;
    const diaMadrid = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "numeric" }).format(new Date(inicio));
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["cita1", CONV, "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: new Date(inicio).toISOString(), estado: "Reservada (Cal.com)" }), "new", NOW - 1000, NOW - 1000]);
    const r = await notaZoho(env, CONV, {}, NOW);
    expect(r.ok && r.nota.tarea).toBe("Videollamada programada");
    expect(r.ok && r.nota.cuando).toContain(diaMadrid);
    const html = await tarjetaNotaZohoContenido(env, CONV);
    expect(html).toContain("Videollamada programada —");
    expect(html).toContain("Copiar");
  });

  it("falla con gracia y la tarjeta se carga sola", async () => {
    generarMock.mockRejectedValueOnce(new Error("boom"));
    expect((await notaZoho(env, CONV, {}, NOW)).ok).toBe(false);
    expect((await notaZoho(env, "nada", {}, NOW)).ok).toBe(false);
    expect(tarjetaNotaZoho(CONV)).toContain('hx-trigger="load"');
  });
});
