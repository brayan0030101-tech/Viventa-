import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { sincronizarCitas } from "../../src/followup/sincronizarCitas";
import type { Env } from "../../src/env";

const NOW = Date.UTC(2026, 10, 20, 12, 0);
const H = 3_600_000;
let db: Db;
let env: Env;
let reservas: Record<string, unknown>;
let proximas: unknown[];
const fetchReal = globalThis.fetch;

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

async function seedCita(extra: Record<string, unknown> = {}) {
  const conv = "ycloud:34600000055";
  await db.run("INSERT OR IGNORE INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [conv, "ycloud", "34600000055", "Álvaro", NOW - 9e6, NOW - 9e5]);
  const meta = { servicio: "Videollamada Viventa", fecha: "2026-11-21", hora: "15:00", calBookingUid: "uid-viejo", calStart: new Date(NOW + 27 * H).toISOString(), estado: "Reservada (Cal.com)", calMeetingUrl: "https://meet.google.com/viejo", viventa_r24: "2026-11-20T10:00:00.000Z", viventa_r1: "2026-11-20T11:00:00.000Z", viventa_resumen: "2026-11-20T11:00:00.000Z", ...extra };
  await db.run(
    "INSERT INTO leads (id, conversation_id, name, contact, channel_user_id, intent, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ["lead-cita", conv, "Álvaro Pérez", "34600000055", "34600000055", "Cita · Videollamada Viventa · 2026-11-21 15:00", JSON.stringify(meta), NOW - 3 * 24 * H, NOW - 3 * 24 * H],
  );
}
const lead = async () => {
  const r = await db.first<{ intent: string; metadata: string }>("SELECT intent, metadata FROM leads WHERE id = 'lead-cita'");
  return { intent: r!.intent, meta: JSON.parse(r!.metadata) as Record<string, string> };
};

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, CALCOM_API_KEY: "k", BOT_TIMEZONE: "Europe/Madrid" } as unknown as Env;
  reservas = {};
  proximas = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const m = /\/bookings\/([^?/]+)$/.exec(u);
    if (m) return reservas[m[1]] ? json({ data: reservas[m[1]] }) : new Response("{}", { status: 404 });
    if (u.includes("/bookings?status=upcoming")) return json({ data: proximas });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = fetchReal;
});

describe("citas al día con Cal.com", () => {
  it("cancelada: queda cancelada y ya no entra a los recordatorios", async () => {
    await seedCita();
    reservas["uid-viejo"] = { uid: "uid-viejo", status: "cancelled", start: new Date(NOW + 27 * H).toISOString(), attendees: [{ email: "a@x.com" }] };
    expect(await sincronizarCitas(env, NOW)).toEqual({ canceladas: 1, reprogramadas: 0 });
    expect((await lead()).meta.estado).toBe("Cancelada (Cal.com)");
  });

  it("reprogramada (la reserva nueva trae rescheduledFromUid): la cita pasa a la fecha nueva y se borran las marcas de recordatorio", async () => {
    await seedCita();
    reservas["uid-viejo"] = { uid: "uid-viejo", status: "cancelled", start: new Date(NOW + 27 * H).toISOString(), attendees: [] };
    proximas = [{ uid: "uid-nuevo", status: "accepted", start: "2026-11-25T17:00:00.000Z", meetingUrl: "https://meet.google.com/nuevo", rescheduledFromUid: "uid-viejo", attendees: [] }];
    expect(await sincronizarCitas(env, NOW)).toEqual({ canceladas: 0, reprogramadas: 1 });
    const l = await lead();
    expect(l.meta.estado).toBe("Reservada (Cal.com)");
    expect(l.meta.calBookingUid).toBe("uid-nuevo");
    expect(l.meta.calStart).toBe("2026-11-25T17:00:00.000Z");
    expect(l.meta.fecha).toBe("2026-11-25");
    expect(l.meta.hora).toBe("18:00");
    expect(l.meta.calMeetingUrl).toBe("https://meet.google.com/nuevo");
    expect(l.intent).toBe("Cita · Videollamada Viventa · 2026-11-25 18:00");
    expect(l.meta.viventa_r24).toBeUndefined();
    expect(l.meta.viventa_r1).toBeUndefined();
    expect(l.meta.viventa_resumen).toBeUndefined();
  });

  it("la misma reserva cambia de hora: los recordatorios van a la hora nueva", async () => {
    await seedCita();
    reservas["uid-viejo"] = { uid: "uid-viejo", status: "accepted", start: "2026-11-21T17:00:00.000Z", attendees: [] };
    expect(await sincronizarCitas(env, NOW)).toEqual({ canceladas: 0, reprogramadas: 1 });
    expect((await lead()).meta.calStart).toBe("2026-11-21T17:00:00.000Z");
  });

  it("sin cambios o con un error pasajero de Cal.com no toca nada", async () => {
    await seedCita();
    const inicio = new Date(NOW + 27 * H).toISOString();
    reservas["uid-viejo"] = { uid: "uid-viejo", status: "accepted", start: inicio, attendees: [] };
    expect(await sincronizarCitas(env, NOW)).toEqual({ canceladas: 0, reprogramadas: 0 });
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    expect(await sincronizarCitas(env, NOW)).toEqual({ canceladas: 0, reprogramadas: 0 });
    expect((await lead()).meta.estado).toBe("Reservada (Cal.com)");
  });
});
