/**
 * CRM de Maricela: «Por agendar» — une IG y WhatsApp por teléfono y detecta quién propuso horario.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { cargarPorAgendar, clavePhone, proponeHorario, renderCrmPorAgendar, excelPorAgendar } from "../../member/crm-poragendar.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 10, 12, 12, 0);
const H = 3600_000;
const META = { ciudadCompra: "Medellín", ahorroDisponible: "20 mil euros", cuotaMensual: "800", ingresosMensuales: "3000", tipoEmpleo: "empleado" };

async function ig(id: string, nombre: string, contacto: string, ultimoH = 60) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "zernio", id.slice(-8), nombre.toLowerCase(), NOW - 300 * H, NOW - ultimoH * H]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [`l-${id}`, id, nombre, contacto, "compra", JSON.stringify(META), "new", NOW - 300 * H, NOW - 100 * H]);
}
async function wa(tel: string, mensajes: Array<[string, number]> = []) {
  const id = `ycloud:${tel}`;
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", tel, null, NOW - 100 * H, NOW - 50 * H]);
  for (const [t, hace] of mensajes) await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), id, "user", t, NOW - hace * H]);
}
const motivoDe = async (nombre: string, frios = false) => (await cargarPorAgendar(env, { frios }, NOW)).find((p) => p.fila.lead.nombre === nombre)?.motivo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
});

describe("por agendar", () => {
  it("une Instagram y WhatsApp por teléfono y clasifica a cada persona", async () => {
    await ig("zernio:00000001", "Frank Delgado", "frank@mail.com / 627321475");
    await wa("34627321475", [["Buenas, el martes en la mañana después de las 11:00", 40]]);
    await ig("zernio:00000002", "Carol García", "carol@mail.com / +34675468963");
    await wa("34675468963", [["Quiero casa, no apartamento", 20]]);
    await ig("zernio:00000003", "Jenifer Casas", "jen@mail.com / +34614602005");
    await wa("34614602005", []);
    await ig("zernio:00000004", "Angela Suárez", "0768534135");
    await ig("zernio:00000005", "Sin Tel", "");
    expect(await motivoDe("Frank Delgado")).toBe("propuso");
    expect(await motivoDe("Carol García")).toBe("conversando");
    expect(await motivoDe("Jenifer Casas")).toBe("sin_respuesta");
    expect(await motivoDe("Angela Suárez")).toBe("sin_contactar");
    expect(await motivoDe("Sin Tel")).toBe("sin_telefono");
    // la misma persona no sale dos veces (IG + WhatsApp)
    expect((await cargarPorAgendar(env, {}, NOW)).filter((p) => p.fila.lead.nombre === "Frank Delgado")).toHaveLength(1);
    const orden = (await cargarPorAgendar(env, {}, NOW)).map((p) => p.motivo);
    expect(orden[0]).toBe("propuso");
  });

  it("excluye a quien ya tiene videollamada agendada y respeta los fríos", async () => {
    await ig("zernio:00000006", "Ya Agendada", "x@mail.com / 600111222");
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["cita-x", "zernio:00000006", "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: new Date(NOW + 48 * H).toISOString(), estado: "Reservada (Cal.com)" }), "new", NOW - H, NOW - H]);
    expect(await motivoDe("Ya Agendada")).toBeUndefined();
    // cancelada: vuelve a la lista
    await db.run("UPDATE leads SET metadata = ? WHERE id = 'cita-x'", [JSON.stringify({ calStart: new Date(NOW + 48 * H).toISOString(), estado: "Cancelada" })]);
    expect(await motivoDe("Ya Agendada")).toBeDefined();
  });

  it("detecta propuestas de horario, normaliza teléfonos y arma la vista y el Excel", async () => {
    for (const t of ["el 14/10 a las 5 pm hora de Suecia", "mañana estoy hasta las 4", "a partir del lunes temprano", "después de las 11"]) expect(proponeHorario(t)).toBe(true);
    for (const t of ["Buenas", "Vale", "quiero casa, no apartamento"]) expect(proponeHorario(t)).toBe(false);
    expect(clavePhone("maurifmd@hotmail.com / 627321475")).toBe("627321475");
    expect(clavePhone("+34 662 654 358")).toBe("662654358");
    expect(clavePhone("0768534135")).toBe("768534135");
    expect(clavePhone("abc")).toBe("");
    await ig("zernio:00000007", "Marcela Ruiz", "+46723361321");
    await wa("46723361321", [["el 14/10 a las 5 pm hora de Suecia", 30]]);
    const html = await renderCrmPorAgendar(env, {}, NOW);
    expect(html).toContain("Propuso horario");
    expect(html).toContain("Marcela Ruiz");
    expect(html).toContain("https://wa.me/46723361321");
    expect((await excelPorAgendar(env, {}, NOW)).length).toBeGreaterThan(500);
  });
});
