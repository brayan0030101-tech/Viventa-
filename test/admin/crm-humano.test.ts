/** «Esperando un humano»: prospección sin terminar + intentos del bot sin respuesta. */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { cargarEsperandoHumano, marcarLlamada, renderCrmHumano } from "../../member/crm-humano.local";
import type { Env } from "../../src/env";

const H = 3_600_000;
const DIA = 24 * H;
const NOW = Date.UTC(2026, 9, 21, 12, 0);
let db: Db;
let env: Env;

async function conv(canal: "ycloud" | "zernio", id: string, nombre: string, msgs: Array<[string, string, number]>) {
  const c = await new ConversationsRepo(db).getOrCreate(canal, id, nombre);
  for (const [rol, txt, hace] of msgs) await new MessagesRepo(db).append(c.id, rol as "user" | "assistant", txt, { createdAt: NOW - hace + (rol === "user" ? 0 : 1000) });
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [NOW - Math.min(...msgs.map((m) => m[2])), c.id]);
  return c.id;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", CRM_SESSION_SECRET: "secreto-de-prueba-largo-123456" } as unknown as Env;
});

describe("esperando un humano", () => {
  it("entra quien dejó la prospección a medias y no reaccionó a 2 intentos del bot; «Ya la llamé» la saca", async () => {
    const id = await conv("ycloud", "34600000071", "Marta", [["user", "Hola, quiero información", 6 * DIA], ["assistant", "Hola, ¿nos autorizas?", 6 * DIA], ["assistant", "¿Seguimos?", 5 * DIA], ["assistant", "Hola, hace unos días nos escribiste…", 3 * DIA]]);
    const lista = await cargarEsperandoHumano(env, NOW);
    expect(lista.map((p) => p.convId)).toEqual([id]);
    expect(lista[0].intentos).toBe(2);
    expect(lista[0].faltan).toContain("ingresosMensuales");
    expect(await renderCrmHumano(env, NOW)).toContain("Marta");
    await marcarLlamada(env, id, NOW);
    expect(await cargarEsperandoHumano(env, NOW)).toHaveLength(0);
  });

  it("no entra si el bot solo lo intentó una vez por WhatsApp, si es reciente, si ya lo atendió una persona o si ya dijo que no", async () => {
    await conv("ycloud", "34600000072", "Una sola vez", [["user", "Hola", 5 * DIA], ["assistant", "Hola", 5 * DIA], ["assistant", "¿Seguimos?", 4 * DIA]]);
    await conv("ycloud", "34600000073", "Reciente", [["user", "Hola", 1 * DIA], ["assistant", "Hola", 1 * DIA], ["assistant", "a", 1 * DIA], ["assistant", "b", 1 * DIA]]);
    await conv("ycloud", "34600000074", "Con persona", [["user", "Hola", 6 * DIA], ["owner", "Hola, soy Maricela", 5.9 * DIA], ["assistant", "a", 5 * DIA], ["assistant", "b", 4 * DIA]]);
    await conv("ycloud", "34600000075", "No quiere", [["user", "Ya no estoy interesado/a", 6 * DIA], ["assistant", "ok", 6 * DIA], ["assistant", "a", 5 * DIA], ["assistant", "b", 4 * DIA]]);
    expect(await cargarEsperandoHumano(env, NOW)).toHaveLength(0);
  });

  it("en Instagram basta un intento (no hay plantillas para volver a escribir)", async () => {
    const id = await conv("zernio", "9100", "ig_cliente", [["user", "info por favor", 6 * DIA], ["assistant", "Hola, ¿nos autorizas?", 6 * DIA], ["assistant", "¿Sigues ahí?", 5 * DIA]]);
    expect((await cargarEsperandoHumano(env, NOW)).map((p) => p.convId)).toEqual([id]);
  });
});
