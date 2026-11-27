/**
 * Nota y siguiente tarea en una oportunidad, copiadas a su pareja SV ↔ Vivecasa (solo si ambas son de Maricela).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { SettingsRepo } from "../../src/db/settings";
import { Db } from "../../src/db/client";
import { aplicarEnOportunidad, parejaDe, formularioOp } from "../../member/crm-oportunidades.local";
import type { Env } from "../../src/env";

let env: Env;
const NOW = Date.UTC(2026, 10, 27, 10, 0); // viernes 27 nov 2026
const SV = "2259602000010000001";
const VC = "2259602000010000002";
const CONT = "2259602000020000001";
const T1 = "2259602000030000001";
const YO = "555";
let duenoVC = YO;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const escrituras: Array<{ url: string; method: string; body: Record<string, any> }> = [];
const deal = (id: string, nombre: string, tipo: string, pipeline: string | null, owner: string, extra: Record<string, unknown> = {}) => ({
  id, Deal_Name: nombre, Type: tipo, Pipeline: pipeline, Stage: "Nuevo", Owner: { id: owner, name: owner === YO ? "Maricela Naranjo" : "Otra Asesora" }, Contact_Name: { id: CONT }, Link_Oportunidad_SV: null, Link_Oportunidad_Vivecasa: null, Modified_Time: "2026-11-20T10:00:00+01:00", ...extra,
});

const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  const metodo = init?.method ?? "GET";
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: YO, full_name: "Maricela Naranjo" }] });
  if ((metodo === "POST" || metodo === "PUT") && !url.endsWith("/coql")) {
    escrituras.push({ url, method: metodo, body: (JSON.parse(String(init?.body)) as { data: Array<Record<string, any>> }).data[0]! });
    return json({ data: [{ status: "success", details: { id: "1" } }] });
  }
  if (url.endsWith("/coql")) {
    const q = String(JSON.parse(String(init?.body)).select_query);
    if (q.includes(`from Tasks where id = '${T1}'`) && q.includes("What_Id, $se_module") && !q.includes("Subject")) return json({ data: [{ What_Id: { id: SV }, $se_module: "Deals" }] });
    if (q.includes(`from Tasks where id = '${T1}'`)) return json({ data: [{ id: T1, Subject: "Llamar", Due_Date: "2026-11-27", Status: "No Iniciada", What_Id: { id: SV }, Who_Id: null, $se_module: "Deals" }] });
    if (q.includes("from Deals where Contact_Name")) return json({ data: [deal(SV, "Ana - SV", "Servicio Viventa", null, YO), deal(VC, "Ana - Vivecasa", "Preventa", "Standard (Vivecasa)", duenoVC)] });
    if (q.includes("from Tasks")) return json({ data: [] });
  }
  if (url.includes(`/crm/v6/Deals/${SV}`)) return json({ data: [deal(SV, "Ana - SV", "Servicio Viventa", null, YO, { Link_Oportunidad_Vivecasa: { id: VC, name: "Ana - Vivecasa" } })] });
  if (url.includes(`/crm/v6/Deals/${VC}`)) return json({ data: [deal(VC, "Ana - Vivecasa", "Preventa", "Standard (Vivecasa)", duenoVC)] });
  return json({ message: "no existe" }, 404);
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "ref" } as unknown as Env;
  escrituras.length = 0;
  duenoVC = YO;
  zoho.mockClear();
  await new SettingsRepo(new Db(d1)).set("zoho_escritura", "activo");
});

const entrada = { nota: "Hablé con ella; quedó en enviarme los documentos.", tareaSiguiente: "Llamarla para revisar los documentos", fecha: "2026-11-30", prioridad: "alta", copiar: true };

describe("oportunidades: pareja SV ↔ Vivecasa", () => {
  it("encuentra la otra oportunidad por el enlace entre ambas", async () => {
    const d = (await import("../../member/crm-zohoapi.local")).dealPorId;
    const sv = (await d(env, SV, zoho, NOW))!;
    const p = await parejaDe(env, sv, zoho, NOW);
    expect(p.ok && p.pareja.id).toBe(VC);
  });

  it("deja nota y tarea en las dos oportunidades y completa la tarea de hoy", async () => {
    const r = await aplicarEnOportunidad(env, T1, entrada, NOW, zoho);
    expect(r.ok).toBe(true);
    const notas = escrituras.filter((e) => e.url.endsWith("/Notes"));
    expect(notas.map((n) => n.url.match(/Deals\/(\d+)\/Notes/)![1]).sort()).toEqual([SV, VC]);
    const tareas = escrituras.filter((e) => e.url.endsWith("/Tasks") && e.method === "POST");
    expect(tareas.map((t) => t.body["What_Id"].id).sort()).toEqual([SV, VC]);
    expect(tareas.every((t) => t.body["$se_module"] === "Deals" && t.body["Priority"] === "High")).toBe(true);
    expect(escrituras.some((e) => e.method === "PUT" && e.url.includes(`/Tasks/${T1}`) && e.body["Status"] === "Completa")).toBe(true);
  });

  it("sin «copiar» solo escribe en la oportunidad de la tarea", async () => {
    await aplicarEnOportunidad(env, T1, { ...entrada, copiar: false }, NOW, zoho);
    expect(escrituras.some((e) => e.url.includes(VC))).toBe(false);
  });

  it("si la pareja es de OTRA asesora no escribe en ninguna y lo explica", async () => {
    duenoVC = "999";
    const r = await aplicarEnOportunidad(env, T1, entrada, NOW, zoho);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Otra Asesora|otra asesora/);
    expect(escrituras).toHaveLength(0);
    const html = await formularioOp(env, T1, NOW, zoho);
    expect(html).toMatch(/no se escribe en ella/);
    expect(html).not.toMatch(/name="copiar"/);
  });

  it("reintentar no duplica lo que ya se hizo", async () => {
    await aplicarEnOportunidad(env, T1, entrada, NOW, zoho);
    const antes = escrituras.length;
    await aplicarEnOportunidad(env, T1, entrada, NOW, zoho);
    expect(escrituras.length).toBe(antes);
  });

  it("el formulario ofrece copiar a la pareja cuando es de Maricela", async () => {
    const html = await formularioOp(env, T1, NOW, zoho);
    expect(html).toMatch(/name="copiar"/);
    expect(html).toContain("Ana - Vivecasa");
  });
});
