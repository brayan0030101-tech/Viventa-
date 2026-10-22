/** Guardián de las instrucciones del bot: copias, reglas imprescindibles y restaurar. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const notifyMock = vi.fn();
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import { runGuardianInstrucciones, versionesInstrucciones, restaurarInstrucciones, MARCADORES } from "../../src/followup/guardianInstrucciones";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const COMPLETO = MARCADORES.map((m) => m.texto).join("\n") + "\nresto";

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1 } as unknown as Env;
  notifyMock.mockReset().mockResolvedValue(true);
});

describe("guardián de instrucciones", () => {
  it("guarda una copia solo cuando el texto cambia y no avisa si están todas las reglas", async () => {
    const st = new SettingsRepo(db);
    await st.set("custom_instructions", COMPLETO);
    expect((await runGuardianInstrucciones(env, 1000)).guardada).toBe(true);
    expect((await runGuardianInstrucciones(env, 2000)).guardada).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
    expect((await versionesInstrucciones(env))).toHaveLength(1);
  });

  it("avisa si falta una regla imprescindible o el texto se encoge", async () => {
    const st = new SettingsRepo(db);
    await st.set("custom_instructions", COMPLETO + "x".repeat(2000));
    await runGuardianInstrucciones(env, 1000);
    await st.set("custom_instructions", COMPLETO.replace("REGLAS DE CALIFICACION", "otra cosa"));
    const r = await runGuardianInstrucciones(env, 2000);
    expect(r.faltan).toEqual(["calificacion"]);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1].body).toContain("calificacion");
  });

  it("restaura una versión guardando antes la actual", async () => {
    const st = new SettingsRepo(db);
    await st.set("custom_instructions", COMPLETO);
    await runGuardianInstrucciones(env, 1000);
    const [v1] = await versionesInstrucciones(env);
    await st.set("custom_instructions", "texto roto");
    const r = await restaurarInstrucciones(env, v1.id, 3000);
    expect(r.ok).toBe(true);
    expect(await st.get("custom_instructions")).toBe(COMPLETO);
    expect((await versionesInstrucciones(env)).length).toBe(2);
  });
});
