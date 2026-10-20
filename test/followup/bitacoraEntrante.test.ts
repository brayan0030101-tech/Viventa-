/**
 * Bitácora de entrantes de WhatsApp: guarda botón pulsado y alarma si un mensaje de cliente no se pudo leer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { bitacoraEntrante } from "../../src/followup/bitacoraEntrante";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, YCLOUD_WA_FROM: "+34611688609" } as unknown as Env;
});

describe("bitácora de entrantes", () => {
  it("guarda el botón pulsado (id y título) y el mensaje citado", async () => {
    await bitacoraEntrante(env, { type: "whatsapp.inbound_message.received", whatsappInboundMessage: { wamid: "w1", from: "+34602539673", to: "+34611688609", type: "interactive", context: { id: "w0" }, interactive: { button_reply: { id: "btn:13:00", title: "13:00" } } } }, 1);
    const r = await db.all<{ boton_id: string; boton_titulo: string; cita_a: string; crudo: string | null }>("SELECT boton_id, boton_titulo, cita_a, crudo FROM entrantes_log");
    expect(r).toEqual([{ boton_id: "btn:13:00", boton_titulo: "13:00", cita_a: "w0", crudo: null }]);
  });
  it("si un mensaje de cliente no produjo nada, guarda el crudo y deja un hallazgo; no para reacciones ni otros números", async () => {
    await bitacoraEntrante(env, { type: "whatsapp.inbound_message.received", whatsappInboundMessage: { wamid: "w2", from: "", to: "+34611688609", type: "text", text: { body: "Hola" }, customerProfile: { username: "jose94161" } } }, 0);
    await bitacoraEntrante(env, { type: "whatsapp.inbound_message.received", whatsappInboundMessage: { wamid: "w3", from: "+34600000000", to: "+34611688609", type: "reaction" } }, 0);
    await bitacoraEntrante(env, { type: "whatsapp.inbound_message.received", whatsappInboundMessage: { wamid: "w4", from: "+34600000000", to: "+34999999999", type: "text" } }, 0);
    const h = await db.all<{ tipo: string; detalle: string }>("SELECT tipo, detalle FROM auditoria_hallazgos");
    expect(h).toHaveLength(1);
    expect(h[0].tipo).toBe("mensaje_ilegible");
    expect(h[0].detalle).toContain("@jose94161");
    const crudo = await db.first<{ crudo: string }>("SELECT crudo FROM entrantes_log WHERE wamid = 'w2'");
    expect(crudo?.crudo).toContain("jose94161");
  });
});
