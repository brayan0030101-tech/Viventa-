/**
 * Resumen diario de Maricela: puntuación de leads, texto, CSV para Zoho y cron (1 vez al día).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import {
  parseMonto, puntuarLead, armarLeads, csvZoho, mensajesResumen, urlFormulario, runResumenDia,
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

describe("puntuarLead", () => {
  it("ahorro alto, cuota y entrega inmediata = caliente", () => {
    const p = puntuarLead({
      telefono: "+34600000001",
      notas: "Hora de llamada pedida: 18:00",
      metadata: { ahorroDisponible: "20 mil euros", capacidadMensual: "1000", tipoEmpleo: "contrato indefinido", entregaInmediataOFutura: "ahora", ciudadResidencia: "a", ciudadCompra: "b" },
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
    expect(ms.join("\n")).toContain("📝 Registrar: https://forms.example/f?");
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
