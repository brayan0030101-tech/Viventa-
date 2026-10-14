/**
 * CRM de Maricela: seguimientos de Zoho (fase 1: solo borradores).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { hoyMadrid, masDias, leerBorrador, prepararBorrador, renderSeguimientos, fragmentoBorrador, cargarSeguimientos } from "../../member/crm-seguimientos.local";
import { tokenZoho, tareasPendientes } from "../../member/crm-zohoapi.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 13, 10, 0); // 13 oct 2026 12:00 en España
const TAREA = "2259602000011111111";
const LEAD = "2259602000022222222";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const llamadas: string[] = [];
const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  llamadas.push(url);
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok-" + llamadas.length, expires_in: 3600 });
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: "555", full_name: "Maricela Naranjo" }] });
  if (url.endsWith("/coql")) {
    const q = String(JSON.parse(String(init?.body)).select_query);
    const fila = { id: TAREA, Subject: "Seguimiento Diana", Due_Date: "2026-10-12", Status: "En Proceso", Who_Id: { id: LEAD, name: "Diana" }, What_Id: null, $se_module: "Leads", Description: "" };
    if (q.includes(`where id = '${TAREA}'`)) return json({ data: [fila] });
    return json({ data: [fila, { ...fila, id: "2259602000033333333", Who_Id: { id: "2259602000099999999" } }] });
  }
  if (url.includes("/crm/v6/Leads?ids=")) {
    return json({ data: [{ id: LEAD, Full_Name: "Diana Zuñiga", Mobile: "+34600000009", Email: "diana@correo.com", Country: "España", Lead_Status: "Contactado" }] });
  }
  if (url.includes(`/Leads/${LEAD}/Notes`)) {
    return json({ data: [{ Note_Title: "Llamada", Note_Content: "Diana Zuñiga vio 3 proyectos, gana 1.200 euros, quedó en revisar con su esposo. Tel 600000009", Created_Time: "2026-10-09T10:00:00+02:00" }] });
  }
  return json({ message: "no existe" }, 404);
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "ref" } as unknown as Env;
  llamadas.length = 0;
  zoho.mockClear();
  generarMock.mockReset().mockResolvedValue({
    text: '```json\n{"temperatura":"tibio","accion":"videollamada","proyectos_enviados":true,"segundo_titular":true,"mensaje":"Hola [nombre], ¿pudiste revisar con tu esposo los proyectos? Podemos verlo en una videollamada corta.","motivo":"Ya vio proyectos y gana menos de 1.250 euros","dias_siguiente":9,"razon_cierre":"","nota":"Se propuso videollamada y segundo titular.","tarea_siguiente":"Confirmar si desea agendar la videollamada"}\n```',
  });
});

describe("fechas", () => {
  it("hoy en España y suma de días", () => {
    expect(hoyMadrid(Date.UTC(2026, 9, 12, 23, 30))).toBe("2026-10-13"); // 01:30 del 13 en España
    expect(masDias("2026-10-30", 3)).toBe("2026-11-02");
  });
});

describe("leerBorrador", () => {
  const base = { tareaId: "t", leadId: "l", nombre: "Diana Zuñiga", creado: 1, modelo: "m" };
  it("pone el nombre, limita los días al plazo de su temperatura y rechaza acciones inválidas", () => {
    const b = leerBorrador('{"temperatura":"caliente","accion":"whatsapp","mensaje":"Hola [nombre], ¿sigues interesada?","dias_siguiente":10,"nota":"x"}', base)!;
    expect(b.mensaje).toBe("Hola Diana, ¿sigues interesada?");
    expect(b.diasSiguiente).toBe(3); // caliente: 2 a 3 días
    expect(leerBorrador('{"temperatura":"frio","accion":"whatsapp","mensaje":"Hola","dias_siguiente":2}', base)!.diasSiguiente).toBe(14);
    expect(leerBorrador('{"temperatura":"tibio","accion":"whatsapp","mensaje":"Hola"}', base)!.diasSiguiente).toBe(5);
    expect(leerBorrador('{"temperatura":"tibio","accion":"llamar","mensaje":"Hola"}', base)).toBeNull();
    expect(leerBorrador('{"temperatura":"tibio","accion":"whatsapp","mensaje":""}', base)).toBeNull();
    expect(leerBorrador("sin json", base)).toBeNull();
  });
  it("cerrar no lleva mensaje ni siguiente tarea", () => {
    const b = leerBorrador('{"temperatura":"frio","accion":"cerrar","razon_cierre":"compro","mensaje":""}', base)!;
    expect(b.diasSiguiente).toBeNull();
    expect(b.razonCierre).toBe("compro");
  });
});

describe("conexión con Zoho", () => {
  it("reutiliza el token hasta que vence y solo pide tareas de su dueña", async () => {
    const a = await tokenZoho(env, NOW, zoho as never);
    const b = await tokenZoho(env, NOW + 60_000, zoho as never);
    expect(b).toBe(a);
    expect(llamadas.filter((u) => u.includes("/oauth/v2/token"))).toHaveLength(1);
    await tokenZoho(env, NOW + 3_700_000, zoho as never);
    expect(llamadas.filter((u) => u.includes("/oauth/v2/token"))).toHaveLength(2);
  });
  it("lee las tareas pendientes ligadas a candidatos", async () => {
    const t = await tareasPendientes(env, "2026-10-13", zoho as never, NOW);
    expect(t.map((x) => x.leadId)).toEqual([LEAD, "2259602000099999999"]);
    const coql = zoho.mock.calls.find((c) => String(c[0]).endsWith("/coql"))!;
    const q = String(JSON.parse(String(coql[1]?.body)).select_query);
    expect(q).toContain("Owner = '555'");
    expect(q).toContain("Due_Date <= '2026-10-13'");
    expect(q).toContain("not in ('Completa','Completed')");
  });
});

describe("borrador de seguimiento", () => {
  it("no manda nombre, correo ni teléfono a la IA, guarda el borrador y no gasta IA dos veces", async () => {
    const r = await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    expect(r.ok && r.borrador.mensaje).toContain("Hola Diana");
    const prompt = (generarMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Diana");
    expect(prompt).not.toContain("Zuñiga");
    expect(prompt).not.toContain("600000009");
    expect(prompt).toContain("1.200 euros");
    expect(prompt).toContain("1.250 euros");
    expect(r.ok && r.borrador.diasSiguiente).toBe(7); // tibio: 5 a 7
    expect(prompt).toContain("LA TAREA DE HOY MANDA");
    expect(prompt).toContain("Seguimiento"); // el asunto de la tarea llega a la IA
    expect(r.ok && r.borrador.tareaSiguiente).toBe("Confirmar si desea agendar la videollamada");
    const otra = await prepararBorrador(env, TAREA, { f: zoho as never }, NOW + 1000);
    expect(otra.ok && otra.reutilizado).toBe(true);
    expect(generarMock).toHaveBeenCalledTimes(1);
    await prepararBorrador(env, TAREA, { f: zoho as never, forzar: true }, NOW + 2000);
    expect(generarMock).toHaveBeenCalledTimes(2);
  });
  it("usa lo que el bot ya sabe del cliente (conversación y ficha) cuando el teléfono coincide", async () => {
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000009", "ycloud", "34600000009", "Diana", NOW - 9e6, NOW - 3600_000]);
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", ["m1", "ycloud:34600000009", "user", "Hola, soy Diana, prefiero Cartagena", NOW - 3600_000]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ["l1", "ycloud:34600000009", "Diana", "34600000009", "compra", JSON.stringify({ ciudadCompra: "Cartagena" }), "new", NOW, NOW]);
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    const prompt = (generarMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Cartagena");
    expect(prompt).not.toContain("soy Diana");
  });
  it("si la IA falla devuelve un error claro y no guarda nada", async () => {
    generarMock.mockRejectedValueOnce(new Error("caída"));
    const r = await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    expect(r.ok).toBe(false);
    const g = await db.first("SELECT 1 FROM crm_seg_borrador WHERE tarea_id = ?", [TAREA]);
    expect(g).toBeNull();
  });
});

describe("pantalla", () => {
  it("lista las tareas vencidas con su candidato y botón, sin tocar nada en Zoho", async () => {
    const { filas } = await cargarSeguimientos(env, NOW, zoho as never);
    expect(filas).toHaveLength(1); // la otra tarea no es de un candidato conocido
    expect(filas[0].atraso).toBe(1);
    const html = await renderSeguimientos(env, NOW, zoho as never);
    expect(html).toContain("Diana Zuñiga");
    expect(html).toContain("Vencida hace 1 día");
    expect(html).toContain("Preparar mensaje");
    const escrituras = zoho.mock.calls.filter((c) => (c[1]?.method ?? "GET") !== "GET" && !String(c[0]).endsWith("/coql") && !String(c[0]).includes("/oauth/"));
    expect(escrituras).toHaveLength(0);
  });
  it("sin Zoho conectado lo dice en vez de fallar", async () => {
    const html = await renderSeguimientos({ ...env, ZOHO_REFRESH_TOKEN: undefined } as Env, NOW, zoho as never);
    expect(html).toContain("Zoho todavía no está conectado");
  });
  it("el fragmento del borrador trae mensaje, siguiente tarea y aviso de modo borrador", async () => {
    const html = await fragmentoBorrador(env, TAREA, false, NOW, zoho as never);
    expect(html).toContain("Hola Diana");
    expect(html).toContain("Modo borrador: no se cambió nada en Zoho");
    expect(html).toContain("2026-10-20"); // 13 oct + 7 días
    expect(html).toContain("Siguiente tarea en Zoho");
    expect(html).toContain("Confirmar si desea agendar la videollamada");
    // Sin conversación en el panel de Forja: queda el respaldo de WhatsApp, avisando por qué.
    expect(html).toContain("wa.me/34600000009");
    expect(html).toContain("todavía no tiene conversación en el panel de Forja");
  });
  it("con conversación en el panel, el botón abre ESA conversación con el mensaje (no WhatsApp)", async () => {
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000009", "ycloud", "34600000009", "Diana", NOW - 9e6, NOW - 3600_000]);
    const html = await fragmentoBorrador(env, TAREA, false, NOW, zoho as never);
    expect(html).toContain("Abrir la conversación en el panel de Forja");
    expect(html).toContain("/admin/conversations?c=ycloud%3A34600000009");
    expect(html).toContain("&texto=");
    expect(html).not.toContain("wa.me/");
  });
});

describe("permisos que faltan", () => {
  it("lo dice claro cuando Zoho rechaza por permisos", async () => {
    const sinPermiso = vi.fn(async (url: string) => (url.includes("/oauth/") ? json({ access_token: "t", expires_in: 3600 }) : json({ code: "OAUTH_SCOPE_MISMATCH", message: "invalid oauth scope" }, 401)));
    await expect(tareasPendientes(env, "2026-10-13", sinPermiso as never, NOW)).rejects.toThrow(/falta un permiso/i);
  });
});
