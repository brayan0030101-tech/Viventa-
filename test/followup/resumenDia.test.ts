/**
 * Resumen diario de Maricela: puntuación de leads, texto, CSV para Zoho y cron (1 vez al día).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import {
  parseMonto, parseEuros, evaluarCalificacion, puntuarLead, armarLeads, csvZoho, mensajesResumen, urlFormulario, runResumenDia, comandoEquipo, enlaceRegistro, AYUDA_EQUIPO, faltantes, runExcelListos, leadsListos, correoParaFormulario, lineaLlamadas,
} from "../../src/followup/resumenDia";
import type { Env } from "../../src/env";

describe("parseMonto", () => {
  it.each([
    ["15 mil euros", 15000],
    ["10.000", 10000],
    ["8000€", 8000],
    ["5k", 5000],
    ["20 millones de pesos", 4444],
    ["500 al mes", 500],
    ["12 meses", 12],
    ["nada", 0],
    [undefined, 0],
  ])("%s → %s", (txt, esperado) => {
    expect(parseMonto(txt as string)).toBe(esperado);
  });
});

describe("calificación (reunión Maricela–Brayan, 21 oct 2026)", () => {
  const ficha = (m: Record<string, string>) => ({ metadata: m, notas: "", telefono: "" });
  const caliente = { tipoEmpleo: "Empleado", ingresosMensuales: "1500 euros", capacidadMensual: "400 euros", reportadoDatacredito: "No" };
  it("caliente: empleado, ingresos ≥ 1.500 €, cuota ≥ 400 € y no reportado", () => {
    const p = puntuarLead(ficha(caliente));
    expect(p.nivel).toBe("caliente");
    expect(p.razones.join(" ")).toContain("Perfil caliente");
  });
  it("la cuota en pesos cuenta (1,5 millones ≈ 400 €; «un millón quinientos»)", () => {
    expect(puntuarLead(ficha({ ...caliente, capacidadMensual: "1.500.000" })).nivel).toBe("caliente");
    expect(puntuarLead(ficha({ ...caliente, capacidadMensual: "un millón quinientos" })).nivel).toBe("caliente");
    expect(parseEuros("1 millón")).toBe(270);
  });
  it("tibio: ingresos ≥ 1.300 € y cuota ≥ 300 € pero no cumple lo de caliente", () => {
    expect(puntuarLead(ficha({ ...caliente, capacidadMensual: "350 euros" })).nivel).toBe("tibio");
    expect(puntuarLead(ficha({ ...caliente, ingresosMensuales: "1400 euros" })).nivel).toBe("tibio");
    expect(puntuarLead(ficha({ ...caliente, tipoEmpleo: "Autónomo" })).nivel).toBe("tibio");
  });
  it("frío: destina menos de 300 € (≈ 1 millón de pesos) o gana menos de 1.300 €", () => {
    expect(puntuarLead(ficha({ ...caliente, capacidadMensual: "150 euros" })).nivel).toBe("frio");
    expect(puntuarLead(ficha({ ...caliente, capacidadMensual: "800.000" })).nivel).toBe("frio");
    expect(puntuarLead(ficha({ ...caliente, ingresosMensuales: "1200 euros" })).nivel).toBe("frio");
  });
  it("compra con otra persona: se suman los ingresos de las dos personas", () => {
    const sola = { tipoEmpleo: "Empleado", ingresosMensuales: "900 euros", capacidadMensual: "450 euros", reportadoDatacredito: "No" };
    expect(puntuarLead(ficha(sola)).nivel).toBe("frio");
    expect(puntuarLead(ficha({ ...sola, compraSoloOAcompanado: "Con mi esposo", ingresosCoComprador: "1000 euros" })).nivel).toBe("caliente");
  });
  it("reportado en Datacrédito: nunca caliente; si no puede ponerse al día es frío, si lo hará pronto es tibio", () => {
    expect(puntuarLead(ficha({ ...caliente, reportadoDatacredito: "Sí" })).nivel).toBe("tibio");
    expect(puntuarLead(ficha({ ...caliente, reportadoDatacredito: "Sí", puedeQuitarReporte: "No, es una deuda grande" })).nivel).toBe("frio");
    expect(puntuarLead(ficha({ ...caliente, reportadoDatacredito: "Sí", puedeQuitarReporte: "Sí, lo pago pronto" })).nivel).toBe("tibio");
  });
  it("quien tiene ahorros no queda frío por cuota baja (caso María José, 26 oct 2026)", () => {
    const c = evaluarCalificacion({ ...caliente, ahorroDisponible: "3.000.000 COP", capacidadMensual: "800.000 COP" });
    expect(c.nivel).toBe("tibio");
    expect(c.motivo).toContain("ahorros");
    expect(evaluarCalificacion({ ...caliente, ahorroDisponible: "no tengo", capacidadMensual: "800.000 COP" }).nivel).toBe("frio");
  });
  it("ingresos de 2.000 € o más = caliente aunque destine solo 800.000 COP al mes (caso María José)", () => {
    const c = evaluarCalificacion({ ciudadResidencia: "España", ciudadCompra: "Ibagué", entregaInmediataOFutura: "Futuro", ahorroDisponible: "3.000.000 COP", capacidadMensual: "800.000 COP", tipoEmpleo: "Empleada", ingresosMensuales: "2.300€ a 2.500€", compraSoloOAcompanado: "Con su pareja" });
    expect(c.nivel).toBe("caliente");
    expect(c.motivo).toContain("2.000");
  });
  it("con 2.000 € de ingresos, reportado queda tibio y reportado sin plan sigue frío", () => {
    expect(evaluarCalificacion({ ...caliente, ingresosMensuales: "2500 euros", capacidadMensual: "200 euros", reportadoDatacredito: "Sí", puedeQuitarReporte: "Sí, pronto" }).nivel).toBe("tibio");
    expect(evaluarCalificacion({ ...caliente, ingresosMensuales: "2500 euros", reportadoDatacredito: "Sí", puedeQuitarReporte: "No" }).nivel).toBe("frio");
  });
  it("con ahorros, reportado sin plan de ponerse al día sigue siendo frío", () => {
    expect(evaluarCalificacion({ ...caliente, ahorroDisponible: "5000 euros", reportadoDatacredito: "Sí", puedeQuitarReporte: "No" }).nivel).toBe("frio");
  });
  it("evaluarCalificacion dice qué preguntas faltan", () => {
    const c = evaluarCalificacion({ ...caliente });
    expect(c.completo).toBe(false);
    expect(c.faltan).toContain("compraSoloOAcompanado");
    expect(c.faltan).not.toContain("reportadoDatacredito");
  });
});

describe("puntuarLead", () => {
  it("ahorro alto, cuota y entrega inmediata = caliente", () => {
    const p = puntuarLead({
      telefono: "+34600000001",
      notas: "Hora de llamada pedida: 18:00",
      metadata: { ahorroDisponible: "20 mil euros", ingresosMensuales: "2000", capacidadMensual: "1000", tipoEmpleo: "contrato indefinido", entregaInmediataOFutura: "ahora", ciudadResidencia: "a", ciudadCompra: "b" },
    });
    expect(p.nivel).toBe("caliente");
  });
  it("casi sin datos = frío", () => {
    expect(puntuarLead({ telefono: "", notas: "", metadata: {} }).nivel).toBe("frio");
  });
});

const conv = { id: "ycloud:34600000001", channel: "ycloud", channel_user_id: "34600000001", display_name: "Ana", last_message_at: 1 };
const lead = (extra: object = {}) => ({
  conversation_id: conv.id, name: "Ana López Ruiz", contact: "ana@correo.com", notes: "Autorizo: si", intent: "x",
  metadata: JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "Bogotá", ahorroDisponible: "10.000" }), ...extra,
});

describe("armarLeads / csvZoho / textoResumen", () => {
  it("separa teléfono (canal) y correo, y arma el CSV de Zoho", () => {
    const [l] = armarLeads([conv], [lead()]);
    expect(l.telefono).toBe("+34600000001");
    expect(l.correo).toBe("ana@correo.com");
    const csv = csvZoho([l]);
    expect(csv.startsWith("﻿First Name,Last Name,Email,Phone")).toBe(true);
    expect(csv).toContain("Ana,López Ruiz,ana@correo.com,+34600000001,WhatsApp,España,Girona");
    expect(csv).toContain("Quiere comprar en: Bogotá");
  });
  it("un solo nombre va a Last Name (Zoho lo exige)", () => {
    const [l] = armarLeads([conv], [lead({ name: "Ana" })]);
    expect(csvZoho([l]).split("\r\n")[1].startsWith(",Ana,")).toBe(true);
  });
  it("el resumen ordena calientes primero y marca los sin teléfono", () => {
    const ig = { id: "zernio:1", channel: "zernio", channel_user_id: "1", display_name: "Luis", last_message_at: 1 };
    const ls = armarLeads([ig, conv], [lead({ conversation_id: "zernio:1", name: "Luis", contact: "" }), lead()]);
    const txt = mensajesResumen(ls, "https://x/admin").join("\n");
    expect(txt).toContain("SIN TELÉFONO");
    expect(txt).toContain("https://x/admin");
  });
});

describe("formulario prellenado", () => {
  const base = "https://forms.example/f";
  it("rellena nombre, correo, teléfono, ciudad de interés, país y ciudad de residencia", () => {
    const [l] = armarLeads([conv], [lead({ metadata: JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "medellin (Robledo)" }) })]);
    const u = new URL(urlFormulario(base, l));
    expect(u.searchParams.get("Name_First")).toBe("Ana");
    expect(u.searchParams.get("Name_Last")).toBe("López Ruiz");
    expect(u.searchParams.get("Email")).toBe("ana@correo.com");
    expect(u.searchParams.get("PhoneNumber")).toBe("+34600000001");
    expect(u.searchParams.get("Dropdown")).toBe("Medellín");
    expect(u.searchParams.get("Dropdown1")).toBe("España");
    expect(u.searchParams.get("SingleLine")).toBe("Girona");
  });
  it("país o ciudad fuera de las opciones del formulario se dejan en blanco", () => {
    const [l] = armarLeads([conv], [lead({ metadata: JSON.stringify({ ciudadResidencia: "Colombia, Chaparral", ciudadCompra: "Ibagué" }) })]);
    const u = new URL(urlFormulario(base, l));
    expect(u.searchParams.has("Dropdown")).toBe(false);
    expect(u.searchParams.has("Dropdown1")).toBe(false);
  });
  it("el resumen incluye el enlace y se parte en mensajes cortos", () => {
    const muchos: ReturnType<typeof armarLeads> = [];
    for (let i = 0; i < 15; i++) {
      const c = { ...conv, id: `ycloud:3460000${i}`, channel_user_id: `3460000${i}` };
      muchos.push(...armarLeads([c], [lead({ conversation_id: c.id })]));
    }
    const ms = mensajesResumen(muchos, "https://x/admin", base);
    expect(ms.length).toBeGreaterThan(1);
    expect(ms.every((m) => m.length <= 4096)).toBe(true);
    expect(ms.join("\n")).toContain("https://forms.example/f?");
  });
});

describe("runResumenDia", () => {
  let env: Env;
  let db: Db;
  const fetchMock = vi.fn();
  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    db = new Db(d1);
    env = { DB: d1, TELEGRAM_BOT_TOKEN: "T", CAMILA_TELEGRAM_CHAT_ID: "1,2", BUSINESS_NAME: "Viventa" } as unknown as Env;
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 9, 20, 6, 30); // 08:30 en Madrid
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [conv.id, "ycloud", "34600000001", "Ana", now - 1000, now - 1000]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, notes, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ["l1", conv.id, "Ana López Ruiz", "ana@correo.com", "compra", "Autorizo: si", lead().metadata, "new", now - 2000, now - 2000]);
  });
  afterEach(() => vi.unstubAllGlobals());
  const A_LAS_8 = Date.UTC(2026, 9, 20, 6, 30);

  it("lineaLlamadas cuenta las llamadas del bot y las que pasaron por comodín", async () => {
    const now = A_LAS_8;
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES ('c1',?,?,?,?,?,?,?,?)",
      [conv.id, "Ana", "", "Cita · Videollamada Viventa · 2026-10-22 11:00", JSON.stringify({ estado: "Reservada (Cal.com)" }), "new", now - 1000, now - 1000]);
    await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES ('t1',?,?,?,?,?,?)",
      [conv.id, "otro", "Cliente pide otro horario para la llamada", "", "open", now - 2000]);
    const t = await lineaLlamadas(db, now);
    expect(t).toContain("el bot agendó 1 (pasó a Maricela por otro horario: 1)");
    expect(t).toContain("7 días: 1 agendadas, 1 por comodín");
  });

  it("manda el resumen y el CSV a los dos, una sola vez al día", async () => {
    const r = await runResumenDia(env, A_LAS_8);
    expect(r).toEqual({ sent: true, leads: 1 });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith("/sendMessage")).length).toBe(2);
    expect(urls.filter((u) => u.endsWith("/sendDocument")).length).toBe(0); // CSV opcional, apagado
    expect((await runResumenDia(env, A_LAS_8 + 10 * 60_000)).sent).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
  it("fuera de las 8 h de España no hace nada", async () => {
    expect((await runResumenDia(env, Date.UTC(2026, 9, 20, 12, 0))).sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("con viventa_csv_activo=1 manda el CSV a los dos", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_csv_activo','1',1)");
    await runResumenDia(env, A_LAS_8);
    expect(fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.endsWith("/sendDocument")).length).toBe(2);
  });
  it("con viventa_form_url el resumen lleva el enlace del formulario", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_form_url','https://forms.example/f',1)");
    await runResumenDia(env, A_LAS_8);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("https://forms.example/f?Name_First=Ana");
  });
  it("al día siguiente no repite un lead ya exportado al CSV", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_csv_activo','1',1)");
    await runResumenDia(env, A_LAS_8);
    fetchMock.mockClear();
    const manana = A_LAS_8 + 24 * 3600_000;
    await db.run("UPDATE conversations SET last_message_at = ?", [manana - 1000]);
    await db.run("UPDATE leads SET updated_at = ?", [manana - 1000]);
    await runResumenDia(env, manana);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith("/sendDocument")).length).toBe(0);
    expect(urls.filter((u) => u.endsWith("/sendMessage")).length).toBe(2);
  });
});

describe("registro por el equipo", () => {
  let env: Env;
  let db: Db;
  const NOW = Date.UTC(2026, 9, 20, 6, 30);
  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    db = new Db(d1);
    env = { DB: d1, TELEGRAM_BOT_TOKEN: "T", CAMILA_TELEGRAM_CHAT_ID: "1", BUSINESS_NAME: "Viventa" } as unknown as Env;
    for (const [id, user, name] of [["ycloud:34600000001", "34600000001", "Ana López Ruiz"], ["ycloud:34600000002", "34600000002", "Ana Gómez"], ["ycloud:34600000003", "34600000003", "Luis Pérez"]]) {
      await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", user, name, NOW - 5000, NOW - 5000]);
      await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, notes, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [`l-${id}`, id, name, `${user}@correo.com`, "compra", "", JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "Cali" }), "new", NOW - 4000, NOW - 4000]);
      await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES (?,?,?,?,?,?,?)",
        [`t-${id}`, id, "other", "[Lead calificado: enviar proyectos] x", "", "open", NOW - 3000]);
    }
  });

  it("pendientes lista los calificados sin registrar", async () => {
    const r = await comandoEquipo(env, "pendientes", NOW);
    expect(r).toContain("Faltan por registrar (3)");
    expect(r).toContain("Luis Pérez");
  });
  it("registrado <nombre> lo marca y sale de pendientes", async () => {
    expect(await comandoEquipo(env, "registrado Luis", NOW)).toContain("✅");
    const r = await comandoEquipo(env, "pendientes", NOW);
    expect(r).toContain("(2)");
    expect(r).not.toContain("Luis");
  });
  it("si hay varias coincidencias pide el nombre completo", async () => {
    expect(await comandoEquipo(env, "registrado Ana", NOW)).toContain("Hay varios");
    expect(await comandoEquipo(env, "registrado Ana Gómez", NOW)).toContain("✅");
  });
  it("sin coincidencia lo dice, y cualquier otro texto da la ayuda", async () => {
    expect(await comandoEquipo(env, "registrado Pedro", NOW)).toContain("No encuentro");
    expect(await comandoEquipo(env, "hola", NOW)).toBe(AYUDA_EQUIPO);
  });
  it("el resumen de la mañana no incluye a los ya registrados", async () => {
    await comandoEquipo(env, "registrado Luis", NOW);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await db.run("UPDATE conversations SET last_message_at = ?", [NOW - 1000]);
    await db.run("UPDATE leads SET updated_at = ?", [NOW - 1000]);
    await runResumenDia(env, NOW);
    const texto = JSON.parse(fetchMock.mock.calls[0][1].body as string).text as string;
    expect(texto).toContain("2 lead(s)");
    expect(texto).not.toContain("Luis");
    vi.unstubAllGlobals();
  });
  it("enlaceRegistro devuelve el formulario rellenado, o vacío sin configurar", async () => {
    expect(await enlaceRegistro(env, db, "ycloud:34600000003")).toBe("");
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_form_url','https://forms.example/f',1)");
    const e = await enlaceRegistro(env, db, "ycloud:34600000003");
    expect(e).toContain("https://forms.example/f?");
    expect(e).toContain("✅ Listo para registrar");
    expect(e).toContain("Dropdown=Cali");
    expect(await enlaceRegistro(env, db, null)).toBe("");
  });
});

describe("datos que exige el formulario", () => {
  it("lista lo que falta", () => {
    const [l] = armarLeads([conv], [lead({ name: "Ana", contact: "", metadata: JSON.stringify({ ciudadResidencia: "España" }) })]);
    expect(faltantes({ ...l, telefono: "", correo: "" })).toEqual(["apellido", "teléfono", "ciudad donde quiere comprar", "ciudad donde vive"]);
  });
  it("completo = nada falta", () => {
    const [l] = armarLeads([conv], [lead({ metadata: JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "Cali" }) })]);
    expect(faltantes(l)).toEqual([]);
  });
});

describe("existente", () => {
  it("marca como ya existente y deja de salir en pendientes", async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    const db = new Db(d1);
    const env = { DB: d1 } as unknown as Env;
    const NOW = Date.UTC(2026, 9, 20, 6, 30);
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:1", "ycloud", "1", "Pepe Mora", 1, 1]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, status, created_at, updated_at) VALUES ('l','ycloud:1','Pepe Mora','','x','new',1,1)");
    await db.run("INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES ('t','ycloud:1','other','[Lead calificado] x','','open',?)", [NOW - 1000]);
    expect(await comandoEquipo(env, "existente Pepe", NOW)).toContain("🔴");
    expect(await comandoEquipo(env, "pendientes", NOW)).toContain("No hay pendientes");
  });
});

describe("Excel de clientes listos (6:00 y 14:00)", () => {
  let env: Env;
  let db: Db;
  const fetchMock = vi.fn();
  const A_LAS_6 = Date.UTC(2026, 9, 20, 4, 5); // 06:05 en Madrid
  const A_LAS_14 = Date.UTC(2026, 9, 20, 12, 5); // 14:05 en Madrid
  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    db = new Db(d1);
    env = { DB: d1, TELEGRAM_BOT_TOKEN: "T", CAMILA_TELEGRAM_CHAT_ID: "1,2", BUSINESS_NAME: "Viventa" } as unknown as Env;
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_form_url','https://forms.example/f',1)");
    const completo = JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "Cali" });
    const filas: Array<[string, string, string, string, string]> = [
      ["ycloud:34600000021", "34600000021", "Ana López", "ana@x.com", completo], // listo
      ["ycloud:34600000022", "34600000022", "Luis", "luis@x.com", completo], // sin apellido
      ["ycloud:34600000023", "34600000023", "Eva Gil", "eva@x.com", completo], // ya registrada
    ];
    for (const [id, user, name, mail, meta] of filas) {
      await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", user, name, A_LAS_6 - 5000, A_LAS_6 - 5000]);
      await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [`l-${id}`, id, name, mail, "x", meta, "new", A_LAS_6 - 4000, A_LAS_6 - 4000]);
    }
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viventa_registrado','x') WHERE id = 'ycloud:34600000023'");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("solo incluye a los completos, sin registrar y sin Excel previo", async () => {
    const l = await leadsListos(db, A_LAS_6);
    expect(l.map((x) => x.nombre)).toEqual(["Ana López"]);
  });
  it("a las 6:00 manda el .xlsx a los dos y no lo repite en la misma franja", async () => {
    const r = await runExcelListos(env, A_LAS_6);
    expect(r).toEqual({ sent: true, leads: 1 });
    const docs = fetchMock.mock.calls.filter((c) => (c[0] as string).endsWith("/sendDocument"));
    expect(docs.length).toBe(2);
    const form = docs[0][1].body as FormData;
    expect((form.get("document") as unknown as File).name).toBe("clientes_listos_2026-10-20-06h.xlsx");
    expect((await runExcelListos(env, A_LAS_6 + 10 * 60_000)).sent).toBe(false);
  });
  it("a las 14:00 solo manda los nuevos; sin nuevos avisa en corto", async () => {
    await runExcelListos(env, A_LAS_6);
    fetchMock.mockClear();
    const r = await runExcelListos(env, A_LAS_14);
    expect(r).toEqual({ sent: true, leads: 0 });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith("/sendDocument")).length).toBe(0);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).text).toContain("Sin clientes nuevos");
  });
  it("fuera de las 6:00 y 14:00 no hace nada", async () => {
    expect((await runExcelListos(env, Date.UTC(2026, 9, 20, 9, 0))).sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("correo inventado", () => {
  it("sin correo se inventa uno con el nombre, en un dominio que no existe, y queda marcado", () => {
    const [l] = armarLeads([conv], [lead({ name: "María José Pérez", contact: "" })]);
    const r = correoParaFormulario(l);
    expect(r).toEqual({ correo: "maria.jose.perez@correo-no-proporcionado.invalid", inventado: true });
  });
  it("con correo real no se toca", () => {
    const [l] = armarLeads([conv], [lead()]);
    expect(correoParaFormulario(l)).toEqual({ correo: "ana@correo.com", inventado: false });
  });
  it("el enlace del formulario lleva el correo inventado y el aviso lo advierte", () => {
    const [l] = armarLeads([conv], [lead({ name: "Ana López", contact: "", metadata: JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "Cali" }) })]);
    const u = new URL(urlFormulario("https://forms.example/f", l));
    expect(u.searchParams.get("Email")).toBe("ana.lopez@correo-no-proporcionado.invalid");
    expect(mensajesResumen([l], "https://x/admin", "https://forms.example/f").join("\n")).toContain("correo inventado");
  });
  it("sin correo el cliente igual entra al Excel de listos (el teléfono y las ciudades sí son obligatorios)", () => {
    const [l] = armarLeads([conv], [lead({ contact: "", metadata: JSON.stringify({ ciudadResidencia: "España, Girona", ciudadCompra: "Cali" }) })]);
    expect(faltantes(l)).toEqual([]);
  });
});

describe("horaDeLlamadaPedida", () => {
  it("«no indicada» no cuenta como pedir hora; una hora real sí", async () => {
    const { horaDeLlamadaPedida, puntuarLead } = await import("../../src/followup/resumenDia");
    expect(horaDeLlamadaPedida("Origen: x. Hora de llamada pedida: no indicada. Teléfono sin indicativo")).toBe("");
    expect(horaDeLlamadaPedida("Hora de llamada pedida: 18:00 hora de España")).toBe("Hora de llamada pedida: 18:00 hora de España");
    expect(horaDeLlamadaPedida("sin nada")).toBe("");
    const sin = puntuarLead({ metadata: {}, notas: "Hora de llamada pedida: no indicada", telefono: "640961054" } as any);
    expect(sin.puntos).toBe(1);
    const con = puntuarLead({ metadata: {}, notas: "Hora de llamada pedida: mañana 5pm", telefono: "640961054" } as any);
    expect(con.puntos).toBe(2);
  });
});
