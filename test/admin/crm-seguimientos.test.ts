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
import { hoyMadrid, masDias, leerBorrador, prepararBorrador, renderSeguimientos, fragmentoBorrador, cargarSeguimientos, aplicarEnZoho } from "../../member/crm-seguimientos.local";
import { tokenZoho, tareasPendientes } from "../../member/crm-zohoapi.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 13, 10, 0); // 13 oct 2026 12:00 en España
const TAREA = "2259602000011111111";
const LEAD = "2259602000022222222";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const llamadas: string[] = [];
const escrituras: Array<{ url: string; method: string; body: Record<string, any> }> = [];
let fallaCrearTarea = false;
let estadoTarea = "En Proceso";
const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  llamadas.push(url);
  const metodo = init?.method ?? "GET";
  if ((metodo === "POST" || metodo === "PUT") && url.includes("/crm/v6/") && !url.endsWith("/coql") && !url.includes("/oauth/")) {
    escrituras.push({ url, method: metodo, body: JSON.parse(String(init?.body)).data[0] });
    if (fallaCrearTarea && metodo === "POST" && url.endsWith("/Tasks")) return json({ data: [{ status: "error", message: "boom" }] }, 400);
    return json({ data: [{ status: "success", details: { id: "9990001" } }] });
  }
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok-" + llamadas.length, expires_in: 3600 });
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: "555", full_name: "Maricela Naranjo" }] });
  if (url.endsWith("/coql")) {
    const q = String(JSON.parse(String(init?.body)).select_query);
    const fila = { id: TAREA, Subject: "Seguimiento Diana", Due_Date: "2026-10-12", Status: estadoTarea, Who_Id: { id: LEAD, name: "Diana" }, What_Id: null, $se_module: "Leads", Description: "" };
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
  escrituras.length = 0;
  fallaCrearTarea = false;
  estadoTarea = "En Proceso";
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
  it("más de 3 intentos sin respuesta: pasa a «Revisar en el futuro» con un último mensaje y SIN siguiente tarea (Zoho la crea a 3 meses)", () => {
    const b = leerBorrador('{"temperatura":"frio","accion":"futuro","mensaje":"Hola [nombre], no te llenamos de mensajes; cuando quieras retomar, aquí estamos.","dias_siguiente":3,"tarea_siguiente":"Revisar si quiere retomar"}', base)!;
    expect(b.accion).toBe("futuro");
    expect(b.diasSiguiente).toBeNull();
    expect(b.tareaSiguiente).toBe("");
    expect(b.mensaje).toContain("Hola Diana");
    expect(leerBorrador('{"temperatura":"frio","accion":"futuro","mensaje":""}', base)).not.toBeNull(); // el último aviso es opcional
  });
  it("«perdido» y «descartado»: sin mensaje ni tarea, con el motivo de la lista de Zoho (o uno neutro si la IA inventa)", () => {
    const p = leerBorrador('{"temperatura":"frio","accion":"perdido","mensaje":"","motivo_cierre":"precio muy alto"}', base)!;
    expect(p.diasSiguiente).toBeNull();
    expect(p.motivoCierre).toBe("Precio muy alto");
    expect(p.tareaSiguiente).toBe("");
    const d = leerBorrador('{"temperatura":"frio","accion":"descartado","mensaje":"","motivo_cierre":"No quiere ser contactado"}', base)!;
    expect(d.motivoCierre).toBe("No quiere ser contactado");
    expect(leerBorrador('{"temperatura":"frio","accion":"perdido","mensaje":"","motivo_cierre":"se mudó a Marte"}', base)!.motivoCierre).toBe("No interesado");
    expect(leerBorrador('{"temperatura":"frio","accion":"descartado","mensaje":"","motivo_cierre":"x"}', base)!.motivoCierre).toBe("No quiere ser contactado");
    expect(leerBorrador('{"temperatura":"frio","accion":"cerrar","mensaje":""}', base)).toBeNull(); // la acción vieja ya no existe
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
  it("para «futuro» la tarjeta avisa que hay que cambiar el estado en Zoho y la IA conoce la regla", async () => {
    generarMock.mockResolvedValue({ text: '{"temperatura":"frio","accion":"futuro","mensaje":"Hola [nombre], cuando quieras retomar, aquí estamos.","motivo":"4 intentos sin respuesta","nota":"n","tarea_siguiente":"Revisar si quiere retomar"}' });
    const html = await fragmentoBorrador(env, TAREA, true, NOW, zoho as never);
    expect((generarMock.mock.calls[0][0] as { prompt: string }).prompt).toContain("MÁS DE 3 intentos");
    expect(html).toContain("Revisar en el futuro");
    expect(html).toContain("más de 3 intentos sin respuesta");
    expect(html).toContain("Zoho la programa solo a los 3 meses");
    expect(html).not.toContain("Siguiente tarea en Zoho ·"); // no se propone otra tarea
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


describe("fase 2: actualizar Zoho", () => {
  const ENTRADA = { nota: "Se propuso videollamada.", tareaSiguiente: "Confirmar si desea agendar la videollamada" };
  const activar = () => db.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('zoho_escritura','activo',?)", [NOW]);

  it("con la escritura apagada no toca Zoho", async () => {
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    const r = await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("solo lectura");
    expect(escrituras).toHaveLength(0);
  });

  it("nota + siguiente tarea «En Proceso» a nombre de Maricela + tarea de hoy completa", async () => {
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    const r = await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW);
    expect(r.ok && r.siguiente).toEqual({ asunto: "Confirmar si desea agendar la videollamada", fecha: "2026-10-20" }); // tibio, 7 días
    expect(escrituras.map((e) => `${e.method} ${e.url.replace(/^.*\/crm\/v6/, "")}`)).toEqual([`POST /Leads/${LEAD}/Notes`, "POST /Tasks", `PUT /Tasks/${TAREA}`]);
    expect(escrituras[0].body.Note_Content).toBe("Se propuso videollamada.");
    expect(escrituras[1].body).toMatchObject({ Subject: "Confirmar si desea agendar la videollamada", Due_Date: "2026-10-20", Status: "En Proceso", Owner: { id: "555" }, What_Id: { id: LEAD }, $se_module: "Leads" });
    expect(escrituras[2].body).toEqual({ Status: "Completa" });
    // nunca se borra nada
    expect(escrituras.some((e) => (e.method as string) === "DELETE")).toBe(false);
  });

  it("no repite nada si se pulsa dos veces", async () => {
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW);
    const n = escrituras.length;
    const otra = await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW + 1000);
    expect(otra.ok && otra.yaHecho).toBe(true);
    expect(escrituras).toHaveLength(n);
  });

  it("si falla un paso, al reintentar no duplica la nota y termina lo que faltaba", async () => {
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    fallaCrearTarea = true;
    const mal = await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW);
    expect(mal.ok).toBe(false);
    expect(mal.pasos.nota).toBeTruthy();
    expect(mal.pasos.completada).toBeUndefined(); // no se completó la tarea de hoy sin crear la siguiente
    fallaCrearTarea = false;
    const bien = await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW + 1000);
    expect(bien.ok).toBe(true);
    expect(escrituras.filter((e) => e.url.endsWith("/Notes"))).toHaveLength(1);
    expect(escrituras.filter((e) => e.method === "PUT" && e.url.includes("/Tasks/"))).toHaveLength(1);
  });

  it("«futuro»: nota + tarea completa + estado «Revisar en el futuro», sin crear otra tarea", async () => {
    generarMock.mockResolvedValue({ text: '{"temperatura":"frio","accion":"futuro","mensaje":"Hola [nombre], cuando quieras, aquí estamos.","motivo":"4 intentos","nota":"Sin respuesta tras 4 intentos.","tarea_siguiente":""}' });
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    const r = await aplicarEnZoho(env, TAREA, { nota: "Sin respuesta tras 4 intentos.", tareaSiguiente: "" }, { f: zoho as never }, NOW);
    expect(r.ok).toBe(true);
    expect(escrituras.some((e) => e.url.endsWith("/Tasks") && e.method === "POST")).toBe(false);
    expect(escrituras.find((e) => e.url.endsWith(`/Leads/${LEAD}`))?.body).toEqual({ Lead_Status: "Revisar en el futuro" });
    expect(escrituras.some((e) => e.url.endsWith(`/Tasks/${TAREA}`) && e.body.Status === "Completa")).toBe(true);
  });

  it("«perdido»: nota + tarea completa + estado y motivo en el campo «motivo», sin tarea nueva", async () => {
    generarMock.mockResolvedValue({ text: '{"temperatura":"frio","accion":"perdido","mensaje":"","motivo_cierre":"Desistio compra","nota":"Desistió de comprar."}' });
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    const r = await aplicarEnZoho(env, TAREA, { nota: "Desistió de comprar.", tareaSiguiente: "", motivo: "Precio muy alto" }, { f: zoho as never }, NOW);
    expect(r.ok).toBe(true);
    expect(escrituras.some((e) => e.url.endsWith("/Tasks") && e.method === "POST")).toBe(false);
    expect(escrituras.find((e) => e.url.endsWith(`/Leads/${LEAD}`))?.body).toEqual({ Lead_Status: "Cliente perdido", motivo: "Precio muy alto" });
    expect(escrituras.map((e) => e.method + " " + e.url.replace(/^.*\/crm\/v6/, ""))).toEqual([`POST /Leads/${LEAD}/Notes`, `PUT /Tasks/${TAREA}`, `PUT /Leads/${LEAD}`]);
  });

  it("«descartado»: un motivo que no esté en la lista se cambia por el del borrador", async () => {
    generarMock.mockResolvedValue({ text: '{"temperatura":"frio","accion":"descartado","mensaje":"","motivo_cierre":"No quiere ser contactado","nota":"Pidió que no lo llamen."}' });
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    await aplicarEnZoho(env, TAREA, { nota: "Pidió que no lo llamen.", tareaSiguiente: "", motivo: "inventado" }, { f: zoho as never }, NOW);
    expect(escrituras.find((e) => e.url.endsWith(`/Leads/${LEAD}`))?.body).toEqual({ Lead_Status: "Descartado", motivo: "No quiere ser contactado" });
  });

  it("si la tarea ya estaba completa en Zoho no cambia nada", async () => {
    await prepararBorrador(env, TAREA, { f: zoho as never }, NOW);
    await activar();
    estadoTarea = "Completa";
    const r = await aplicarEnZoho(env, TAREA, ENTRADA, { f: zoho as never }, NOW);
    expect(r.ok && r.aviso).toContain("ya estaba completa");
    expect(escrituras).toHaveLength(0);
  });

  it("la tarjeta muestra el botón solo con la escritura activa y pide confirmar", async () => {
    const apagada = await fragmentoBorrador(env, TAREA, false, NOW, zoho as never);
    expect(apagada).toContain("solo lectura");
    expect(apagada).not.toContain("Ya lo envié: actualizar Zoho");
    await activar();
    const activa = await fragmentoBorrador(env, TAREA, false, NOW, zoho as never);
    expect(activa).toContain("Ya lo envié: actualizar Zoho");
    expect(activa).toContain("hx-confirm=");
    expect(activa).toContain("marcar ESTA tarea como completa");
    expect(activa).toContain('name="tarea_siguiente"');
  });
});
