/**
 * Panel de conversaciones: aviso cuando el cliente de WhatsApp lleva más de 24 h sin escribir (no se puede mandar texto libre).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { avisoVentana24h } from "../../src/admin/views/conversations";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const H = 3600_000;

async function conv(id: string, channel: string, ultimoClienteHace: number | null) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?,?,?,?,?)", [id, channel, id.split(":")[1], NOW - 99 * H, NOW]);
  if (ultimoClienteHace != null) await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), id, "user", "hola", NOW - ultimoClienteHace * H]);
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1 } as unknown as Env;
});

describe("aviso de la ventana de 24 h de WhatsApp", () => {
  it("avisa (con los días y qué hacer) si el cliente escribió hace más de 24 h", async () => {
    await conv("ycloud:34600000001", "ycloud", 6 * 24);
    const html = await avisoVentana24h(env, "ycloud:34600000001", NOW);
    expect(html).toContain("escribió hace 6 días");
    expect(html).toContain("WhatsApp Business");
    expect(html).toContain("Plantillas");
  });
  it("no avisa dentro de las 24 h ni en otros canales", async () => {
    await conv("ycloud:34600000002", "ycloud", 3);
    await conv("zernio:abc", "zernio", 200);
    expect(await avisoVentana24h(env, "ycloud:34600000002", NOW)).toBe("");
    expect(await avisoVentana24h(env, "zernio:abc", NOW)).toBe("");
    expect(await avisoVentana24h(env, "ycloud:no-existe", NOW)).toBe("");
  });
  it("si nunca escribió, también avisa", async () => {
    await conv("ycloud:34600000003", "ycloud", null);
    expect(await avisoVentana24h(env, "ycloud:34600000003", NOW)).toContain("nunca ha escrito");
  });
});
