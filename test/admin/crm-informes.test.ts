/**
 * CRM de Maricela (fase 3): informes y resumen general.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { calcularInforme, renderCrmInformes, excelInforme, resumenGeneral, periodoValido, inicioPeriodo } from "../../member/crm-informes.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 10, 12, 0); // sáb 10 oct 2026, 14:00 en Madrid
const D = 24 * 3600_000;

async function conv(id: string, channel: string, nombre: string, startedAt: number, meta: Record<string, string> | null) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, channel, id.split(":")[1], nombre, startedAt, startedAt + 3600_000]);
  if (meta) await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [`l-${id}`, id, nombre, "", "compra", JSON.stringify(meta), "new", startedAt + 1000, startedAt + 1000]);
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro" } as unknown as Env;
  const caliente = { ahorroDisponible: "20 mil euros", capacidadMensual: "1000", tipoEmpleo: "contrato indefinido", entregaInmediataOFutura: "ahora", ciudadCompra: "Medellín" };
  await conv("ycloud:34600000001", "ycloud", "Ana López", NOW - 2 * D, caliente);
  await conv("ycloud:34600000002", "ycloud", "Luis Mora", NOW - 1 * D, { ciudadCompra: "Cali" });
  await conv("zernio:7", "zernio", "pepe_ig", NOW - 3600_000, null);
  await conv("ycloud:34600000009", "ycloud", "Vieja", NOW - 12 * D, caliente); // fuera de 7 días, dentro de 30 y del proyecto
  // llamada agendada de Ana
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES ('c1','ycloud:34600000001','x','','Cita · Videollamada Viventa · x',?,?,?,?)",
    [JSON.stringify({ calStart: new Date(NOW + 1 * D).toISOString(), estado: "Reservada (Cal.com)", calMeetingUrl: "https://meet.google.com/a" }), "new", NOW - 3600_000, NOW - 3600_000]);
  await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES ('t1','ycloud:34600000001','other','[Lead calificado: enviar proyectos] Ana','', 'open', ?)", [NOW - 2 * D]);
  await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES ('t2','ycloud:34600000002','other','[Cliente pide otro horario para la llamada] Luis','', 'open', ?)", [NOW - 3600_000]);
  await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), "ycloud:34600000001", "assistant", "Maricela puede llamarte en una videollamada de 30 minutos", NOW - 2 * D]);
  await db.run("INSERT INTO ia_usage (created_at, fn, model, cost_usd) VALUES (?, 'conversacion', 'sonnet', 0.5)", [NOW - 3600_000]);
  await db.run("INSERT INTO ia_usage (created_at, fn, model, cost_usd) VALUES (?, 'insights', 'sonnet', 0.1)", [NOW - 3600_000]);
});

describe("informe del CRM", () => {
  it("cuenta el embudo del periodo (7 días): sin la conversación de hace 12 días", async () => {
    const i = await calcularInforme(env, "7d", NOW);
    expect(i.conversaciones).toBe(3);
    expect(i.conDatos).toBe(2);
    expect(i.porNivel.caliente).toBe(1);
    expect(i.calificados).toBe(1);
    expect(i.ofertaLlamada).toBe(1);
    expect(i.agendaronBot).toBe(1);
    expect(i.comodin).toBe(1);
  });

  it("separa por canal y suma el costo de la IA", async () => {
    const i = await calcularInforme(env, "7d", NOW);
    expect(i.porCanal.find((c) => c.canal === "Instagram")?.conversaciones).toBe(1);
    expect(i.porCanal.find((c) => c.canal === "WhatsApp")?.llamadas).toBe(1);
    expect(i.costos.total).toBeCloseTo(0.6, 5);
    expect(i.tickets.map((t) => t.tipo)).toContain("Lead calificado");
  });

  it("«todo el proyecto» incluye lo antiguo y el resumen lo cuenta en palabras", async () => {
    expect((await calcularInforme(env, "30d", NOW)).conversaciones).toBe(4);
    const todo = await calcularInforme(env, "todo", NOW);
    expect(todo.conversaciones).toBe(4);
    const texto = resumenGeneral(todo).join(" ");
    expect(texto).toContain("**4** conversaciones nuevas");
    expect(texto).toContain("videollamadas");
  });

  it("las alertas listan a los calientes/tibios sin llamada", async () => {
    const i = await calcularInforme(env, "7d", NOW);
    // Ana ya tiene llamada; Vieja (caliente) no, y cuenta como pendiente (está en los 90 días)
    const nombres = i.alertas.sinLlamada.map((f) => f.lead.nombre);
    expect(nombres).toContain("Vieja");
    expect(nombres).not.toContain("Ana López");
    expect(i.alertas.llamadasProximas).toHaveLength(1);
  });

  it("la página y el Excel se generan; periodo inválido cae a 7 días", async () => {
    const html = await renderCrmInformes(env, periodoValido("xx"), NOW);
    expect(html).toContain("Resumen general");
    expect(html).toContain("Embudo");
    expect(html).toContain("Sin llamada agendada");
    const x = await excelInforme(env, "7d", NOW);
    expect(String.fromCharCode(x[0], x[1])).toBe("PK");
    expect(inicioPeriodo("hoy", NOW)).toBeLessThanOrEqual(NOW);
    expect(NOW - inicioPeriodo("hoy", NOW)).toBeLessThan(D);
  });
});
