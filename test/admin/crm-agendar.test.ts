/**
 * CRM: agendar una llamada manual (Cal.com + CRM).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const slotsMock = vi.fn();
const bookMock = vi.fn();
vi.mock("../../src/integrations/calcom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/integrations/calcom")>();
  return { ...actual, getAvailableSlots: (...a: unknown[]) => slotsMock(...a), createBooking: (...a: unknown[]) => bookMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { utcDesdeLocal, leerEntrada, buscarCliente, previsualizar, crearCitaManual, renderAgendar } from "../../member/crm-agendar.local";
import { cargarLlamadas } from "../../member/crm-calendario.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const SLOT = "2026-10-13T10:00:00.000+02:00";
const entrada = (o: Record<string, string> = {}) =>
  leerEntrada({ nombre: "Valentina Malagón Mamaoli", correo: "valentinamalagon1@gmail.com", tel: "+34 641 05 59 83", fecha: "2026-10-13", hora: "10:00", ...o });

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", CALCOM_API_KEY: "k", CALCOM_EVENT_TYPE_ID: "55", CALCOM_TIMEZONE: "Europe/Madrid" } as unknown as Env;
  slotsMock.mockReset().mockResolvedValue({ ok: true, slots: [SLOT, "2026-10-13T10:30:00.000+02:00"] });
  bookMock.mockReset().mockResolvedValue({ ok: true, bookingId: 9, uid: "u9", start: "2026-10-13T08:00:00.000Z", meetingUrl: "https://meet.google.com/abc-defg-hij" });
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["zernio:111", "zernio", "111", "valentina.malagon4", NOW - 9e8, NOW - 1e8]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ["l1", "zernio:111", "Valentina Malagón", "valentinamalagon1@gmail.com / 641055983", "compra", "{}", "new", NOW - 9e8, NOW - 9e8]);
});

describe("agendar llamada manual", () => {
  it("convierte la hora de pared a UTC en España y Colombia (verano e invierno)", () => {
    expect(new Date(utcDesdeLocal("2026-10-13", "16:00", "Europe/Madrid")).toISOString()).toBe("2026-10-13T14:00:00.000Z");
    expect(new Date(utcDesdeLocal("2026-10-13", "10:00", "America/Bogota")).toISOString()).toBe("2026-10-13T15:00:00.000Z");
    expect(new Date(utcDesdeLocal("2026-12-10", "16:00", "Europe/Madrid")).toISOString()).toBe("2026-12-10T15:00:00.000Z");
  });

  it("encuentra al cliente por teléfono o correo y comprueba la disponibilidad", async () => {
    expect((await buscarCliente(env, "+34 641 05 59 83", "", NOW))?.convId).toBe("zernio:111");
    expect((await buscarCliente(env, "", "valentinamalagon1@gmail.com", NOW))?.convId).toBe("zernio:111");
    expect(await buscarCliente(env, "699000111", "", NOW)).toBeNull();
    const v = await previsualizar(env, entrada(), NOW);
    expect(v.disponible).toBe(true);
    expect(v.madrid).toContain("13 de octubre");
    expect(v.madrid).toContain("10:00");
    expect(v.colombia).toContain("03:00");
    expect((await previsualizar(env, entrada({ hora: "11:00" }), NOW)).disponible).toBe(false);
  });

  it("reserva en Cal.com con correo de relleno y sin recordatorios al cliente", async () => {
    const r = await crearCitaManual(env, entrada(), NOW);
    expect(r.ok).toBe(true);
    const args = bookMock.mock.calls[0][1] as { email: string; start: string };
    expect(args.email).toContain("@correo-no-proporcionado.invalid");
    expect(args.start).toBe(SLOT);
    const ll = (await cargarLlamadas(env, NOW)).filter((l) => l.convId === "zernio:111");
    expect(ll).toHaveLength(1);
    expect(ll[0].estado).toBe("agendada");
    const m = JSON.parse((await db.first<{ metadata: string }>("SELECT metadata FROM leads WHERE intent LIKE 'Cita ·%'"))!.metadata);
    expect(m.viventa_confirmada).toBe("1");
    expect(m.viventa_r24).toBe("1");
    // misma persona otra vez: se rechaza
    const otra = await crearCitaManual(env, entrada(), NOW);
    expect(otra.ok).toBe(false);
  });

  it("con aviso al cliente usa su correo real y deja los recordatorios activos", async () => {
    const r = await crearCitaManual(env, entrada({ modo: "cliente" }), NOW);
    expect(r.ok).toBe(true);
    expect((bookMock.mock.calls[0][1] as { email: string }).email).toBe("valentinamalagon1@gmail.com");
    const m = JSON.parse((await db.first<{ metadata: string }>("SELECT metadata FROM leads WHERE intent LIKE 'Cita ·%'"))!.metadata);
    expect(m.viventa_r24).toBeUndefined();
  });

  it("no reserva si Cal.com no tiene el horario; «solo CRM» sí la guarda y crea al cliente nuevo", async () => {
    const no = await crearCitaManual(env, entrada({ hora: "11:00" }), NOW);
    expect(no.ok).toBe(false);
    expect(bookMock).not.toHaveBeenCalled();
    const crm = await crearCitaManual(env, entrada({ nombre: "Diana Zuñiga", correo: "lizethdiana215@gmail.com", tel: "34642196973", hora: "11:00", modo: "solo_crm", meet: "https://meet.google.com/aaa-bbbb-ccc" }), NOW);
    expect(crm.ok).toBe(true);
    expect(bookMock).not.toHaveBeenCalled();
    const { llamadasAgendadas } = await import("../../src/followup/resumenDia");
    expect((await llamadasAgendadas(db, NOW)).has("ycloud:34642196973")).toBe(true);
    const ll = await cargarLlamadas(env, NOW);
    expect(ll.some((l) => l.convId === "ycloud:34642196973" && l.enlace === "https://meet.google.com/aaa-bbbb-ccc")).toBe(true);
  });

  it("dibuja la pantalla con el resumen y la opción recomendada", async () => {
    const html = await renderAgendar(env, entrada(), {}, NOW);
    expect(html).toContain("Disponible en Cal.com");
    expect(html).toContain("SIN avisar al cliente");
    expect(html).toContain("Confirmar y agendar");
  });

  it("el botón «Confirmar y agendar» nunca queda deshabilitado (antes no hacía nada hasta actualizar el resumen)", async () => {
    const vacio = await renderAgendar(env, leerEntrada({}), {}, NOW);
    expect(vacio).toContain("Confirmar y agendar");
    expect(vacio).not.toMatch(/name="accion" value="confirmar"[^>]*disabled/);
    const incompleto = await crearCitaManual(env, leerEntrada({ nombre: "Ana" }), NOW);
    expect(incompleto.ok).toBe(false);
    expect(!incompleto.ok && incompleto.error).toContain("Faltan datos");
  });

  it("si el horario no está abierto en Cal.com, avisa por qué y ofrece guardarla solo en el CRM con un clic", async () => {
    const fuera = entrada({ hora: "13:00" });
    const r = await crearCitaManual(env, fuera, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.sugerirSoloCrm).toBe(true);
    const html = await renderAgendar(env, fuera, { resultado: r }, NOW);
    expect(html).toContain("Guardarla solo en el CRM");
    expect(html).toContain('name="modo" value="solo_crm"');
    const ok = await crearCitaManual(env, entrada({ hora: "13:00", modo: "solo_crm" }), NOW);
    expect(ok.ok).toBe(true);
  });

  it("bloquea una llamada que choca con otra del CRM y propone el modo según la disponibilidad", async () => {
    await crearCitaManual(env, entrada(), NOW);
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600999888", "ycloud", "34600999888", "Otro", NOW - 9e6, NOW - 8e6]);
    const choca = await previsualizar(env, entrada({ nombre: "Otro Cliente", tel: "600999888", correo: "", hora: "10:15" }), NOW);
    expect(choca.choque).toContain("10:00");
    const r = await crearCitaManual(env, entrada({ nombre: "Otro Cliente", tel: "600999888", correo: "", hora: "10:15" }), NOW);
    expect(r.ok).toBe(false);
    // sin elegir modo: libre → Cal.com; ocupado → solo CRM
    expect((await previsualizar(env, leerEntrada({ nombre: "X", tel: "600777000", fecha: "2026-10-13", hora: "10:30" }), NOW)).modo).toBe("relleno");
    expect((await previsualizar(env, leerEntrada({ nombre: "X", tel: "600777000", fecha: "2026-10-13", hora: "13:00" }), NOW)).modo).toBe("solo_crm");
  });

  it("solo con la fecha muestra los horarios libres y las llamadas del día", async () => {
    await crearCitaManual(env, entrada(), NOW);
    const html = await renderAgendar(env, leerEntrada({ nombre: "Z", tel: "600555000", fecha: "2026-10-13" }), {}, NOW);
    expect(html).toContain("Horarios libres");
    expect(html).toContain("10:30");
    expect(html).toContain("Valentina");
  });
});
