/**
 * Auditor: detecta conversaciones trabadas, avisa una sola vez y se cierra solo al resolverse.
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
import { runAuditor, registrarHallazgo } from "../../src/followup/auditor";
import type { Env } from "../../src/env";

const MIN = 60_000;
const H = 3_600_000;
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

async function conv(tel: string, nombre: string) {
  const c = await convs.getOrCreate("ycloud", tel, nombre);
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [NOW - 5 * MIN, c.id]);
  return c.id;
}
const abiertos = () => db.all<{ tipo: string; conv_id: string; resuelto_en: number | null }>("SELECT tipo, conv_id, resuelto_en FROM auditoria_hallazgos ORDER BY id");

describe("auditor", () => {
  it("avisa de una pregunta sin respuesta, una sola vez, y la cierra cuando alguien contesta", async () => {
    const id = await conv("34600000001", "Tatiana");
    await msgs.append(id, "user", "Una pregunta para ir mi hermano a ver el proyecto", { createdAt: NOW - 15 * MIN });
    expect((await runAuditor(env, NOW)).nuevos).toBe(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1].body).toContain("mi hermano");
    expect((await runAuditor(env, NOW + 5 * MIN)).nuevos).toBe(0);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    await msgs.append(id, "owner", "Claro, sí puede", { createdAt: NOW + 6 * MIN });
    const r = await runAuditor(env, NOW + 10 * MIN);
    expect(r.cerrados).toBe(1);
    expect((await abiertos())[0].resuelto_en).not.toBeNull();
  });

  it("no avisa por cortesías, por mensajes recientes ni por conversaciones pausadas", async () => {
    await msgs.append(await conv("34600000002", "A"), "user", "Vale", { createdAt: NOW - 30 * MIN });
    await msgs.append(await conv("34600000003", "B"), "user", "¿Cuánto cuesta?", { createdAt: NOW - 3 * MIN });
    const p = await conv("34600000004", "C");
    await msgs.append(p, "user", "Necesito hablar con alguien", { createdAt: NOW - 30 * MIN });
    await convs.setPausedUntil(p, NOW + H);
    expect((await runAuditor(env, NOW)).nuevos).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("detecta un buen perfil (ticket «Lead calificado») sin cita a los 45 min; no si ya agendó", async () => {
    const sin = await conv("34600000011", "Andrea");
    const con = await conv("34600000012", "Leidy");
    for (const id of [sin, con]) {
      await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES (?, ?, 'other', ?, '', 'open', ?)", [crypto.randomUUID(), id, "[Lead calificado: enviar proyectos] ficha", NOW - H]);
    }
    await db.run("INSERT INTO leads (id, conversation_id, intent, created_at, updated_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), con, "Cita · videollamada", NOW - 10 * MIN, NOW - 10 * MIN]);
    await runAuditor(env, NOW);
    const l = await abiertos();
    expect(l.map((x) => x.tipo)).toEqual(["listo_sin_cita"]);
    expect(l[0].conv_id).toBe(sin);
  });

  it("también lo detecta por datos completos aunque no haya ticket", async () => {
    const id = await conv("34600000013", "Brillit");
    const meta = JSON.stringify({ ciudadResidencia: "Javea", ciudadCompra: "Cali", entregaInmediataOFutura: "ahora", ahorroDisponible: "0", capacidadMensual: "200", tipoEmpleo: "empleada", ingresosMensuales: "1500" });
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [crypto.randomUUID(), id, "Brillit Pérez", "b@x.com", "Quiere comprar", meta, NOW - 2 * H, NOW - H]);
    await runAuditor(env, NOW);
    expect((await abiertos()).map((x) => x.tipo)).toEqual(["listo_sin_cita"]);
  });

  it("el bot que abre un ticket sin contestarle al cliente es un hallazgo; el comodín «dato sin respaldo» también", async () => {
    const a = await conv("34600000021", "Hermano");
    const b = await conv("34600000022", "Gran Canaria");
    await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES (?, ?, 'other', ?, '', 'open', ?)", ["t1", a, "[Consulta fuera del guion] pregunta si su hermano puede ir", NOW - 20 * MIN]);
    await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES (?, ?, 'other', ?, '', 'open', ?)", ["t2", b, "[dato sin respaldo] El bot iba a decir algo", NOW - 20 * MIN]);
    await runAuditor(env, NOW);
    expect((await abiertos()).map((x) => x.tipo).sort()).toEqual(["dato_sin_respaldo", "handoff_silencioso"]);
  });

  it("registra y avisa de un mensaje que no llegó al cliente y de un mensaje que no llegó al bot", async () => {
    await conv("34600000031", "Carolina");
    await db.run("CREATE TABLE IF NOT EXISTS envios_fallidos (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, canal TEXT NOT NULL, destino TEXT NOT NULL, detalle TEXT NOT NULL)");
    await db.run("INSERT INTO envios_fallidos (ts, canal, destino, detalle) VALUES (?,?,?,?)", [NOW - 10 * MIN, "ycloud", "34600000031", "403 BALANCE_INSUFFICIENT"]);
    await registrarHallazgo(env, { tipo: "entrega_al_agente", convId: "ycloud:34600000099", clave: "wamid.Z", detalle: "Un mensaje no pudo entregarse al bot" }, NOW - 1000);
    await runAuditor(env, NOW);
    expect((await abiertos()).map((x) => x.tipo).sort()).toEqual(["entrega_al_agente", "entrega_fallida"]);
    expect(notifyMock.mock.calls[0][1].body).toContain("saldo de YCloud");
  });
});

describe("página de Auditoría", () => {
  it("lista lo pendiente con enlace a la conversación y muestra «nada pendiente» si no hay nada", async () => {
    const { renderAuditoria } = await import("../../member/crm-auditoria.local");
    expect(await renderAuditoria(env, NOW)).toContain("Nada pendiente");
    await registrarHallazgo(env, { tipo: "sin_respuesta", convId: "ycloud:34600000099", clave: "1", detalle: "Tatiana: «¿mi hermano puede ir?»" }, NOW - 20 * MIN);
    const html = await renderAuditoria(env, NOW);
    expect(html).toContain("Cliente sin respuesta");
    expect(html).toContain("mi hermano");
    expect(html).toContain("/admin/conversations?c=ycloud%3A34600000099");
  });
});

describe("auditor: clientes olvidados con el bot pausado", () => {
  it("avisa cuando una persona intervino, el bot quedó pausado y el cliente lleva horas sin respuesta; se cierra al contestar", async () => {
    const id = await conv("34600000051", "Marcela");
    await msgs.append(id, "owner", "Hola, te cuento las opciones", { createdAt: NOW - 30 * H });
    await msgs.append(id, "user", "¿Cuánto sería la cuota inicial del proyecto?", { createdAt: NOW - 5 * H });
    await db.run("UPDATE conversations SET paused_until = ?, last_message_at = ? WHERE id = ?", [NOW + 48 * H, NOW - 5 * H, id]);
    expect((await runAuditor(env, NOW)).nuevos).toBe(1);
    const h = (await abiertos()).find((x) => x.tipo === "pausada_olvidada");
    expect(h?.resuelto_en).toBeNull();
    expect(notifyMock.mock.calls[0][1].body).toContain("bot está pausado");
    // Pausada sigue sin cerrarla: solo cuando alguien contesta.
    expect((await runAuditor(env, NOW + 5 * MIN)).cerrados).toBe(0);
    await msgs.append(id, "owner", "Son 30 millones", { createdAt: NOW + 10 * MIN });
    expect((await runAuditor(env, NOW + 15 * MIN)).cerrados).toBe(1);
  });

  it("no avisa si el último mensaje es reciente, de cortesía, o si nadie intervino", async () => {
    const reciente = await conv("34600000052", "R");
    await msgs.append(reciente, "owner", "Hola", { createdAt: NOW - 20 * H });
    await msgs.append(reciente, "user", "¿Y el precio?", { createdAt: NOW - 1 * H });
    const gracias = await conv("34600000053", "G");
    await msgs.append(gracias, "owner", "Listo", { createdAt: NOW - 20 * H });
    await msgs.append(gracias, "user", "Gracias", { createdAt: NOW - 6 * H });
    const sinPersona = await conv("34600000054", "S");
    await msgs.append(sinPersona, "user", "¿Y el precio?", { createdAt: NOW - 6 * H });
    await db.run("UPDATE conversations SET last_message_at = ? WHERE id IN (?, ?, ?)", [NOW - 6 * H, reciente, gracias, sinPersona]);
    await runAuditor(env, NOW);
    expect((await abiertos()).filter((x) => x.tipo === "pausada_olvidada")).toHaveLength(0);
  });

  it("vuelve a avisar a las 12 h si nadie contestó", async () => {
    const id = await conv("34600000055", "Paula");
    await msgs.append(id, "owner", "Hola", { createdAt: NOW - 30 * H });
    await msgs.append(id, "user", "¿Tienen algo en Medellín?", { createdAt: NOW - 5 * H });
    await db.run("UPDATE conversations SET paused_until = ?, last_message_at = ? WHERE id = ?", [NOW + 96 * H, NOW - 5 * H, id]);
    await runAuditor(env, NOW);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    await runAuditor(env, NOW + 13 * H);
    await runAuditor(env, NOW + 13 * H + 5 * MIN);
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });
});
