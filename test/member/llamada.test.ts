/**
 * Oferta de videollamada a clientes calientes/tibios (member/llamada.local.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rangoMock = vi.fn();
vi.mock("../../src/integrations/calcom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/integrations/calcom")>();
  return { ...actual, getAvailableSlotsRange: (...a: unknown[]) => rangoMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { elegirOpciones, proponerLlamadaTool } from "../../member/llamada.local";
import { llamadasAgendadas } from "../../src/followup/resumenDia";
import type { Env } from "../../src/env";

const H = 3600_000;
// Lunes 12 oct 2026, 08:00 en Madrid
const NOW = Date.UTC(2026, 9, 12, 6, 0);
const slot = (fecha: string, hhmm: string) => `${fecha}T${hhmm}:00.000+02:00`;

describe("elegirOpciones", () => {
  it("2 horarios por día (mañana y tarde) en los primeros 3 días hábiles, solo 10:00–15:30", () => {
    const byDate = {
      "2026-10-12": [slot("2026-10-12", "09:30"), slot("2026-10-12", "10:00"), slot("2026-10-12", "10:30"), slot("2026-10-12", "13:00"), slot("2026-10-12", "16:00")],
      "2026-10-13": [slot("2026-10-13", "10:00"), slot("2026-10-13", "14:00"), slot("2026-10-13", "14:30")],
      "2026-10-14": [slot("2026-10-14", "11:00")],
      "2026-10-15": [slot("2026-10-15", "10:00")],
    };
    const o = elegirOpciones(byDate, NOW);
    expect(o.map((x) => `${x.fecha} ${x.hora}`)).toEqual([
      "2026-10-12 10:00", "2026-10-12 13:00", // hoy: >= 2 h desde las 08:00 → 10:00 ok
      "2026-10-13 10:00", "2026-10-13 14:00",
      "2026-10-14 11:00",
    ]);
  });
  it("ignora fines de semana y lo que queda a menos de 2 h", () => {
    const o = elegirOpciones(
      { "2026-10-12": [slot("2026-10-12", "09:00")], "2026-10-17": [slot("2026-10-17", "10:00")], "2026-10-19": [slot("2026-10-19", "10:00")] },
      NOW + 1.5 * H, // 09:30 → las 10:00 quedan a 30 min
    );
    expect(o.map((x) => x.fecha)).toEqual(["2026-10-19"]);
  });
});

describe("proponerLlamada", () => {
  let env: Env;
  let db: Db;
  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    env = { DB: d1, CALCOM_API_KEY: "k", CALCOM_EVENT_TYPE_ID: "1", CALCOM_TIMEZONE: "Europe/Madrid" } as unknown as Env;
    db = new Db(d1);
    rangoMock.mockReset().mockResolvedValue({ ok: true, byDate: { "2099-01-05": [slot("2099-01-05", "10:00"), slot("2099-01-05", "13:30")] } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  async function cliente(meta: object, contact = "ana@x.com", channel = "ycloud") {
    const id = `${channel}:34600000001`;
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, channel, "34600000001", "Ana López", 1, NOW]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ["l1", id, "Ana López", contact, "compra", JSON.stringify(meta), "new", NOW, NOW]);
    return id;
  }
  const correr = (id: string) => (proponerLlamadaTool(env, () => id) as any).execute({});

  it("cliente frío: no se ofrece llamada", async () => {
    const id = await cliente({ ciudadCompra: "Cali" });
    // quitar el teléfono del canal para que sume menos puntos
    const r = await correr(id);
    expect(r.ofrecerLlamada).toBe(false);
    expect(r.prioridad).toBe("frio");
  });
  it("cliente tibio/caliente: devuelve horarios reales y pide correo si falta", async () => {
    const id = await cliente(
      { ciudadResidencia: "España, Girona", ciudadCompra: "Cali", ahorroDisponible: "10.000", capacidadMensual: "800", tipoEmpleo: "empleado contrato indefinido", entregaInmediataOFutura: "ahora" },
      "",
    );
    const r = await correr(id);
    expect(r.ofrecerLlamada).toBe(true);
    expect(["tibio", "caliente"]).toContain(r.prioridad);
    expect(r.necesitaCorreo).toBe(true);
    expect(r.duracionMin).toBe(30);
    expect(r.opciones.map((o: any) => o.hora)).toEqual(["10:00", "13:30"]);
  });
  it("si no hay huecos o falla la agenda, lo dice para usar el comodín", async () => {
    const id = await cliente({ ahorroDisponible: "10.000", capacidadMensual: "800", tipoEmpleo: "empleado contrato indefinido", entregaInmediataOFutura: "ahora", ciudadResidencia: "España, Girona", ciudadCompra: "Cali" });
    rangoMock.mockResolvedValueOnce({ ok: false, reason: "http_500" });
    const r = await correr(id);
    expect(r.ofrecerLlamada).toBe(true);
    expect(r.opciones).toEqual([]);
    expect(r.message).toContain("comodín");
  });
  it("si ya tiene una llamada agendada, no la ofrece otra vez", async () => {
    const id = await cliente({ ahorroDisponible: "10.000", capacidadMensual: "800", tipoEmpleo: "empleado", entregaInmediataOFutura: "ahora", ciudadResidencia: "España, Girona", ciudadCompra: "Cali" });
    await db.run("INSERT INTO leads (id, conversation_id, name, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ["c1", id, "Ana", "Cita · Videollamada · 2026-10-14 10:00", JSON.stringify({ estado: "Reservada (Cal.com)", calStart: "2026-10-14T10:00:00.000+02:00" }), "new", NOW, NOW]);
    const r = await correr(id);
    expect(r.ofrecerLlamada).toBe(false);
    expect(r.motivo).toBe("ya_tiene_llamada");
  });
});

describe("llamadasAgendadas", () => {
  it("solo cuenta reservas de Cal.com que aún no pasaron", async () => {
    const mf = await createTestMiniflare();
    const db = new Db((await mf.getD1Database("DB")) as any);
    for (const id of ["a", "b", "c"]) {
      await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [`c-${id}`, "ycloud", id, id, 1, 1]);
    }
    const ins = (id: string, meta: object) =>
      db.run("INSERT INTO leads (id, conversation_id, name, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [id, `c-${id}`, "x", "Cita · V", JSON.stringify(meta), "new", NOW, NOW]);
    await ins("a", { estado: "Reservada (Cal.com)", calStart: "2026-10-14T10:00:00.000+02:00" });
    await ins("b", { estado: "Reservada (Cal.com)", calStart: "2026-10-01T10:00:00.000+02:00" }); // pasada
    await ins("c", { estado: "Por confirmar (falló Cal.com)", calStart: "2026-10-14T10:00:00.000+02:00" });
    const m = await llamadasAgendadas(db, NOW);
    expect([...m.keys()]).toEqual(["c-a"]);
  });
});
