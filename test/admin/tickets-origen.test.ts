/**
 * El panel de tickets muestra de qué canal viene cada cliente.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { renderTickets } from "../../src/admin/views/tickets";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa" } as unknown as Env;
});

async function conv(id: string, channel: string, user: string, name: string) {
  await db.run(
    "INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)",
    [id, channel, user, name, 1, 1],
  );
}
async function ticket(id: string, convId: string | null) {
  await db.run(
    "INSERT INTO tickets (id, conversation_id, category, summary, transcript, created_at) VALUES (?,?,?,?,?,?)",
    [id, convId, "other", `[Lead calificado] resumen ${id}`, "", Date.now()],
  );
}

describe("renderTickets – canal", () => {
  it("muestra WhatsApp con teléfono e Instagram con perfil", async () => {
    await conv("ycloud:34600000001", "ycloud", "34600000001", "Ana");
    await conv("zernio:123", "zernio", "123", "Luis");
    await ticket("t1", "ycloud:34600000001");
    await ticket("t2", "zernio:123");
    await ticket("t3", null);
    const html = await renderTickets(env);
    expect(html).toContain("💬 WhatsApp · Ana · +34600000001");
    expect(html).toContain("📸 Instagram · Luis");
    expect(html).toContain("resumen t3");
  });
});
