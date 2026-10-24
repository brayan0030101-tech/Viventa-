/**
 * CRM de Maricela (15 oct 2026): reglas de agenda (sin fines de semana, máx. 25 por día), cambiar la fecha de una tarea,
 * nota y tarea del candidato nuevo, y lista de «En Prospección».
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import { elegirFecha, esFinDeSemana, MAX_TAREAS_DIA } from "../../member/crm-agenda.local";
import { olvidarDuenos } from "../../member/crm-zohoapi.local";
import { cambiarFecha } from "../../member/crm-seguimientos.local";
import { crearNotaYTarea } from "../../member/crm-zohonuevo.local";
import { clasificar, renderProspeccion, cargarProspeccion } from "../../member/crm-prospeccion.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 15, 10, 0); // jueves 15 oct 2026, 12:00 en España
const TAREA = "2259602000011111111";
const LEAD = "2259602000022222222";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const escrituras: Array<{ url: string; method: string; body: Record<string, any> }> = [];
let cargaPorDia: Record<string, number> = {};
let candidatosProspeccion: Array<Record<string, unknown>> = [];
let buscarDevuelve = true;
let duenoLead = "555";

const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  const metodo = init?.method ?? "GET";
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: "555", full_name: "Maricela Naranjo" }] });
  if (/\/Leads\/\d+\?fields=Owner/.test(url)) return json({ data: [{ Owner: { id: duenoLead, name: duenoLead === "555" ? "Maricela Naranjo" : "Otra Asesora" } }] });
  if ((metodo === "POST" || metodo === "PUT") && url.includes("/crm/v6/") && !url.endsWith("/coql")) {
    escrituras.push({ url, method: metodo, body: (JSON.parse(String(init?.body)) as { data: Array<Record<string, any>> }).data[0]! });
    return json({ data: [{ status: "success", details: { id: "777" + escrituras.length } }] });
  }
  if (url.endsWith("/coql")) {
    const q = String(JSON.parse(String(init?.body)).select_query);
    if (q.includes(`where id = '${TAREA}'`)) return json({ data: [{ id: TAREA, Subject: "Seguimiento", Due_Date: "2026-10-15", Status: "En Proceso", Who_Id: { id: LEAD }, What_Id: null, $se_module: "Leads", Description: "" }] });
    const dia = q.match(/Due_Date = '(\d{4}-\d{2}-\d{2})'/)?.[1];
    if (dia) return json({ data: Array.from({ length: cargaPorDia[dia] ?? 0 }, (_, i) => ({ id: String(i) })) });
    if (q.includes("from Leads where Email =") || q.includes("Mobile like")) {
      return buscarDevuelve ? json({ data: [{ id: LEAD, Full_Name: "Ana Pérez", Mobile: "+34 600 000 001", Email: "ana@correo.com", Country: "España", Lead_Status: "En Prospección", Created_Time: "2026-10-14T10:00:00+02:00" }] }) : new Response("", { status: 204 });
    }
    if (q.includes("Lead_Status = 'En Prospección'")) return json({ data: candidatosProspeccion });
  }
  return json({ message: "no existe" }, 404);
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "ref" } as unknown as Env;
  escrituras.length = 0;
  cargaPorDia = {};
  candidatosProspeccion = [];
  buscarDevuelve = true;
  zoho.mockClear();
  generarMock.mockReset().mockResolvedValue({ text: '{"nota":"El cliente vive en España y busca vivienda en Medellín como inversión.","tarea":"Llamar para presentar proyectos","cuando":""}' });
  await new SettingsRepo(db).set("zoho_escritura", "activo");
});

describe("reglas de agenda", () => {
  it("fin de semana: pasa al lunes; día lleno: pasa al siguiente; fecha pasada: hoy", async () => {
    expect(esFinDeSemana("2026-10-17")).toBe(true); // sábado
    expect(esFinDeSemana("2026-10-19")).toBe(false);
    const vacio = async () => 0;
    expect(await elegirFecha("2026-10-16", "2026-10-15", vacio)).toEqual({ fecha: "2026-10-16", motivo: "" });
    const sab = await elegirFecha("2026-10-17", "2026-10-15", vacio);
    expect(sab.fecha).toBe("2026-10-19");
    expect(sab.motivo).toContain("fin de semana");
    const lleno = await elegirFecha("2026-10-16", "2026-10-15", async (d) => (d === "2026-10-16" ? MAX_TAREAS_DIA : 3));
    expect(lleno.fecha).toBe("2026-10-19"); // viernes lleno → sábado/domingo no → lunes
    expect(lleno.motivo).toContain("ya tiene 25 tareas");
    expect((await elegirFecha("2026-10-10", "2026-10-15", vacio)).fecha).toBe("2026-10-15");
    expect((await elegirFecha("2026-10-16", "2026-10-15", async () => 24)).fecha).toBe("2026-10-16"); // 24 aún cabe
  });
});

describe("cambiar la fecha de una tarea", () => {
  it("la cambia en Zoho; si cae en sábado la corre al lunes y lo dice", async () => {
    const ok = await cambiarFecha(env, TAREA, "2026-10-21", NOW, zoho);
    expect(ok).toMatchObject({ ok: true, fecha: "2026-10-21", aviso: "" });
    expect(escrituras.at(-1)).toMatchObject({ method: "PUT", body: { Due_Date: "2026-10-21" } });
    expect(escrituras.at(-1)!.url).toContain(`/Tasks/${TAREA}`);
    const sab = await cambiarFecha(env, TAREA, "2026-10-17", NOW, zoho);
    expect(sab).toMatchObject({ ok: true, fecha: "2026-10-19" });
    expect(escrituras.at(-1)!.body["Due_Date"]).toBe("2026-10-19");
  });
  it("con la escritura apagada no toca Zoho", async () => {
    await new SettingsRepo(db).set("zoho_escritura", "");
    const r = await cambiarFecha(env, TAREA, "2026-10-21", NOW, zoho);
    expect(r.ok).toBe(false);
    expect(escrituras).toHaveLength(0);
  });
  it("rechaza fechas inválidas", async () => {
    expect((await cambiarFecha(env, TAREA, "mañana", NOW, zoho)).ok).toBe(false);
  });
});

describe("nota y tarea del candidato nuevo", () => {
  async function sembrar() {
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000001", "ycloud", "34600000001", "Ana", NOW - 5000, NOW - 1000]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ["l1", "ycloud:34600000001", "Ana Pérez", "ana@correo.com", "compra", JSON.stringify({ ciudadCompra: "Medellín" }), "new", NOW - 4000, NOW - 4000]);
  }
  it("busca al candidato, crea la nota y la tarea (para hoy: cliente nuevo)  y no duplica al repetir", async () => {
    await sembrar();
    const r = await crearNotaYTarea(env, "ycloud:34600000001", { f: zoho }, NOW);
    expect(r).toMatchObject({ ok: true, yaHecho: false, fecha: "2026-10-15", candidato: "Ana Pérez" });
    const nota = escrituras.find((e) => e.url.endsWith(`/Leads/${LEAD}/Notes`))!;
    expect(nota.body["Note_Content"]).toContain("busca vivienda en Medellín");
    const tarea = escrituras.find((e) => e.url.endsWith("/Tasks"))!;
    expect(tarea.body).toMatchObject({ Subject: "Llamar para presentar proyectos", Due_Date: "2026-10-15", Status: "En Proceso", Owner: { id: "555" }, What_Id: { id: LEAD } });
    const n = escrituras.length;
    const otra = await crearNotaYTarea(env, "ycloud:34600000001", { f: zoho }, NOW);
    expect(otra).toMatchObject({ ok: true, yaHecho: true });
    expect(escrituras).toHaveLength(n);
  });
  it("si el cliente no está a nombre de Maricela no deja nota ni tarea", async () => {
    await sembrar();
    duenoLead = "999";
    olvidarDuenos();
    const antes = escrituras.length;
    const r = await crearNotaYTarea(env, "ycloud:34600000001", { f: zoho }, NOW);
    duenoLead = "555";
    olvidarDuenos();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("no está a nombre de Maricela");
    expect(escrituras.length).toBe(antes);
  });
  it("cliente nuevo: la tarea queda para hoy aunque el día ya tenga muchas", async () => {
    await sembrar();
    const viernes = Date.UTC(2026, 9, 16, 10, 0);
    const r = await crearNotaYTarea(env, "ycloud:34600000001", { f: zoho }, viernes);
    expect(r).toMatchObject({ ok: true, fecha: "2026-10-16" });
  });
  it("si no lo encuentra en Zoho, no crea nada y lo explica", async () => {
    await sembrar();
    buscarDevuelve = false;
    const r = await crearNotaYTarea(env, "ycloud:34600000001", { f: zoho }, NOW);
    expect(r.ok).toBe(false);
    expect(escrituras).toHaveLength(0);
  });
  it("con la escritura apagada no hace nada", async () => {
    await sembrar();
    await new SettingsRepo(db).set("zoho_escritura", "");
    expect((await crearNotaYTarea(env, "ycloud:34600000001", { f: zoho }, NOW)).ok).toBe(false);
    expect(escrituras).toHaveLength(0);
  });
});

describe("prospección", () => {
  const fila = (id: string, nombre: string, creado: string) => ({ id, Full_Name: nombre, Mobile: "+34600000009", Email: `${id}@c.com`, Country: "España", Lead_Status: "En Prospección", Created_Time: creado });
  it("semáforo: más de 30 días = vencido; 21–30 = por vencer", () => {
    const base = { id: "1", nombre: "X", movil: "", telefono: "", correo: "", pais: "", estado: "En Prospección" };
    expect(clasificar({ ...base, creado: "2026-09-14T10:00:00+02:00" }, NOW).semaforo).toBe("vencido"); // 31 días
    expect(clasificar({ ...base, creado: "2026-09-15T10:00:00+02:00" }, NOW).semaforo).toBe("por_vencer"); // 30 días
    expect(clasificar({ ...base, creado: "2026-09-24T10:00:00+02:00" }, NOW).semaforo).toBe("por_vencer"); // 21 días
    expect(clasificar({ ...base, creado: "2026-10-10T10:00:00+02:00" }, NOW).semaforo).toBe("ok");
  });
  it("lista ordenada del más antiguo, con totales y fecha de creación", async () => {
    candidatosProspeccion = [fila("a", "Reciente", "2026-10-12T10:00:00+02:00"), fila("b", "Antiguo", "2025-01-02T10:00:00+01:00"), fila("c", "Casi", "2026-09-20T10:00:00+02:00")];
    const filas = await cargarProspeccion(env, NOW, zoho);
    expect(filas.map((x) => x.c.nombre)).toEqual(["Antiguo", "Casi", "Reciente"]);
    const html = await renderProspeccion(env, {}, NOW, zoho);
    expect(html).toContain("Antiguo");
    expect(html).toContain("2025-01-02");
    expect(html).toContain("Más de un mes");
  });
});
