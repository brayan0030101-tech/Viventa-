/**
 * CRM de Maricela: oportunidades (Deals de Zoho) — un tablero con la rama SV / VC y sus tareas en Seguimientos.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import { cargarOportunidades, columnasEtapas, completarTareaOp, ramaDe, renderOportunidades, tareasDeOportunidades, htmlTareasOportunidades } from "../../member/crm-oportunidades.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 20, 10, 0); // martes 20 oct 2026
const D1 = "2259602000010000001";
const D2 = "2259602000010000002";
const D3 = "2259602000010000003";
const C1 = "2259602000020000001";
const C2 = "2259602000020000002";
const T1 = "2259602000030000001";
const T2 = "2259602000030000002";
const T3 = "2259602000030000003";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const escrituras: Array<{ url: string; method: string; body: Record<string, any> }> = [];
const iso = (d: string) => `${d}T10:00:00+02:00`;

const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  const metodo = init?.method ?? "GET";
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: "555", full_name: "Maricela Naranjo" }] });
  if (metodo === "PUT" && url.includes("/crm/v6/")) {
    escrituras.push({ url, method: metodo, body: (JSON.parse(String(init?.body)) as { data: Array<Record<string, any>> }).data[0]! });
    return json({ data: [{ status: "success", details: { id: "1" } }] });
  }
  if (url.endsWith("/coql")) {
    const q = String(JSON.parse(String(init?.body)).select_query);
    if (q.includes("from Deals")) {
      return json({ data: [
        { id: D1, Deal_Name: "Oportunidad Ana", Stage: "SV por iniciar", Type: "Servicio Viventa", Pipeline: null, Modified_Time: iso("2026-10-18"), Last_Activity_Time: iso("2026-10-19"), Contact_Name: { id: C1 }, Link_Oportunidad_SV: null, Link_Oportunidad_Vivecasa: { id: D3 } },
        { id: D2, Deal_Name: "Oportunidad Beto", Stage: "En gestión comercial", Type: "Servicio Viventa", Pipeline: null, Modified_Time: iso("2026-09-01"), Last_Activity_Time: null, Contact_Name: { id: C2 } },
        { id: D3, Deal_Name: "VC Ana", Stage: "Nuevo", Type: "Preventa", Pipeline: "Standard (Vivecasa)", Modified_Time: iso("2026-10-17"), Last_Activity_Time: iso("2026-10-17"), Contact_Name: { id: C1 }, Link_Oportunidad_SV: { id: D1 } },
      ] });
    }
    if (q.includes("from Tasks")) {
      return json({ data: [
        { id: T1, Subject: "Llamar a Ana", Due_Date: "2026-10-18", Status: "No Iniciada", What_Id: { id: D1 }, $se_module: "Deals" },
        { id: T2, Subject: "Enviar documentos", Due_Date: "2026-10-20", Status: "En Proceso", What_Id: { id: D3 }, $se_module: "Deals" },
        { id: T3, Subject: "Futura", Due_Date: "2026-11-30", Status: "No Iniciada", What_Id: { id: D3 }, $se_module: "Deals" },
      ] });
    }
    if (q.includes("from Contacts")) return json({ data: [{ id: C1 }, { id: C2 }] });
    if (q.includes(`where id = '${T1}'`)) return json({ data: [{ id: T1, Subject: "Llamar a Ana", Due_Date: "2026-10-18", Status: "No Iniciada", What_Id: { id: D1 }, Who_Id: null, $se_module: "Deals", Description: "" }] });
  }
  if (url.includes("/crm/v6/Contacts?ids=")) return json({ data: [{ id: C1, Full_Name: "Ana Pérez", Mobile: "+34600000001" }, { id: C2, Full_Name: "Beto Ruiz", Phone: "+34600000002" }] });
  return json({ message: "no existe" }, 404);
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "ref" } as unknown as Env;
  escrituras.length = 0;
  zoho.mockClear();
  await new SettingsRepo(db).set("zoho_escritura", "activo");
});

describe("oportunidades", () => {
  it("la rama sale del pipeline: «Standard (Vivecasa)» = VC, lo demás = SV", () => {
    expect(ramaDe("Standard (Vivecasa)")).toBe("VC");
    expect(ramaDe("", "Servicio Viventa")).toBe("SV");
    expect(ramaDe("", "Preventa")).toBe("VC");
  });

  it("carga las oportunidades con contacto, rama, etapa y tareas", async () => {
    const { ops, contactos } = await cargarOportunidades(env, NOW, zoho);
    expect(contactos).toBe(2);
    const a = ops.find((o) => o.id === D1)!;
    expect(a).toMatchObject({ nombre: "Ana Pérez", rama: "SV", etapa: "SV por iniciar", telefono: "+34600000001", tambienEn: "VC" });
    expect(a.tareas.map((t) => t.id)).toEqual([T1]);
    expect(ops.find((o) => o.id === D3)).toMatchObject({ rama: "VC", tambienEn: "SV" });
    expect(ops.find((o) => o.id === D3)!.tareas).toHaveLength(2);
    expect(ops.find((o) => o.id === D2)!.tareas).toHaveLength(0);
  });

  it("las columnas siguen el recorrido y las etapas desconocidas van al final", () => {
    const mk = (etapa: string) => ({ etapa }) as never;
    expect(columnasEtapas([mk("Facturado"), mk("Nuevo"), mk("Rara"), mk("En gestión comercial")])).toEqual(["Nuevo", "En gestión comercial", "Facturado", "Rara"]);
  });

  it("dibuja un solo tablero con las etiquetas SV y VC, el recorrido y los contadores", async () => {
    const html = await renderOportunidades(env, {}, NOW, zoho);
    expect(html).toContain("Ana Pérez");
    expect(html).toContain('data-rama="SV"');
    expect(html).toContain('data-rama="VC"');
    expect(html).toContain("Recorrido en Zoho");
    expect(html).toContain("Servicio Viventa");
    expect(html).toContain("Vivecasa");
    const soloVc = await renderOportunidades(env, { rama: "VC" }, NOW, zoho);
    expect(soloVc).not.toContain("Oportunidad Beto");
    expect(soloVc).toContain("Mostrando solo VC");
  });

  it("para Seguimientos: solo tareas vencidas o de hoy, de la más atrasada a la de hoy", async () => {
    const f = await tareasDeOportunidades(env, NOW, zoho);
    expect(f.map((x) => [x.tarea.id, x.atraso])).toEqual([[T1, 2], [T2, 0]]);
    const html = htmlTareasOportunidades(f, "2026-10-20", true);
    expect(html).toContain("Vencida hace 2 días");
    expect(html).toContain("Marcar completa");
    expect(html).toContain(">SV<");
    expect(html).toContain(">VC<");
  });

  it("marcar completa una tarea de oportunidad la cambia en Zoho; con la escritura apagada no", async () => {
    expect(await completarTareaOp(env, T1, NOW, zoho)).toEqual({ ok: true });
    expect(escrituras.at(-1)).toMatchObject({ method: "PUT", body: { Status: "Completa" } });
    expect(escrituras.at(-1)!.url).toContain(`/Tasks/${T1}`);
    await new SettingsRepo(db).set("zoho_escritura", "");
    escrituras.length = 0;
    expect((await completarTareaOp(env, T1, NOW, zoho)).ok).toBe(false);
    expect(escrituras).toHaveLength(0);
  });
});
