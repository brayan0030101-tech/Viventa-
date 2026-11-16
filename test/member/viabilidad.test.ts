/** El bot envía el enlace personal del formulario de viabilidad (lo genera Zoho en la ficha del candidato). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { obtenerEnlaceViabilidad, textoViabilidad, generarEnlaceEnZoho, AJUSTE_FUNCION } from "../../member/viabilidad.local";
import { olvidarDuenos } from "../../member/crm-zohoapi.local";
import type { Env } from "../../src/env";

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const LEAD = "2259602002400000001";
let env: Env;
let db: Db;
let enlace: string | null = "https://cutt.ly/AbCd1234";
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const llamadasFuncion: Array<{ url: string; body: string }> = [];
const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/functions/")) {
    llamadasFuncion.push({ url, body: String(init?.body ?? "") });
    return json({ code: "success", details: { output: "ok" } });
  }
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: "555", full_name: "Maricela Naranjo" }] });
  if (url.includes(`/Leads/${LEAD}?fields=Owner`)) return json({ data: [{ Owner: { id: "555", name: "Maricela Naranjo" } }] });
  if (url.includes(`/Leads/${LEAD}?fields=Phone`)) return json({ data: [{ Phone: "+34600000077", Mobile: "+34600000077", Email: "ana@correo.com" }] });
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
  llamadasFuncion.length = 0;
  olvidarDuenos();
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
  it("el botón de Zoho («Enviar Formulario CC») NO se ejecuta si el ajuste está apagado", async () => {
    enlace = null;
    expect(await obtenerEnlaceViabilidad(env, "ycloud:34600000077", zoho as never, NOW)).toMatchObject({ ok: false, pendiente: true });
    expect(llamadasFuncion).toHaveLength(0);
  });
  it("con el ajuste activo ejecuta la función del botón UNA sola vez por cliente (Zoho además manda un correo) y con los datos de la ficha", async () => {
    enlace = null;
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)", [AJUSTE_FUNCION, "activo", NOW]);
    await obtenerEnlaceViabilidad(env, "ycloud:34600000077", zoho as never, NOW);
    await obtenerEnlaceViabilidad(env, "ycloud:34600000077", zoho as never, NOW + 60_000);
    expect(llamadasFuncion).toHaveLength(1);
    expect(llamadasFuncion[0].url).toContain("/functions/envia_encuesta_centrales/actions/execute");
    expect(JSON.parse(llamadasFuncion[0].body).arguments).toEqual({ id: LEAD, Telefono: "+34600000077", Mobile: "+34600000077", email: "ana@correo.com" });
    expect(await generarEnlaceEnZoho(env, "ycloud:34600000077", LEAD, { forzar: true, f: zoho as never, now: NOW })).toMatchObject({ ok: false });
  });
  it("el mensaje lleva el enlace, la cédula, los 5 minutos y que no garantiza el crédito", () => {
    const t = textoViabilidad("https://cutt.ly/AbCd1234");
    expect(t).toContain("https://cutt.ly/AbCd1234");
    expect(t).toMatch(/cédula/);
    expect(t).toMatch(/5 minutos/);
    expect(t).toMatch(/no garantiza/);
  });
});
