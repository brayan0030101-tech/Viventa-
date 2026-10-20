/**
 * Aviso al equipo cuando un cliente hizo una pregunta real y nadie respondió en 10 min.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyMock = vi.fn();
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { runSinRespuesta, esCortesia, runCalificadosSinCita } from "../../src/followup/sinRespuesta";
import type { Env } from "../../src/env";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1 } as unknown as Env;
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  notifyMock.mockReset().mockResolvedValue(true);
});

async function cliente(tel: string, texto: string, haceMin: number, nombre = "Tatiana") {
  const c = await convs.getOrCreate("ycloud", tel, nombre);
  await msgs.append(c.id, "user", texto, { createdAt: NOW - haceMin * MIN });
  return c.id;
}

describe("esCortesia", () => {
  it("vale/gracias no necesitan respuesta; una pregunta sí", () => {
    for (const t of ["Vale", "Gracias 🙏", "Vale perfecto muchas gracias", "👍", "Ok"]) expect(esCortesia(t)).toBe(true);
    expect(esCortesia("Una pregunta para ir mi hermano a ver el proyecto")).toBe(false);
    expect(esCortesia("gracias, ¿y el jueves?")).toBe(false);
  });
});

describe("clientes sin respuesta", () => {
  it("avisa una vez de la pregunta real sin respuesta tras 10 min", async () => {
    await cliente("34600000001", "Una pregunta para ir mi hermano a ver el proyecto", 15);
    expect((await runSinRespuesta(env, NOW)).avisados).toBe(1);
    expect(notifyMock.mock.calls[0][1].body).toContain("mi hermano");
    expect((await runSinRespuesta(env, NOW + 5 * MIN)).avisados).toBe(0);
  });
  it("no avisa: cortesías, menos de 10 min, ya respondido o conversación pausada", async () => {
    await cliente("34600000002", "Vale", 20);
    await cliente("34600000003", "¿Cuánto cuesta?", 5);
    const resp = await cliente("34600000004", "¿Me llaman mañana?", 20);
    await msgs.append(resp, "assistant", "Claro", { createdAt: NOW - 18 * MIN });
    const pausada = await cliente("34600000005", "Necesito hablar con alguien", 20);
    await convs.setPausedUntil(pausada, NOW + 60 * MIN);
    expect((await runSinRespuesta(env, NOW)).avisados).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("buenos perfiles sin videollamada", () => {
  async function ticket(convId: string, haceH: number) {
    await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES (?, ?, 'other', ?, '', 'open', ?)", [crypto.randomUUID(), convId, "[Lead calificado: enviar proyectos] Andrea, Roma, empleada 1600 EUR", NOW - haceH * 3_600_000]);
  }
  it("avisa a las 2 h si no hay cita, una sola vez; no avisa si ya agendó", async () => {
    const sin = await cliente("34600000011", "ok", 200, "Andrea");
    const con = await cliente("34600000012", "ok", 200, "Leidy");
    await ticket(sin, 3);
    await ticket(con, 3);
    await db.run("INSERT INTO leads (id, conversation_id, intent, created_at, updated_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), con, "Cita · videollamada", NOW - 1000, NOW - 1000]);
    expect((await runCalificadosSinCita(env, NOW)).avisados).toBe(1);
    expect(notifyMock.mock.calls[0][1].body).toContain("Andrea");
    expect(notifyMock.mock.calls[0][1].body).not.toContain("Leidy");
    expect((await runCalificadosSinCita(env, NOW + 5 * MIN)).avisados).toBe(0);
  });
  it("no avisa antes de 2 h", async () => {
    await ticket(await cliente("34600000013", "ok", 200), 1);
    expect((await runCalificadosSinCita(env, NOW)).avisados).toBe(0);
  });
});
