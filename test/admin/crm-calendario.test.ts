/**
 * CRM de Maricela (fase 2): calendario de videollamadas, ficha de la llamada y Excel del cliente.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { renderCrmCalendario, renderLlamadaDetalle, excelFicha, cargarLlamadas, resumenContexto } from "../../member/crm-calendario.local";
import { armarLeads } from "../../src/followup/resumenDia";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 10, 12, 0); // sáb 10 oct 2026

async function cliente(id: string, nombre: string, meta: Record<string, string>) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", id.split(":")[1], nombre, NOW - 9e6, NOW - 1e6]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [`l-${id}`, id, nombre, "a@b.com", "compra", JSON.stringify(meta), "new", NOW - 8e6, NOW - 8e6]);
}
async function llamada(leadId: string, convId: string, inicioIso: string, extra: Record<string, string> = {}) {
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [leadId, convId, "x", "", "Cita · Videollamada Viventa · 2026-10-12 10:00",
      JSON.stringify({ calStart: inicioIso, estado: "Reservada (Cal.com)", calMeetingUrl: "https://meet.google.com/abc-defg-hij", ...extra }), "new", NOW - 1000, NOW - 1000]);
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro" } as unknown as Env;
  await cliente("ycloud:34600000001", "Ana López Ruiz", { ahorroDisponible: "20 mil euros", capacidadMensual: "1000", tipoEmpleo: "contrato indefinido", entregaInmediataOFutura: "ahora", ciudadCompra: "Medellín", ciudadResidencia: "Estados Unidos, Miami" });
  await cliente("ycloud:34600000002", "Luis Mora", { ciudadCompra: "Cali" });
  await llamada("c1", "ycloud:34600000001", "2026-10-12T08:00:00.000Z", { zonaCliente: "America/New_York", zonaEtiqueta: "EE. UU. (costa este)" }); // 10:00 España
  await llamada("c2", "ycloud:34600000002", "2026-10-12T09:30:00.000Z"); // 11:30
  await llamada("c3", "ycloud:34600000002", "2026-10-05T09:00:00.000Z", { estado: "Cancelada" });
  await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), "ycloud:34600000001", "user", "Hola <i>quiero</i> info", NOW - 2e6]);
});

describe("calendario de llamadas", () => {
  it("clasifica cada llamada: agendada, pasada o cancelada, con su prioridad", async () => {
    const ll = await cargarLlamadas(env, NOW);
    expect(ll.map((x) => x.estado)).toEqual(["cancelada", "agendada", "agendada"]);
    expect(ll.find((x) => x.nombre.startsWith("Ana"))?.nivel).toBe("caliente");
  });

  it("dibuja el mes con las llamadas en su día y hora de España", async () => {
    const html = await renderCrmCalendario(env, "2026-10", NOW);
    expect(html).toContain("octubre 2026");
    expect(html).toContain("<b>10:00</b> Ana L.");
    expect(html).toContain("<b>11:30</b> Luis M.");
    expect(html).toContain("Próxima llamada");
    expect(html).toContain("hx-get=\"/crm/llamada/c1\"");
    expect(html).toContain("cancelada"); // la del 5 de octubre
  });

  it("un mes inválido cae al mes actual y navega con ← →", async () => {
    const html = await renderCrmCalendario(env, "basura", NOW);
    expect(html).toContain("octubre 2026");
    expect(html).toContain("mes=2026-09");
    expect(html).toContain("mes=2026-11");
  });

  it("la ventana de la llamada trae el resumen, el enlace de Meet y la hora local del cliente", async () => {
    const html = (await renderLlamadaDetalle(env, "c1", NOW))!;
    expect(html).toContain("Ana López Ruiz");
    expect(html).toContain("https://meet.google.com/abc-defg-hij");
    expect(html).toContain("Resumen para la llamada");
    expect(html).toContain("Vive en Estados Unidos, Miami");
    expect(html).toContain("04:00 en EE. UU. (costa este)");
    expect(html).toContain("&lt;i&gt;quiero&lt;/i&gt;"); // el HTML del cliente se escapa
    expect(await renderLlamadaDetalle(env, "no-existe", NOW)).toBeNull();
  });

  it("resumenContexto resume la ficha en frases", () => {
    const [lead] = armarLeads(
      [{ id: "z", channel: "ycloud", channel_user_id: "1", display_name: "Pepe", last_message_at: NOW }],
      [{ conversation_id: "z", name: "Pepe Gil", contact: "", notes: "", metadata: JSON.stringify({ ahorroDisponible: "5000", ciudadCompra: "Bogotá" }) }],
    );
    const t = resumenContexto(lead).join(" ");
    expect(t).toContain("Pepe Gil escribió por WhatsApp");
    expect(t).toContain("quiere comprar en Bogotá");
    expect(t).toContain("ahorro 5000");
  });

  it("el Excel de la ficha trae los datos y la conversación", async () => {
    const x = (await excelFicha(env, "ycloud:34600000001", NOW))!;
    expect(String.fromCharCode(x[0], x[1])).toBe("PK");
    expect(x.length).toBeGreaterThan(500);
    expect(await excelFicha(env, "ycloud:0", NOW)).toBeNull();
  });
});

describe("día con muchas llamadas", () => {
  it("muestra todas las llamadas del día (sin «+N más»)", async () => {
    for (let i = 0; i < 6; i++) {
      await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [`m${i}`, "ycloud:34600000002", "x", "", "Cita · Videollamada Viventa · x", JSON.stringify({ calStart: `2026-10-20T${String(i + 6).padStart(2, "0")}:00:00.000Z`, estado: "Reservada (Cal.com)" }), "new", NOW - 1000, NOW - 1000]);
    }
    const html = await renderCrmCalendario(env, "2026-10", NOW);
    for (let i = 0; i < 6; i++) expect(html).toContain(`hx-get="/crm/llamada/m${i}"`);
    expect(html).not.toMatch(/\+\d+ más/);
  });
});
