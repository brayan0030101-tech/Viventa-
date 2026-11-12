import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import type { Env } from "../../src/env";

let db: Db;
let env: Env;
const visto: { pendienteDuranteBusqueda: unknown } = { pendienteDuranteBusqueda: "no leído" };

vi.mock("../../member/crm-zohoapi.local", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    zohoListo: () => true,
    buscarCandidato: vi.fn(async () => {
      const r = await db.first<{ p: number | null }>("SELECT json_extract(COALESCE(metadata,'{}'),'$.viabilidad_pendiente') AS p FROM conversations WHERE id = 'ycloud:34600000099'");
      visto.pendienteDuranteBusqueda = r?.p ?? null;
      return null;
    }),
  };
});
import { enviarViabilidadTool } from "../../member/viabilidad.local";

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1 } as unknown as Env;
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000099", "ycloud", "34600000099", "Ana", 1, 1]);
});

describe("enviarViabilidad: no deja a la clienta sin su formulario", () => {
  it("la conversación queda marcada como pendiente ANTES de buscar/subir a Zoho (si el turno se corta, la pasada de 15 min lo envía); si no hay forma de enviarlo, la marca se quita", async () => {
    const t = enviarViabilidadTool(env, () => "ycloud:34600000099");
    const r = (await (t as any).execute({})) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(visto.pendienteDuranteBusqueda).not.toBeNull();
    const m = await db.first<{ p: number | null }>("SELECT json_extract(COALESCE(metadata,'{}'),'$.viabilidad_pendiente') AS p FROM conversations WHERE id = 'ycloud:34600000099'");
    expect(m?.p ?? null).toBeNull();
  });
});
