/** Aviso cuando un cliente responde al mensaje de reactivación («Revisar en el futuro»). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyMock = vi.fn();
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyMock(...a) };
});
vi.mock("../../src/lib/self-origin", () => ({ selfOrigin: async () => "https://x.test" }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { runAvisoRespuestasReactivacion } from "../../member/crm-reactivacion.local";
import type { Env } from "../../src/env";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
let env: Env;
let db: Db;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1 } as unknown as Env;
  db = new Db(d1);
  notifyMock.mockReset().mockResolvedValue(true);
  await db.run("CREATE TABLE IF NOT EXISTS crm_reactiva (lead_id TEXT PRIMARY KEY, tarea_id TEXT NOT NULL DEFAULT '', conv_id TEXT NOT NULL DEFAULT '', borrador TEXT NOT NULL DEFAULT '', oferta TEXT NOT NULL DEFAULT '', creado INTEGER NOT NULL, enviado_en INTEGER, canal TEXT NOT NULL DEFAULT '', resultado TEXT NOT NULL DEFAULT '')");
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000050", "ycloud", "34600000050", "Wendy", 1, NOW]);
  await db.run("INSERT INTO crm_reactiva (lead_id, conv_id, creado, enviado_en) VALUES (?,?,?,?)", ["2259602000000000050", "ycloud:34600000050", NOW - 3600_000, NOW - 3600_000]);
});

describe("aviso de respuesta a la reactivación", () => {
  it("la primera pasada solo marca las respuestas viejas; luego avisa una vez cuando alguien responde", async () => {
    expect(await runAvisoRespuestasReactivacion(env, NOW)).toBe(0); // crea la columna; nadie ha respondido
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", ["m1", "ycloud:34600000050", "user", "Hola, sí me interesa ver las opciones", NOW - 600_000]);
    expect(await runAvisoRespuestasReactivacion(env, NOW)).toBe(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1].body).toContain("sí me interesa");
    expect(notifyMock.mock.calls[0][1].body).toContain("Revisar en el futuro");
    expect(await runAvisoRespuestasReactivacion(env, NOW + 900_000)).toBe(0); // no se repite
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
