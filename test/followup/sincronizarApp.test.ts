/**
 * Lo escrito desde WhatsApp Business se guarda en el hilo del panel (texto traído de YCloud).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { anotarEcho, runSincronizarApp } from "../../src/followup/sincronizarApp";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 20, 15, 0);
const lista = (items: unknown[]) => (async () => new Response(JSON.stringify({ items }), { status: 200 })) as unknown as typeof fetch;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, YCLOUD_API_KEY: "k" } as unknown as Env;
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?,?,?,?,?)", ["ycloud:34600000001", "ycloud", "34600000001", NOW, NOW]);
});

describe("sincronizar WhatsApp Business → panel", () => {
  it("guarda el texto del echo como mensaje del equipo, una sola vez", async () => {
    await anotarEcho(env, "wamid.A", "ycloud:34600000001", NOW);
    const f = lista([{ wamid: "wamid.A", type: "text", text: { body: "Hola, ¿sigues interesado?" } }]);
    expect((await runSincronizarApp(env, NOW, f)).guardados).toBe(1);
    expect((await runSincronizarApp(env, NOW, f)).guardados).toBe(0);
    const m = await db.all<{ role: string; content: string }>("SELECT role, content FROM messages WHERE conversation_id = 'ycloud:34600000001'");
    expect(m).toEqual([{ role: "owner", content: "Hola, ¿sigues interesado?" }]);
  });
  it("si el mensaje aún no aparece en YCloud, queda pendiente para la siguiente pasada", async () => {
    await anotarEcho(env, "wamid.B", "ycloud:34600000001", NOW);
    expect((await runSincronizarApp(env, NOW, lista([]))).guardados).toBe(0);
    const f = lista([{ wamid: "wamid.B", text: "Listo, gracias" }]);
    expect((await runSincronizarApp(env, NOW + 300_000, f)).guardados).toBe(1);
  });
  it("descarta pendientes de más de 2 días", async () => {
    await anotarEcho(env, "wamid.C", "ycloud:34600000001", NOW - 3 * 86_400_000);
    await runSincronizarApp(env, NOW, lista([{ wamid: "wamid.C", text: "viejo" }]));
    expect(await db.all("SELECT id FROM messages")).toHaveLength(0);
  });
});
