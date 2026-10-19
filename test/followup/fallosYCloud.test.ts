/**
 * Mensajes que YCloud aceptó pero WhatsApp rechazó después: nota en el hilo, sin repetirse.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { runFallosYCloud, motivoFallo } from "../../src/followup/fallosYCloud";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 19, 15, 0);

const resp = (items: unknown[]) => (async () => new Response(JSON.stringify({ items }), { status: 200 })) as unknown as typeof fetch;
const falla = (id: string, to: string, extra: Record<string, unknown> = {}) => ({ id, status: "failed", from: "+34611688609", to, errorCode: "131047", createTime: new Date(NOW - 600_000).toISOString(), ...extra });

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, YCLOUD_API_KEY: "k", YCLOUD_WA_FROM: "+34611688609" } as unknown as Env;
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34656503601", "ycloud", "34656503601", "Wilder", NOW, NOW]);
});

describe("fallos de entrega de WhatsApp", () => {
  it("deja una nota en el hilo del cliente y no la repite en la siguiente pasada", async () => {
    const f = resp([falla("m1", "+34656503601"), { id: "m2", status: "read", from: "+34611688609", to: "+34656503601", createTime: new Date(NOW).toISOString() }]);
    expect((await runFallosYCloud(env, NOW, f)).nuevos).toBe(1);
    const notas = await db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = 'ycloud:34656503601' AND role = 'note'");
    expect(notas).toHaveLength(1);
    expect(notas[0].content).toContain("NO LLEGÓ al cliente");
    expect(notas[0].content).toContain("24 horas");
    expect((await runFallosYCloud(env, NOW, f)).nuevos).toBe(0);
    expect(await db.all("SELECT id FROM messages WHERE role = 'note'")).toHaveLength(1);
  });
  it("ignora fallos viejos (más de 3 días) y mensajes de otro número", async () => {
    const f = resp([falla("v1", "+34656503601", { createTime: new Date(NOW - 5 * 86_400_000).toISOString() }), falla("o1", "+34656503601", { from: "+34999999999" })]);
    expect((await runFallosYCloud(env, NOW, f)).nuevos).toBe(0);
  });
  it("explica el código 131047 en español", () => {
    expect(motivoFallo("131047", "")).toContain("24 horas");
  });
});
