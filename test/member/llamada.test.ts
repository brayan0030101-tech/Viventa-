/**
 * Oferta de videollamada a clientes calientes/tibios (member/llamada.local.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rangoMock = vi.fn();
const reservasMock = vi.fn();
vi.mock("../../src/integrations/calcom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/integrations/calcom")>();
  return { ...actual, getAvailableSlotsRange: (...a: unknown[]) => rangoMock(...a), getUpcomingBookingStarts: (...a: unknown[]) => reservasMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { elegirOpciones, armarDias, tachar, proponerLlamadaTool, botonDia, botonesHoras } from "../../member/llamada.local";
import { llamadasAgendadas } from "../../src/followup/resumenDia";
import type { Env } from "../../src/env";

const H = 3600_000;
// Lunes 12 oct 2026, 08:00 en Madrid
const NOW = Date.UTC(2026, 9, 12, 6, 0);
const slot = (fecha: string, hhmm: string) => `${fecha}T${hhmm}:00.000+02:00`;

describe("elegirOpciones", () => {
  it("hasta 4 horarios por día repartidos, en los primeros 3 días hábiles, solo 10:00–15:30", () => {
    const byDate = {
      "2026-10-12": [slot("2026-10-12", "09:30"), slot("2026-10-12", "10:00"), slot("2026-10-12", "10:30"), slot("2026-10-12", "13:00"), slot("2026-10-12", "16:00")],
      "2026-10-13": [slot("2026-10-13", "10:00"), slot("2026-10-13", "14:00"), slot("2026-10-13", "14:30")],
      "2026-10-14": [slot("2026-10-14", "11:00")],
      "2026-10-15": [slot("2026-10-15", "10:00")],
    };
    const o = elegirOpciones(byDate, NOW);
    expect(o.map((x) => `${x.fecha} ${x.hora}`)).toEqual([
      "2026-10-12 10:00", "2026-10-12 10:30", "2026-10-12 13:00", // 09:30 y 16:00 quedan fuera
      "2026-10-13 10:00", "2026-10-13 14:00", "2026-10-13 14:30",
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
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_llamada_modo','activo',1)");
    rangoMock.mockReset().mockResolvedValue({ ok: true, byDate: { "2099-01-05": [slot("2099-01-05", "10:00"), slot("2099-01-05", "13:30")] } });
    reservasMock.mockReset().mockResolvedValue({ ok: true, starts: [] });
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

describe("armarDias: 4 por día y tachados REALES", () => {
  const dia = (f: string) => ["10:00", "10:30", "11:00", "11:30", "12:00", "13:00", "14:00", "15:00"].map((h) => slot(f, h));
  it("reparte 4 horarios a lo largo del día", () => {
    const [d] = armarDias({ "2026-10-13": dia("2026-10-13") }, [], NOW);
    expect(d.opciones.map((o) => o.hora)).toEqual(["10:00", "11:00", "13:00", "15:00"]);
  });
  it("tacha solo las horas ya reservadas de verdad (máx. 2 por día) y nunca inventa", () => {
    const libres = dia("2026-10-13").filter((s) => !s.includes("T12:00") && !s.includes("T10:30"));
    const [d] = armarDias(
      { "2026-10-13": libres },
      [{ fecha: "2026-10-13", hora: "10:30" }, { fecha: "2026-10-13", hora: "12:00" }, { fecha: "2026-10-13", hora: "09:00" }, { fecha: "2026-10-14", hora: "11:00" }],
      NOW,
    );
    expect(d.ocupadas).toEqual(["10:30", "12:00"]);
    expect(d.linea).toContain(tachar("10:30"));
    expect(d.linea).toContain(tachar("12:00"));
    expect(d.linea).not.toContain(tachar("09:00")); // fuera de 10–16
  });
  it("sin reservas reales no hay nada tachado", () => {
    const [d] = armarDias({ "2026-10-13": dia("2026-10-13") }, [], NOW);
    expect(d.ocupadas).toEqual([]);
    expect(d.linea).not.toContain("\u0336");
  });
});

describe("interruptor de la oferta de llamada", () => {
  let env: Env;
  let db: Db;
  const COMPLETO = { ciudadResidencia: "España, Girona", ciudadCompra: "Cali", ahorroDisponible: "10.000", capacidadMensual: "800", tipoEmpleo: "empleado contrato indefinido", entregaInmediataOFutura: "ahora" };
  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    env = { DB: d1, CALCOM_API_KEY: "k", CALCOM_EVENT_TYPE_ID: "1", CALCOM_TIMEZONE: "Europe/Madrid" } as unknown as Env;
    db = new Db(d1);
    rangoMock.mockReset().mockResolvedValue({ ok: true, byDate: { "2099-01-05": [slot("2099-01-05", "10:00")] } });
    reservasMock.mockReset().mockResolvedValue({ ok: true, starts: [] });
    for (const [id, user] of [["ycloud:34600000001", "34600000001"], ["ycloud:34600000002", "34600000002"]]) {
      await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", user, "Ana López", 1, NOW]);
      await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [`l-${user}`, id, "Ana López", "a@x.com", "x", JSON.stringify(COMPLETO), "new", NOW, NOW]);
    }
  });
  const correr = (id: string) => (proponerLlamadaTool(env, () => id) as any).execute({});

  it("sin configurar, la oferta está apagada", async () => {
    expect((await correr("ycloud:34600000001")).motivo).toBe("apagado");
  });
  it("en modo prueba solo se ofrece a las conversaciones de la lista", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_llamada_modo','prueba',1), ('viventa_llamada_ids','+34600000002',1)");
    expect((await correr("ycloud:34600000001")).ofrecerLlamada).toBe(false);
    expect((await correr("ycloud:34600000002")).ofrecerLlamada).toBe(true);
  });
  it("en modo activo se ofrece a todos los calientes/tibios", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_llamada_modo','activo',1)");
    expect((await correr("ycloud:34600000001")).ofrecerLlamada).toBe(true);
  });
});

describe("botones de la videollamada", () => {
  it("botonDia cabe en 20 caracteres", () => {
    const t = botonDia("2026-10-12T08:00:00Z");
    expect(t.length).toBeLessThanOrEqual(20);
    expect(t).toMatch(/^Lun 12 oct/);
  });
  it("botonesHoras reparte máx 3 horas", () => {
    const ops = [{ hora: "10:00" }, { hora: "12:00" }, { hora: "13:30" }, { hora: "15:30" }];
    expect(botonesHoras(ops)).toEqual(["10:00", "12:00", "15:30"]);
    expect(botonesHoras(ops.slice(0, 2))).toEqual(["10:00", "12:00"]);
  });
});
