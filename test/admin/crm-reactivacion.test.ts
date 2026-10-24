/**
 * CRM de Maricela: reactivación de los clientes «Revisar en el futuro» (ventana de 45 a 60 días, mensaje con oferta, plantilla, perdido).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
const sendOutboundMock = vi.fn();
const sendTemplateMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));
vi.mock("../../src/followup/send", () => ({ sendOutbound: (...a: unknown[]) => sendOutboundMock(...a) }));
vi.mock("../../src/channels/ycloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/channels/ycloud")>();
  return { ...actual, sendYCloudTemplate: (...a: unknown[]) => sendTemplateMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { SettingsRepo } from "../../src/db/settings";
import {
  cargarReactivacion, faseDe, leerBorradorReactiva, prepararMensaje, enviarReactivacion, pasarAPerdido, omitir, telefonoInternacional,
  renderReactivacion, fragmentoPreparar, runReactivacionMasiva,
} from "../../member/crm-reactivacion.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 20, 10, 0); // martes 20 oct 2026, 12:00 en España
const DIA = 86_400_000;
const LEAD_A = "2259602000011111111"; // 50 días: toca
const LEAD_B = "2259602000022222222"; // 10 días: aún no
const LEAD_C = "2259602000033333333"; // 70 días: tarde
const cands: Record<string, Record<string, unknown>> = {
  [LEAD_A]: { id: LEAD_A, Full_Name: "Ana Pérez", Mobile: "+34 600 000 001", Email: "ana@c.com", Country: "España", Lead_Status: "Revisar en el futuro" },
  [LEAD_B]: { id: LEAD_B, Full_Name: "Beto Ruiz", Mobile: "+34600000002", Country: "España", Lead_Status: "Revisar en el futuro" },
  [LEAD_C]: { id: LEAD_C, Full_Name: "Cami Gómez", Mobile: "3001234567", Country: "Colombia", Lead_Status: "Revisar en el futuro" },
};
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const escrituras: Array<{ url: string; method: string; body: Record<string, any> }> = [];
let transiciones: Array<{ id: string; name: string; fields: unknown[] }> = [];
let leadsEnEstado: Array<Record<string, unknown>> = [];
let kbMatches: Array<{ score: number; metadata: Record<string, string> }> = [];

const zoho = vi.fn(async (url: string, init?: RequestInit) => {
  const metodo = init?.method ?? "GET";
  if (url.includes("/oauth/v2/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/users?type=CurrentUser")) return json({ users: [{ id: "555", full_name: "Maricela Naranjo" }] });
  if (/\/Leads\/\d+\?fields=Owner/.test(url)) return json({ data: [{ Owner: { id: "555", name: "Maricela Naranjo" } }] });
  if (metodo === "GET" && url.includes("/actions/blueprint")) return json({ blueprint: { transitions: transiciones } });
  if ((metodo === "POST" || metodo === "PUT") && url.includes("/crm/v6/") && !url.endsWith("/coql")) {
    const cuerpo = JSON.parse(String(init?.body)) as { data?: Array<Record<string, any>>; blueprint?: Array<Record<string, any>> };
    escrituras.push({ url, method: metodo, body: (cuerpo.data?.[0] ?? cuerpo.blueprint?.[0]) as Record<string, any> });
    return json({ data: [{ status: "success", details: { id: "9990001" } }] });
  }
  if (url.endsWith("/coql") && String(JSON.parse(String(init?.body)).select_query).includes("from Leads")) {
    return json({ data: leadsEnEstado });
  }
  if (url.endsWith("/coql")) {
    const t = (id: string, lead: string, diasAtras: number, vence: string) => ({ id, Due_Date: vence, Created_Time: iso(NOW - diasAtras * DIA), What_Id: { id: lead }, Who_Id: null, $se_module: "Leads" });
    return json({ data: [t("2259602000044440001", LEAD_A, 50, "2026-12-09"), t("2259602000044440002", LEAD_B, 10, "2027-01-18"), t("2259602000044440003", LEAD_C, 70, "2026-11-18")] });
  }
  if (url.includes("/crm/v6/Leads?ids=")) {
    const ids = new URL(url).searchParams.get("ids")!.split(",");
    return json({ data: ids.map((i) => cands[i]).filter(Boolean) });
  }
  if (url.includes("/Notes")) return json({ data: [{ Note_Title: "Llamada", Note_Content: "Quiere comprar en Pereira, ahorro 20 mil euros. Tel 600000001", Created_Time: "2026-08-30T10:00:00+02:00" }] });
  return json({ message: "no existe" }, 404);
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = {
    DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "sec", ZOHO_REFRESH_TOKEN: "ref",
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    KB: { query: async () => ({ matches: kbMatches }) },
  } as unknown as Env;
  escrituras.length = 0;
  leadsEnEstado = [
    { id: LEAD_A, First_Name: "Ana", Last_Name: "Pérez", Mobile: "+34 600 000 001", Email: "ana@c.com", Lead_Status: "Revisar en el futuro", Created_Time: "2021-06-19T19:10:06+02:00" },
    { id: LEAD_B, First_Name: "Beto", Last_Name: "Ruiz", Mobile: "+34600000002", Lead_Status: "Revisar en el futuro", Created_Time: "2022-06-19T19:10:06+02:00" },
    { id: LEAD_C, First_Name: "Cami", Last_Name: "Gómez", Mobile: "3001234567", Lead_Status: "Revisar en el futuro", Created_Time: "2023-06-19T19:10:06+02:00" },
    { id: "2259602000055555555", First_Name: "Sin", Last_Name: "Telefono", Mobile: "123", Lead_Status: "Revisar en el futuro", Created_Time: "2023-06-19T19:10:06+02:00" },
  ];
  transiciones = [{ id: "2259602001737850663", name: "Cliente perdido", fields: [{ api_name: "motivo", criteria: { value: ["Dejó de responder", "Nunca me respondió"] } }] }];
  kbMatches = [{ score: 0.8, metadata: { title: "Proyecto Pereira Centro", content: "Apartamentos en Pereira, entrega inmediata, descuento del 5% en cuota inicial durante noviembre." } }];
  sendOutboundMock.mockReset().mockResolvedValue(undefined);
  sendTemplateMock.mockReset().mockResolvedValue(undefined);
  generarMock.mockReset().mockResolvedValue({ text: '{"mensaje":"Hola [nombre], vimos que buscabas en Pereira. Hay apartamentos con entrega inmediata y 5% de descuento en la cuota inicial en noviembre. ¿Te envío la información?","oferta":"Pereira Centro: entrega inmediata y 5% de descuento","ciudad":"Pereira"}' });
  zoho.mockClear();
  await new SettingsRepo(db).set("zoho_escritura", "activo");
});

describe("fases y teléfonos", () => {
  it("fase según los días desde que quedó para después", () => {
    expect(faseDe(44)).toBe("pronto");
    expect(faseDe(45)).toBe("toca");
    expect(faseDe(60)).toBe("toca");
    expect(faseDe(61)).toBe("tarde");
  });
  it("teléfono con prefijo de país", () => {
    expect(telefonoInternacional("+34 600 000 001", "", "España")).toBe("34600000001");
    expect(telefonoInternacional("600000001", "", "España")).toBe("34600000001");
    expect(telefonoInternacional("3001234567", "", "Colombia")).toBe("573001234567");
    expect(telefonoInternacional("12345", "", "")).toBeNull();
    expect(telefonoInternacional("0034600000001", "", "")).toBe("34600000001");
  });
  it("lee el JSON de la IA y rellena el nombre", () => {
    const b = leerBorradorReactiva('{"mensaje":"Hola [nombre], novedades","oferta":"x","ciudad":"Cali"}', "Ana Pérez")!;
    expect(b.mensaje).toBe("Hola Ana, novedades");
    expect(leerBorradorReactiva('{"mensaje":""}', "Ana")).toBeNull();
  });
});

describe("lista de reactivación", () => {
  it("toma las tareas «Retomar cliente a futuro», calcula los días y la fase", async () => {
    const f = await cargarReactivacion(env, NOW, zoho);
    expect(f.map((x) => [x.cand.nombre, x.dias, x.fase])).toEqual([["Cami Gómez", 70, "tarde"], ["Ana Pérez", 50, "toca"], ["Beto Ruiz", 10, "pronto"]]);
    const html = await renderReactivacion(env, NOW, zoho);
    expect(html).toContain("Toca escribirle");
    expect(html).toContain("faltan 35 días");
  });
  it("no incluye a quien ya salió de «Revisar en el futuro»", async () => {
    cands[LEAD_B] = { ...cands[LEAD_B]!, Lead_Status: "Cliente perdido" };
    const f = await cargarReactivacion(env, NOW, zoho);
    cands[LEAD_B] = { ...cands[LEAD_B]!, Lead_Status: "Revisar en el futuro" };
    expect(f.map((x) => x.cand.nombre)).not.toContain("Beto Ruiz");
  });
});

describe("mensaje y envío", () => {
  it("prepara el mensaje con la oferta del catálogo, lo guarda y no gasta IA otra vez", async () => {
    const r = await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    expect(r.ok && r.borrador.mensaje).toContain("Pereira");
    const prompt = (generarMock.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("Proyecto Pereira Centro");
    expect(prompt).not.toContain("Ana Pérez");
    expect(prompt).not.toContain("600000001"); // teléfono del texto de la nota, anonimizado
    const otra = await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    expect(otra.ok && otra.reutilizado).toBe(true);
    expect(generarMock).toHaveBeenCalledTimes(1);
  });

  it("fuera de las 24 h sin plantilla configurada no envía y lo explica", async () => {
    await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    const r = await enviarReactivacion(env, LEAD_A, "", { f: zoho }, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("plantilla");
    expect(sendTemplateMock).not.toHaveBeenCalled();
    expect(sendOutboundMock).not.toHaveBeenCalled();
  });

  it("con plantilla: la envía, deja la oferta como nota interna del bot, guarda la nota en Zoho y no se repite", async () => {
    await new SettingsRepo(db).set("viventa_tpl_reactivacion", "viventa_reactivacion_v1");
    await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    const r = await enviarReactivacion(env, LEAD_A, "", { f: zoho }, NOW);
    expect(r).toMatchObject({ ok: true, via: "plantilla" });
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    expect(sendTemplateMock.mock.calls[0]![1]).toBe("34600000001");
    expect(sendTemplateMock.mock.calls[0]![2]).toBe("viventa_reactivacion_v1");
    expect(sendTemplateMock.mock.calls[0]![4]).toEqual(["Ana"]);
    const nota = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = 'ycloud:34600000001' AND role = 'note'");
    expect(nota?.content).toContain("Pereira Centro: entrega inmediata y 5% de descuento");
    expect(escrituras.some((e) => e.url.endsWith(`/Leads/${LEAD_A}/Notes`) && String(e.body["Note_Content"]).includes("Reactivación por WhatsApp"))).toBe(true);
    const otra = await enviarReactivacion(env, LEAD_A, "", { f: zoho }, NOW + 1000);
    expect(otra.ok).toBe(false);
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    // ahora figura como escrito
    expect((await cargarReactivacion(env, NOW + 1000, zoho)).find((x) => x.leadId === LEAD_A)!.envio).toBe("escrito");
  });

  it("dentro de la ventana de 24 h manda el texto libre (editado por Maricela)", async () => {
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000001", "ycloud", "34600000001", "Ana", NOW - 5 * DIA, NOW - 3600_000]);
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", ["m1", "ycloud:34600000001", "user", "hola", NOW - 3600_000]);
    await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    const r = await enviarReactivacion(env, LEAD_A, "Hola Ana, mensaje editado", { f: zoho }, NOW);
    expect(r).toMatchObject({ ok: true, via: "libre" });
    expect(sendOutboundMock.mock.calls[0]![1].text).toBe("Hola Ana, mensaje editado");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("de madrugada del cliente no envía", async () => {
    await new SettingsRepo(db).set("viventa_tpl_reactivacion", "plantilla");
    await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    const noche = Date.UTC(2026, 9, 20, 1, 0); // 03:00 en Madrid
    const r = await enviarReactivacion(env, LEAD_A, "", { f: zoho }, noche);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("madrugada");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("no escribe a quien ya salió de «Revisar en el futuro»", async () => {
    await prepararMensaje(env, LEAD_A, { f: zoho }, NOW);
    cands[LEAD_A] = { ...cands[LEAD_A]!, Lead_Status: "Contactado" };
    const r = await enviarReactivacion(env, LEAD_A, "", { f: zoho }, NOW);
    cands[LEAD_A] = { ...cands[LEAD_A]!, Lead_Status: "Revisar en el futuro" };
    expect(r.ok).toBe(false);
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });
});

describe("sin respuesta → perdido u omitir", () => {
  it("pasa a «Cliente perdido» por la transición con el motivo y cierra la tarea; luego sale de la lista", async () => {
    const r = await pasarAPerdido(env, LEAD_C, { f: zoho }, NOW);
    expect(r).toEqual({ ok: true, manual: false });
    const blueprint = escrituras.find((e) => e.url.includes("/actions/blueprint"))!;
    expect(blueprint.body).toMatchObject({ transition_id: "2259602001737850663", data: { motivo: "Nunca me respondió" } });
    expect(escrituras.some((e) => e.url.endsWith("/Tasks/2259602000044440003") && e.body["Status"] === "Completa")).toBe(true);
    expect((await cargarReactivacion(env, NOW, zoho)).find((x) => x.leadId === LEAD_C)!.envio).toBe("perdido");
  });
  it("si Zoho no ofrece la transición, avisa que el paso final es manual", async () => {
    transiciones = [];
    expect(await pasarAPerdido(env, LEAD_C, { f: zoho }, NOW)).toEqual({ ok: true, manual: true });
  });
  it("con la escritura apagada no toca Zoho", async () => {
    await new SettingsRepo(db).set("zoho_escritura", "");
    expect((await pasarAPerdido(env, LEAD_C, { f: zoho }, NOW)).ok).toBe(false);
    expect(escrituras).toHaveLength(0);
  });
  it("omitir saca al cliente de la lista sin tocar Zoho", async () => {
    await omitir(env, LEAD_B, NOW);
    expect((await cargarReactivacion(env, NOW, zoho)).find((x) => x.leadId === LEAD_B)!.envio).toBe("omitido");
    expect(escrituras).toHaveLength(0);
  });
  it("la tarjeta del borrador trae el botón de enviar y avisa si falta la plantilla", async () => {
    const html = await fragmentoPreparar(env, LEAD_A, false, NOW, zoho);
    expect(html).toContain("Enviar por WhatsApp");
    expect(html).toContain("NO está configurada");
  });
});

describe("envío masivo con el mensaje de Maricela", () => {
  const HORA = Date.UTC(2026, 9, 20, 16, 0); // 18:00 en Madrid, 11:00 en Bogotá
  const TEXTO = "Hola 😊 ¿Cómo estás?\n\nSé que habíamos dejado tu proyecto...\n\n🔗 https://vivehome.viventa.co/quota-information?id=2387";
  async function configurar(activo = true) {
    const st = new SettingsRepo(db);
    await st.set("viventa_tpl_reactivacion", "viventa_reactivacion_futuro");
    await st.set("viventa_tpl_reactivacion_texto", TEXTO);
    if (activo) await st.set("viventa_reactivacion_masiva", "activo");
  }
  it("apagado por defecto: no envía nada", async () => {
    await configurar(false);
    expect(await runReactivacionMasiva(env, HORA, zoho)).toEqual({ sent: 0, omitidos: 0, fallos: 0 });
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });
  it("sin plantilla configurada no envía aunque esté activo", async () => {
    await new SettingsRepo(db).set("viventa_reactivacion_masiva", "activo");
    expect((await runReactivacionMasiva(env, HORA, zoho)).sent).toBe(0);
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });
  it("envía a todos los que están en «Revisar en el futuro» por la plantilla SIN variables, una sola vez, y omite el teléfono corto", async () => {
    await configurar();
    const r = await runReactivacionMasiva(env, HORA, zoho);
    expect(r.sent).toBe(3);
    expect(r.omitidos).toBe(1);
    expect(sendTemplateMock).toHaveBeenCalledTimes(3);
    const llamadas = sendTemplateMock.mock.calls.map((c) => [c[1], c[2], c[4]]);
    expect(llamadas).toContainEqual(["34600000001", "viventa_reactivacion_futuro", []]);
    expect(llamadas).toContainEqual(["573001234567", "viventa_reactivacion_futuro", []]);
    // el bot queda con el contexto para cuando respondan
    const nota = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = 'ycloud:34600000001' AND role = 'note'");
    expect(nota?.content).toContain("texto de Maricela");
    expect(nota?.content).toContain("Bogotá");
    // segunda pasada: no repite
    const otra = await runReactivacionMasiva(env, HORA + 15 * 60_000, zoho);
    expect(otra.sent).toBe(0);
    expect(sendTemplateMock).toHaveBeenCalledTimes(3);
    // y los ya escritos aparecen en la lista de reactivación aunque no tengan tarea
    const lista = await cargarReactivacion(env, HORA + 60_000, zoho);
    expect(lista.filter((x) => x.envio === "escrito").length).toBe(3);
  });
  it("respeta el horario del cliente y el tope por pasada", async () => {
    await configurar();
    const madrugada = Date.UTC(2026, 9, 20, 1, 0); // 03:00 en Madrid, 20:00 del día anterior en Bogotá
    const r = await runReactivacionMasiva(env, madrugada, zoho);
    expect(r.sent).toBe(1); // solo el de Colombia (+57) es hora de escribir
    expect(sendTemplateMock.mock.calls[0]![1]).toBe("573001234567");
    leadsEnEstado = Array.from({ length: 12 }, (_, i) => ({ id: `22596020000600000${String(i).padStart(2, "0")}`, First_Name: "N", Last_Name: String(i), Mobile: `+346000001${String(i).padStart(2, "0")}`, Lead_Status: "Revisar en el futuro", Created_Time: "2021-06-19T19:10:06+02:00" }));
    sendTemplateMock.mockClear();
    expect((await runReactivacionMasiva(env, HORA, zoho)).sent).toBe(8);
  });
  it("si la plantilla falla (no aprobada) no marca como enviado y corta tras 2 fallos seguidos", async () => {
    await configurar();
    sendTemplateMock.mockRejectedValue(new Error("ycloud template 400: template not approved"));
    const r = await runReactivacionMasiva(env, HORA, zoho);
    expect(r.sent).toBe(0);
    expect(r.fallos).toBe(2);
    sendTemplateMock.mockReset().mockResolvedValue(undefined);
    expect((await runReactivacionMasiva(env, HORA + 900_000, zoho)).sent).toBe(3); // reintenta cuando ya se puede
  });

  it("con la llave de YCloud, espera a que Meta apruebe la plantilla y arranca sola al aprobarse", async () => {
    await configurar();
    (env as any).YCLOUD_API_KEY = "k";
    (env as any).YCLOUD_WA_FROM = "+34611688609";
    let estado = "PENDING";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/phoneNumbers")) return json({ items: [{ phoneNumber: "+34611688609", wabaId: "w1" }] });
      return json({ items: [{ name: "viventa_reactivacion_futuro", status: estado }] });
    }));
    try {
      expect((await runReactivacionMasiva(env, HORA, zoho)).sent).toBe(0);
      expect(sendTemplateMock).not.toHaveBeenCalled();
      estado = "APPROVED";
      expect((await runReactivacionMasiva(env, HORA + 900_000, zoho)).sent).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
