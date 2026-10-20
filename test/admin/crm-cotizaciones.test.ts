/**
 * Cotizaciones de ViveHome mandadas por WhatsApp: se detectan en los mensajes salientes y se muestran por cliente.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { guardarCotizaciones } from "../../src/followup/cotizaciones";
import { renderCotizaciones, cargarCotizaciones } from "../../member/crm-cotizaciones.local";
import type { Env } from "../../src/env";

const DIA = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
let env: Env;
let db: Db;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1 } as unknown as Env;
});

const msg = (id: string, to: string, text: string, haceDias: number, status = "read") => ({ id, to: `+${to}`, text, status, createTime: new Date(NOW - haceDias * DIA).toISOString() });

describe("cotizaciones", () => {
  it("guarda solo los mensajes con enlace de cotización (varios por mensaje), sin duplicar y sin los fallidos", async () => {
    const items = [
      msg("m1", "34600000001", "Te envío la cotización https://vivehome.viventa.co/quota-information?id=2387 y otra https://vivehome.viventa.co/quota-information?id=2340", 5),
      msg("m2", "34600000002", "Hola, ¿cómo estás?", 5),
      msg("m3", "34600000003", "https://vivehome.viventa.co/quota-information?id=2398", 1, "failed"),
    ];
    expect(await guardarCotizaciones(env, items)).toBe(2);
    expect(await guardarCotizaciones(env, items)).toBe(0);
  });

  it("muestra por cliente la cotización y si respondió, agendó o sigue sin respuesta", async () => {
    const convs = new ConversationsRepo(db);
    const msgs = new MessagesRepo(db);
    await guardarCotizaciones(env, [
      msg("a", "34600000001", "https://vivehome.viventa.co/quota-information?id=2387", 6),
      msg("b", "34600000002", "https://vivehome.viventa.co/quota-information?id=2340", 6),
      msg("c", "34600000003", "https://vivehome.viventa.co/quota-information?id=2335", 6),
    ]);
    const c1 = await convs.getOrCreate("ycloud", "34600000001", "Sin Respuesta");
    await msgs.append(c1.id, "user", "hola", { createdAt: NOW - 20 * DIA });
    const c2 = await convs.getOrCreate("ycloud", "34600000002", "Respondió");
    await msgs.append(c2.id, "user", "me gustó", { createdAt: NOW - 2 * DIA });
    const c3 = await convs.getOrCreate("ycloud", "34600000003", "Con Cita");
    await msgs.append(c3.id, "user", "hola", { createdAt: NOW - 20 * DIA });
    await db.run("INSERT INTO leads (id, conversation_id, intent, created_at, updated_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), c3.id, "Cita · videollamada", NOW - DIA, NOW - DIA]);
    const f = await cargarCotizaciones(env, NOW);
    expect(f.find((x) => x.nombre === "Sin Respuesta")).toMatchObject({ respondio: false, cita: false });
    expect(f.find((x) => x.nombre === "Respondió")?.respondio).toBe(true);
    expect(f.find((x) => x.nombre === "Con Cita")?.cita).toBe(true);
    const html = await renderCotizaciones(env, { f: "sin_respuesta" }, NOW);
    expect(html).toContain("Sin Respuesta");
    expect(html).not.toContain("Respondió");
    expect(html).toContain("COT-2387");
    expect(html).toContain("quota-information?id=2387");
  });
});
