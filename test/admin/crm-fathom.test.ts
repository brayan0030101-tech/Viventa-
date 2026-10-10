/**
 * Fathom → CRM: firma del webhook, emparejar con la cita y análisis automático.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));
const notifyMock = vi.fn();
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyMock(...a), camilaConfigured: () => true };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { verificarFirmaFathom, procesarReunionFathom, transcripcionATexto, emparejarLlamada } from "../../member/crm-fathom.local";
import { ultimoResultado, pendientesDe } from "../../member/crm-resultados.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 12, 0);

const frase = "Hola, gracias por conectarte. Cuéntame qué buscas en Medellín y cuál es tu presupuesto.";
const reunion = (over: Record<string, unknown> = {}) => ({
  recording_id: 111,
  title: "Videollamada con Maricela",
  scheduled_start_time: "2026-10-12T09:00:00.000Z",
  calendar_invitees: [{ name: "Ana", email: "ana@correo.com", is_external: true }],
  transcript: Array.from({ length: 6 }, (_, i) => ({ speaker: { display_name: i % 2 ? "Ana" : "Maricela" }, text: frase, timestamp: `00:0${i}:00` })),
  ...over,
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
  generarMock.mockReset().mockResolvedValue({ text: JSON.stringify({ resultado: "concretado", resumen: "Ana quiere comprar.", interes: 5, venta_cerrada: false, pendientes: [{ tarea: "Enviar proyectos", responsable: "Maricela", cuando: "" }] }) });
  notifyMock.mockReset().mockResolvedValue(true);
  for (const [conv, nombre, correo, h] of [["ycloud:34600000001", "Ana López", "ana@correo.com", "09:00"], ["ycloud:34600000002", "Luis Mora", "luis@correo.com", "09:30"]] as const) {
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [conv, "ycloud", conv.slice(-11), nombre, NOW - 9e6, NOW - 8e6]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [`l-${conv}`, conv, nombre, correo, "compra", JSON.stringify({ correo }), "new", NOW - 9e6, NOW - 9e6]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [`cita-${conv}`, conv, "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: `2026-10-12T${h}:00.000Z`, estado: "Reservada (Cal.com)" }), "new", NOW - 9e6, NOW - 9e6]);
  }
});

describe("firma del webhook de Fathom", () => {
  async function firmar(secretoB64: string, id: string, ts: string, cuerpo: string) {
    const k = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secretoB64), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return "v1," + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${cuerpo}`)))));
  }
  const secretoB64 = btoa("clave-de-prueba-123456");
  it("acepta la firma buena y rechaza la mala o vieja", async () => {
    const ts = String(Math.floor(NOW / 1000));
    const firma = await firmar(secretoB64, "msg1", ts, '{"a":1}');
    expect(await verificarFirmaFathom(`whsec_${secretoB64}`, { id: "msg1", timestamp: ts, firma }, '{"a":1}', NOW)).toBe(true);
    expect(await verificarFirmaFathom(`whsec_${secretoB64}`, { id: "msg1", timestamp: ts, firma: `v1,otra ${firma}` }, '{"a":1}', NOW)).toBe(true);
    expect(await verificarFirmaFathom(`whsec_${secretoB64}`, { id: "msg1", timestamp: ts, firma }, '{"a":2}', NOW)).toBe(false);
    expect(await verificarFirmaFathom(`whsec_${secretoB64}`, { id: "msg1", timestamp: ts, firma }, '{"a":1}', NOW + 10 * 60_000)).toBe(false);
    expect(await verificarFirmaFathom(`whsec_${secretoB64}`, { id: "", timestamp: ts, firma: "" }, "", NOW)).toBe(false);
  });
});

describe("reunión de Fathom → análisis automático", () => {
  it("empareja por correo cuando hay dos citas cercanas y analiza", async () => {
    expect(await emparejarLlamada(env, reunion() as never, NOW)).toBe("cita-ycloud:34600000001");
    expect(await emparejarLlamada(env, reunion({ calendar_invitees: [{ email: "luis@correo.com", is_external: true }] }) as never, NOW)).toBe("cita-ycloud:34600000002");
    const r = await procesarReunionFathom(env, reunion() as never, NOW);
    expect(r.estado).toBe("analizada");
    expect((await ultimoResultado(env, "cita-ycloud:34600000001"))?.analisis.resultado).toBe("concretado");
    expect((await pendientesDe(env, { leadId: "cita-ycloud:34600000001" }))[0]?.texto).toBe("Enviar proyectos");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("no procesa dos veces la misma grabación", async () => {
    await procesarReunionFathom(env, reunion() as never, NOW);
    expect((await procesarReunionFathom(env, reunion() as never, NOW)).estado).toBe("duplicada");
    expect(generarMock).toHaveBeenCalledTimes(1);
  });

  it("avisa si no hay cita asociada y no gasta IA; ignora transcripciones vacías", async () => {
    const r = await procesarReunionFathom(env, reunion({ recording_id: 5, scheduled_start_time: "2026-10-20T09:00:00.000Z" }) as never, NOW);
    expect(r.estado).toBe("sin_cita");
    expect(generarMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect((await procesarReunionFathom(env, reunion({ recording_id: 6, transcript: null }) as never, NOW)).estado).toBe("sin_transcripcion");
    expect(transcripcionATexto(reunion() as never)).toContain("[00:00:00] Maricela:");
  });

  it("si la IA falla, deja que Fathom reintente", async () => {
    generarMock.mockRejectedValueOnce(new Error("boom"));
    expect((await procesarReunionFathom(env, reunion() as never, NOW)).estado).toBe("error");
    expect((await procesarReunionFathom(env, reunion() as never, NOW)).estado).toBe("analizada");
  });
});
