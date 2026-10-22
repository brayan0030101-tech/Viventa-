/** «Recorrido del cliente» (embudo) y «Plan del día». */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { calcularEmbudo, renderCrmEmbudo } from "../../member/crm-embudo.local";
import { renderCrmPlan } from "../../member/crm-plan.local";
import type { Env } from "../../src/env";

const DIA = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 12, 0);
let db: Db;
let env: Env;

async function cliente(tel: string, nombre: string, msgs: number, meta?: Record<string, string>, canal = "ycloud") {
  const c = await new ConversationsRepo(db).getOrCreate(canal, tel, nombre);
  for (let i = 0; i < msgs; i++) await new MessagesRepo(db).append(c.id, "user", `mensaje ${i}`, { createdAt: NOW - 3 * DIA + i * 1000 });
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [NOW - 2 * DIA, c.id]);
  if (meta) await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [crypto.randomUUID(), c.id, nombre, "x@y.com", "Lead", JSON.stringify(meta), NOW - 2 * DIA, NOW - 2 * DIA]);
  return c.id;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", CRM_SESSION_SECRET: "secreto-de-prueba-largo-123456" } as unknown as Env;
});

const COMPLETO = { ciudadResidencia: "España, Madrid", ciudadCompra: "Cali", entregaInmediataOFutura: "futura", ahorroDisponible: "5000", capacidadMensual: "500 euros", tipoEmpleo: "empleado", ingresosMensuales: "2000", reportadoDatacredito: "No", compraSoloOAcompanado: "Solo" };

describe("embudo", () => {
  it("cuenta cada paso, separa por canal y no cuenta números colombianos", async () => {
    await cliente("34600000081", "Solo saluda", 1);
    await cliente("34600000082", "Conversa", 4);
    const c = await cliente("34600000083", "Completo", 8, COMPLETO);
    await cliente("573001234567", "Colombiano", 5, COMPLETO);
    await db.run("CREATE TABLE IF NOT EXISTS cotizaciones_bot (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT, estado TEXT)");
    await db.run("INSERT INTO cotizaciones_bot (conv_id, estado) VALUES (?, 'enviada')", [c]);
    const e = await calcularEmbudo(env, 30, NOW);
    expect(e.total.escribe).toBe(3);
    expect(e.total.conversa).toBe(2);
    expect(e.total.preguntas).toBe(1);
    expect(e.total.califica).toBe(1);
    expect(e.total.cotizacion).toBe(1);
    expect(e.total.agenda).toBe(0);
    expect(e.porCanal.WhatsApp.escribe).toBe(3);
    expect(await renderCrmEmbudo(env, 30, NOW)).toContain("Recorrido");
  });
});

describe("plan del día", () => {
  it("se dibuja aunque no haya nada y no falla sin Zoho", async () => {
    const html = await renderCrmPlan(env, NOW);
    expect(html).toContain("Plan del día");
    expect(html).toContain("En cierre");
    expect(html).toContain("Prometido en las llamadas");
  });
});
