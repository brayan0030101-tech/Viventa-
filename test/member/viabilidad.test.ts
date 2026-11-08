/** El bot envía el enlace personal del formulario de viabilidad (lo genera Zoho en la ficha del candidato). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { obtenerEnlaceViabilidad, textoViabilidad } from "../../member/viabilidad.local";
import type { Env } from "../../src/env";

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const LEAD = "2259602002400000001";
let env: Env;
let db: Db;
let enlace: string | null = "https://cutt.ly/AbCd1234";
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const zoho = vi.fn(async (url: string) => {
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes(`/Leads/${LEAD}`)) return json({ data: [{ id: LEAD, Enlace_corto_Formulario_Consulta_Centrales: enlace, Enlace_largo_Formulario_Consulta_Centrales: enlace ? "https://forms.viventa.co/x" : null }] });
  return new Response("", { status: 204 });
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "ref" } as unknown as Env;
  enlace = "https://cutt.ly/AbCd1234";
  zoho.mockClear();
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at, metadata) VALUES (?,?,?,?,?,?,?)", ["ycloud:34600000077", "ycloud", "34600000077", "Ana", 1, NOW, JSON.stringify({ zoho_lead_id: LEAD })]);
});

describe("formulario de viabilidad", () => {
  it("lee el enlace corto personal de la ficha del candidato", async () => {
    expect(await obtenerEnlaceViabilidad(env, "ycloud:34600000077", zoho as never, NOW)).toEqual({ ok: true, url: "https://cutt.ly/AbCd1234" });
  });
  it("si Zoho todavía no lo generó queda pendiente (no inventa nada)", async () => {
    enlace = null;
    expect(await obtenerEnlaceViabilidad(env, "ycloud:34600000077", zoho as never, NOW)).toMatchObject({ ok: false, pendiente: true });
  });
  it("el mensaje lleva el enlace, la cédula, los 5 minutos y que no garantiza el crédito", () => {
    const t = textoViabilidad("https://cutt.ly/AbCd1234");
    expect(t).toContain("https://cutt.ly/AbCd1234");
    expect(t).toMatch(/cédula/);
    expect(t).toMatch(/5 minutos/);
    expect(t).toMatch(/no garantiza/);
  });
});
