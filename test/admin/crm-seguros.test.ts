import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import type { Env } from "../../src/env";
import { runSegurosMasivo, runRespuestasSeguros, MOTIVO_EXCLUYE, TEXTO_PLANTILLA_SEGUROS, WA_SEGUROS } from "../../member/crm-seguros.local";

let db: Db;
let env: Env;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, ZOHO_CLIENT_ID: "i", ZOHO_CLIENT_SECRET: "s", ZOHO_REFRESH_TOKEN: "r" } as unknown as Env;
});

describe("oferta de seguros ERGO|DKV", () => {
  it("apagada por defecto: no hace nada", async () => {
    expect(await runSegurosMasivo(env, Date.now())).toEqual({ sent: 0, omitidos: 0, fallos: 0 });
  });

  it("excluye a quien pidió no ser contactado, número errado o sin datos", () => {
    expect(MOTIVO_EXCLUYE.test("No quiere ser contactado")).toBe(true);
    expect(MOTIVO_EXCLUYE.test("Número errado")).toBe(true);
    expect(MOTIVO_EXCLUYE.test("Sin datos de contacto")).toBe(true);
    expect(MOTIVO_EXCLUYE.test("Interesado en otro país")).toBe(false);
  });

  it("el texto de la plantilla cabe en Meta (≤1024) y dice 1 mes gratis con ERGO|DKV", () => {
    expect(TEXTO_PLANTILLA_SEGUROS.length).toBeLessThanOrEqual(1024);
    expect(TEXTO_PLANTILLA_SEGUROS).toContain("ERGO|DKV");
    expect(TEXTO_PLANTILLA_SEGUROS).toContain("Un mes de seguro gratis");
    expect(WA_SEGUROS).toBe("https://wa.me/34603039032");
  });

  it("«No me interesa» marca al cliente y no se le avisa a Maricela; una respuesta con interés sí se registra", async () => {
    const now = Date.now();
    await db.run("CREATE TABLE IF NOT EXISTS crm_seguros (lead_id TEXT PRIMARY KEY, tel TEXT NOT NULL DEFAULT '', conv_id TEXT NOT NULL DEFAULT '', estado_origen TEXT NOT NULL DEFAULT '', enviado_en INTEGER, resultado TEXT NOT NULL DEFAULT '', aviso INTEGER)");
    for (const [conv, lead, msg] of [["ycloud:34600000001", "L1", "No me interesa"], ["ycloud:34600000002", "L2", "Sí, cuéntame más"]] as const) {
      await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [conv, "ycloud", conv.slice(-11), "X", now - 1e6, now - 1e5]);
      await db.run("INSERT INTO crm_seguros (lead_id, tel, conv_id, enviado_en) VALUES (?,?,?,?)", [lead, conv.slice(-11), conv, now - 500_000]);
      await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), conv, "user", msg, now - 100_000]);
    }
    await runRespuestasSeguros(env, now);
    const r = await db.all<{ lead_id: string; resultado: string }>("SELECT lead_id, resultado FROM crm_seguros ORDER BY lead_id");
    expect(r).toEqual([{ lead_id: "L1", resultado: "no_interesa" }, { lead_id: "L2", resultado: "respondio" }]);
  });
});
