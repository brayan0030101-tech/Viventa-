/**
 * Reintento automático de turnos que fallaron por el proveedor de IA.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const retryMock = vi.fn();
vi.mock("../../src/agent-stub", () => ({
  agentStub: () => ({ retryFailedTurn: (...a: unknown[]) => retryMock(...a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { MessagesRepo } from "../../src/db/messages";
import { registrarFalloIA, limpiarFalloIA, runReintentosIA } from "../../src/followup/reintentosIA";
import { checkStuckConversations } from "../../src/watchdog";
import type { Env } from "../../src/env";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
let env: Env;
let db: Db;

async function conv(id = "ycloud:34600000001") {
  await db.run(
    "INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)",
    [id, "ycloud", "34600000001", "Ana", NOW - 60 * MIN, NOW - 10 * MIN],
  );
  await new MessagesRepo(db).append(id, "user", "hola", { createdAt: NOW - 10 * MIN });
  return id;
}
const flag = async (id: string) =>
  (await db.first<{ f: string | null }>("SELECT json_extract(metadata,'$.viventa_fallo') AS f FROM conversations WHERE id = ?", [id]))?.f;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1 } as unknown as Env;
  db = new Db(d1);
  retryMock.mockReset().mockResolvedValue(undefined);
});

describe("registrarFalloIA", () => {
  it("el primer fallo se anota y todavía no es definitivo; el error real queda en ai_fallos", async () => {
    const id = await conv();
    const r = await registrarFalloIA(env, db, id, Object.assign(new Error("overloaded"), { statusCode: 529 }), false, NOW);
    expect(r).toEqual({ final: false, n: 1 });
    expect(JSON.parse((await flag(id))!)).toEqual({ n: 1, at: NOW });
    const fila = await db.first<{ status: number; message: string }>("SELECT status, message FROM ai_fallos");
    expect(fila).toMatchObject({ status: 529, message: "overloaded" });
  });
  it("un fallo del último reintento (n=3) es definitivo", async () => {
    const id = await conv();
    await db.run("UPDATE conversations SET metadata = json('{\"viventa_fallo\":{\"n\":3,\"at\":1}}') WHERE id = ?", [id]);
    expect((await registrarFalloIA(env, db, id, new Error("x"), true, NOW)).final).toBe(true);
  });
});

describe("runReintentosIA", () => {
  it("no reintenta antes de los 3 min, y a los 3 min reclama y reintenta una sola vez", async () => {
    const id = await conv();
    await registrarFalloIA(env, db, id, new Error("x"), false, NOW - 2 * MIN);
    expect((await runReintentosIA(env, NOW)).retried).toBe(0);
    await db.run("UPDATE conversations SET metadata = json('{\"viventa_fallo\":{\"n\":1,\"at\":" + (NOW - 4 * MIN) + "}}') WHERE id = ?", [id]);
    expect((await runReintentosIA(env, NOW)).retried).toBe(1);
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await flag(id))!)).toEqual({ n: 2, at: NOW });
    expect((await runReintentosIA(env, NOW)).retried).toBe(0); // misma pasada: ya reclamado
  });
  it("el segundo reintento espera 10 min", async () => {
    const id = await conv();
    await db.run("UPDATE conversations SET metadata = json('{\"viventa_fallo\":{\"n\":2,\"at\":" + (NOW - 5 * MIN) + "}}') WHERE id = ?", [id]);
    expect((await runReintentosIA(env, NOW)).retried).toBe(0);
    await db.run("UPDATE conversations SET metadata = json('{\"viventa_fallo\":{\"n\":2,\"at\":" + (NOW - 11 * MIN) + "}}') WHERE id = ?", [id]);
    expect((await runReintentosIA(env, NOW)).retried).toBe(1);
  });
  it("si ya respondió alguien (último mensaje no es del cliente) o la conversación está pausada, limpia y no reintenta", async () => {
    const id = await conv();
    await new MessagesRepo(db).append(id, "assistant", "ya", { createdAt: NOW - MIN });
    await db.run("UPDATE conversations SET metadata = json('{\"viventa_fallo\":{\"n\":1,\"at\":" + (NOW - 5 * MIN) + "}}') WHERE id = ?", [id]);
    expect((await runReintentosIA(env, NOW)).retried).toBe(0);
    expect(await flag(id)).toBeNull();
  });
  it("limpiarFalloIA quita la marca", async () => {
    const id = await conv();
    await registrarFalloIA(env, db, id, new Error("x"), false, NOW);
    await limpiarFalloIA(db, id);
    expect(await flag(id)).toBeNull();
  });
});

describe("watchdog y reintentos", () => {
  it("no abre ticket de «sin responder» mientras haya reintentos pendientes, y sí cuando no los hay", async () => {
    const id = await conv();
    const sinReintento = await checkStuckConversations(env, NOW);
    expect(sinReintento.alerted).toBe(1);
    await db.run("UPDATE conversations SET open_ticket_id = NULL WHERE id = ?", [id]);
    await registrarFalloIA(env, db, id, new Error("x"), false, NOW);
    const conReintento = await checkStuckConversations(env, NOW);
    expect(conReintento.alerted).toBe(0);
  });
});
