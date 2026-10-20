/**
 * Auditor con IA: procesa la cola por tandas, registra solo los problemas reales y no repite el mismo día.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../src/lib/camila", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/lib/camila")>()), notifyCamila: vi.fn().mockResolvedValue(true) }));
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { runAuditorIA, leerResultadoIA } from "../../src/followup/auditorIA";
import type { Env } from "../../src/env";

const NOW = Date.UTC(2026, 9, 20, 7, 0);
const MIN = 60_000;
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
});
async function conv(tel: string, nombre: string, nUser = 3) {
  const c = await convs.getOrCreate("ycloud", tel, nombre);
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [NOW - 30 * MIN, c.id]);
  for (let i = 0; i < nUser; i++) {
    await msgs.append(c.id, "user", `mensaje ${i}`, { createdAt: NOW - (120 - i * 10) * MIN });
    await msgs.append(c.id, "assistant", `respuesta ${i}`, { createdAt: NOW - (119 - i * 10) * MIN });
  }
  return c.id;
}

describe("leerResultadoIA", () => {
  it("lee el JSON, limita los problemas y trata «sin problemas» como ninguna", () => {
    expect(leerResultadoIA('```json\n{"gravedad":"alta","problemas":[{"tipo":"hora_distinta","detalle":"Pidió 13:00 y se agendó 11:30"}]}\n```')).toEqual({ gravedad: "alta", problemas: [{ tipo: "hora_distinta", detalle: "Pidió 13:00 y se agendó 11:30" }] });
    expect(leerResultadoIA('{"gravedad":"alta","problemas":[]}')?.gravedad).toBe("ninguna");
    expect(leerResultadoIA("sin json")).toBeNull();
  });
});

describe("runAuditorIA", () => {
  it("antes de las 06:00 UTC no hace nada; después revisa por tandas y solo registra los problemas", async () => {
    await conv("34600000001", "Ana");
    await conv("34600000002", "Brillit");
    await conv("34600000003", "Pocos", 1); // menos de 3 mensajes del cliente: no se revisa
    const generar = vi.fn().mockImplementation(async (p: string) => (p.includes("respuesta 0") && p.length > 0 ? '{"gravedad":"alta","problemas":[{"tipo":"hora_distinta","detalle":"Pidió 13:00 y se agendó 11:30"}]}' : '{"gravedad":"ninguna","problemas":[]}'));
    expect((await runAuditorIA(env, Date.UTC(2026, 9, 20, 5, 0), generar)).revisadas).toBe(0);
    expect(generar).not.toHaveBeenCalled();
    const r = await runAuditorIA(env, NOW, generar);
    expect(r.revisadas).toBe(2);
    const h = await db.all<{ tipo: string; detalle: string }>("SELECT tipo, detalle FROM auditoria_hallazgos");
    expect(h.length).toBe(2); // el simulador marca ambos (los dos contienen «respuesta 0»)
    expect(h[0].tipo).toBe("revision_ia");
    expect(h[0].detalle).toContain("hora_distinta");
    expect((await runAuditorIA(env, NOW + 5 * MIN, generar)).revisadas).toBe(0); // la cola de hoy ya está completa
  });
});
