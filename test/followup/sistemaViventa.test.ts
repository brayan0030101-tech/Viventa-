/**
 * Sistema Viventa: seguimiento del guion (~24 h), seguimiento a 48 h de los
 * proyectos y recordatorios de la videollamada (24 h / 1 h + resumen a Maricela).
 * Todos reclaman antes de enviar: una segunda pasada no repite nada.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendOutboundMock = vi.fn();
const sendTemplateMock = vi.fn();
const messageOwnerMock = vi.fn();
const notifyCamilaMock = vi.fn();

vi.mock("../../src/followup/send", () => ({
  sendOutbound: (...a: unknown[]) => sendOutboundMock(...a),
}));
vi.mock("../../src/channels/ycloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/channels/ycloud")>();
  return { ...actual, sendYCloudTemplate: (...a: unknown[]) => sendTemplateMock(...a) };
});
vi.mock("../../src/tools/handoffHuman", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/handoffHuman")>();
  return { ...actual, messageOwner: (...a: unknown[]) => messageOwnerMock(...a) };
});
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyCamilaMock(...a) };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { SettingsRepo } from "../../src/db/settings";
import {
  runGuionSeguimiento,
  runSeguimientoProyectos,
  runRecordatoriosLlamada,
  runPedirTelefono,
  runPedirDatos,
  textoPedirDatos,
  TEXTO_PEDIR_TELEFONO,
  TPL_SEGUIMIENTO,
  TPL_RECORDATORIO,
} from "../../src/followup/sistemaViventa";
import type { Env } from "../../src/env";

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // martes 20 oct 2026, 12:00 UTC

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let settings: SettingsRepo;

async function seedConv(channel: string, userId: string, name = "Ana Pérez") {
  const conv = await convs.getOrCreate(channel, userId, name);
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [NOW - H, conv.id]);
  return conv.id;
}

async function seedTicket(convId: string, at: number, summary = "[Lead calificado: enviar proyectos] ficha") {
  await db.run(
    "INSERT INTO tickets (id, conversation_id, category, summary, transcript, status, created_at) VALUES (?, ?, 'other', ?, '', 'open', ?)",
    [crypto.randomUUID(), convId, summary, at],
  );
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "Maricela",
    BUSINESS_NAME: "Viventa",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BOT_TIMEZONE: "Europe/Madrid",
    BUFFER_SECONDS: "8",
  } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  settings = new SettingsRepo(db);
  sendOutboundMock.mockReset().mockResolvedValue(undefined);
  sendTemplateMock.mockReset().mockResolvedValue(undefined);
  messageOwnerMock.mockReset().mockResolvedValue(undefined);
  notifyCamilaMock.mockReset().mockResolvedValue(true);
});

describe("seguimiento del guion", () => {
  async function seedGuion(userId: string, idleH: number, channel = "ycloud") {
    const id = await seedConv(channel, userId);
    await msgs.append(id, "user", "hola", { createdAt: NOW - idleH * H });
    await msgs.append(id, "assistant", "¿Me confirmas tu nombre y apellido?", { createdAt: NOW - idleH * H + 1000 });
    return id;
  }

  it("manda UN recordatorio entre 20 y 23,5 h y avisa a Camila; no repite", async () => {
    await seedGuion("34600000001", 21);
    const r1 = await runGuionSeguimiento(env, NOW);
    expect(r1.sent).toBe(1);
    expect(sendOutboundMock).toHaveBeenCalledTimes(1);
    expect(sendOutboundMock.mock.calls[0][1].text).toContain("¿Seguimos con las preguntas?");
    expect(sendOutboundMock.mock.calls[0][1].text).toContain("Ana");
    expect(notifyCamilaMock).toHaveBeenCalledTimes(1);

    const r2 = await runGuionSeguimiento(env, NOW + 5 * 60_000);
    expect(r2.sent).toBe(0);
    expect(sendOutboundMock).toHaveBeenCalledTimes(1);
  });

  it("no escribe si hace menos de 20 h, ni si ya pasó la ventana", async () => {
    await seedGuion("34600000002", 10);
    await seedGuion("34600000003", 25);
    expect((await runGuionSeguimiento(env, NOW)).sent).toBe(0);
    expect(sendOutboundMock).not.toHaveBeenCalled();
  });

  it("no escribe si el guion ya terminó (traspaso a Camila) o si la última palabra fue del cliente", async () => {
    const done = await seedGuion("34600000004", 21);
    await seedTicket(done, NOW - 20 * H);
    const alClienteLeToca = await seedConv("ycloud", "34600000005");
    await msgs.append(alClienteLeToca, "assistant", "hola", { createdAt: NOW - 22 * H });
    await msgs.append(alClienteLeToca, "user", "ok", { createdAt: NOW - 21 * H });
    expect((await runGuionSeguimiento(env, NOW)).sent).toBe(0);
  });
});

describe("seguimiento de proyectos a 48 h", () => {
  async function seedProyectos(userId: string, channel: string, horasDesdeProyectos: number) {
    const id = await seedConv(channel, userId);
    const ticketAt = NOW - (horasDesdeProyectos + 5) * H;
    await msgs.append(id, "user", "listo", { createdAt: ticketAt - H });
    await seedTicket(id, ticketAt);
    await msgs.append(id, "owner", "Te envío 3 proyectos", { createdAt: NOW - horasDesdeProyectos * H });
    return id;
  }

  it("WhatsApp fuera de ventana SIN plantilla: no envía y avisa a Camila", async () => {
    await seedProyectos("34600000010", "ycloud", 49);
    const r = await runSeguimientoProyectos(env, NOW);
    expect(r).toEqual({ sent: 0, sinPlantilla: 1 });
    expect(sendTemplateMock).not.toHaveBeenCalled();
    expect(notifyCamilaMock.mock.calls[0][1].heading).toContain("NO enviado");
  });

  it("WhatsApp con plantilla configurada: la manda y avisa a Camila", async () => {
    await settings.set(TPL_SEGUIMIENTO, "viventa_seguimiento");
    await seedProyectos("34600000011", "ycloud", 50);
    const r = await runSeguimientoProyectos(env, NOW);
    expect(r.sent).toBe(1);
    expect(sendTemplateMock).toHaveBeenCalledWith(expect.anything(), "34600000011", "viventa_seguimiento", "es", ["Ana"]);
    expect(notifyCamilaMock.mock.calls[0][1].heading).toContain("48 h");
  });

  it("Instagram (zernio) va en texto libre", async () => {
    await seedProyectos("17841400000", "zernio", 49);
    expect((await runSeguimientoProyectos(env, NOW)).sent).toBe(1);
    expect(sendOutboundMock).toHaveBeenCalledTimes(1);
  });

  it("no hace nada antes de 48 h, si el lead ya respondió, ni repite", async () => {
    await seedProyectos("34600000012", "zernio", 30);
    const respondio = await seedProyectos("34600000013", "zernio", 49);
    await msgs.append(respondio, "user", "gracias, los reviso", { createdAt: NOW - 2 * H });
    expect((await runSeguimientoProyectos(env, NOW)).sent).toBe(0);

    await seedProyectos("34600000014", "zernio", 49);
    expect((await runSeguimientoProyectos(env, NOW)).sent).toBe(1);
    expect((await runSeguimientoProyectos(env, NOW + 5 * 60_000)).sent).toBe(0);
  });
});

describe("videollamada: recordatorios y resumen", () => {
  async function seedCita(userId: string, startMs: number, createdAt: number, estado = "Reservada (Cal.com)") {
    const convId = await seedConv("ycloud", userId);
    await msgs.append(convId, "user", "quiero agendar", { createdAt: NOW - 3 * H });
    const meta = JSON.stringify({ servicio: "Videollamada Viventa", calStart: new Date(startMs).toISOString(), estado });
    await db.run(
      `INSERT INTO leads (id, conversation_id, name, contact, channel_user_id, intent, metadata, created_at, updated_at)
       VALUES (?, ?, 'Ana Pérez', ?, ?, 'Cita · Videollamada Viventa · 2026-10-21 14:00', ?, ?, ?)`,
      [crypto.randomUUID(), convId, userId, userId, meta, createdAt, createdAt],
    );
    return convId;
  }

  it("a ~24 h manda el recordatorio (en ventana, texto libre) con hora de España", async () => {
    // 21 oct 2026 12:00 UTC = 14:00 en Madrid (CEST)
    await seedCita("34600000020", NOW + 23.5 * H, NOW - 5 * 24 * H);
    const r = await runRecordatoriosLlamada(env, NOW);
    expect(r.r24).toBe(1);
    const text = sendOutboundMock.mock.calls[0][1].text as string;
    expect(text).toContain("mañana");
    expect(text).toContain("(hora de España)");
    expect(text).toMatch(/\b1[3-9]:\d\d\b/);
    expect((await runRecordatoriosLlamada(env, NOW + 5 * 60_000)).r24).toBe(0);
  });

  it("a ~1 h manda el recordatorio y el resumen del lead a Maricela", async () => {
    await seedCita("34600000021", NOW + 55 * 60_000, NOW - 3 * 24 * H);
    const r = await runRecordatoriosLlamada(env, NOW);
    expect(r.r1).toBe(1);
    expect(r.resumenes).toBe(1);
    expect(messageOwnerMock).toHaveBeenCalledTimes(1);
    expect(messageOwnerMock.mock.calls[0][1].heading).toContain("Videollamada");
    expect(sendOutboundMock.mock.calls[0][1].text).toContain("En una hora");
  });

  it("con equipo comercial configurado, el resumen va a Camila/Maricela y no al dueño", async () => {
    (env as any).TELEGRAM_BOT_TOKEN = "T";
    (env as any).CAMILA_TELEGRAM_CHAT_ID = "111,222";
    await seedCita("34600000026", NOW + 55 * 60_000, NOW - 3 * 24 * H);
    const r = await runRecordatoriosLlamada(env, NOW);
    expect(r.resumenes).toBe(1);
    expect(notifyCamilaMock.mock.calls.some((c) => String(c[1].heading).includes("Videollamada"))).toBe(true);
    expect(messageOwnerMock).not.toHaveBeenCalled();
  });

  it("no manda el de 24 h si la cita se agendó hace poco, ni de citas canceladas", async () => {
    await seedCita("34600000022", NOW + 20 * H, NOW - 2 * H); // agendada con 22 h de antelación
    await seedCita("34600000023", NOW + 23.5 * H, NOW - 5 * 24 * H, "Cancelada");
    const r = await runRecordatoriosLlamada(env, NOW);
    expect(r.r24).toBe(0);
    expect(sendOutboundMock).not.toHaveBeenCalled();
  });

  it("fuera de la ventana de WhatsApp usa la plantilla; sin plantilla avisa al dueño y a Camila", async () => {
    const convId = await seedCita("34600000024", NOW + 23.5 * H, NOW - 5 * 24 * H);
    await db.run("UPDATE messages SET created_at = ? WHERE conversation_id = ?", [NOW - 3 * 24 * H, convId]);

    await runRecordatoriosLlamada(env, NOW);
    expect(sendTemplateMock).not.toHaveBeenCalled();
    expect(messageOwnerMock.mock.calls[0][1].heading).toContain("NO enviado");
    expect(notifyCamilaMock).toHaveBeenCalled();

    await settings.set(TPL_RECORDATORIO, "viventa_recordatorio");
    await seedCita("34600000025", NOW + 23.5 * H, NOW - 5 * 24 * H);
    const c2 = "ycloud:34600000025";
    await db.run("UPDATE messages SET created_at = ? WHERE conversation_id = ?", [NOW - 3 * 24 * H, c2]);
    const r = await runRecordatoriosLlamada(env, NOW + 10 * 60_000);
    expect(r.r24).toBe(1);
    expect(sendTemplateMock).toHaveBeenCalledWith(expect.anything(), "34600000025", "viventa_recordatorio", "es", ["Ana", expect.stringMatching(/^\d\d:\d\d$/)]);
  });
});

describe("límite de lecturas de D1 (el cron NO puede hacer subconsultas por conversación)", () => {
  it("el código no usa subconsultas correlacionadas sobre tickets/messages (leían ~60 mil filas por pasada)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/followup/sistemaViventa.ts", "utf8");
    expect(src).not.toMatch(/t\.conversation_id\s*=\s*c\.id/);
    expect(src).not.toMatch(/m\.conversation_id\s*=\s*c\.id/);
    expect(src).not.toMatch(/EXISTS\s*\(\s*SELECT/i);
  });
});


describe("pedir el teléfono a Instagram", () => {
  async function seedIg(userId: string, idleMin: number, content = "Hola, me interesa") {
    const id = await seedConv("zernio", userId);
    await msgs.append(id, "user", content, { createdAt: NOW - idleMin * 60_000 });
    await msgs.append(id, "assistant", "¿En qué ciudad vives?", { createdAt: NOW - idleMin * 60_000 + 1000 });
    return id;
  }

  it("envía el texto de Maricela una sola vez", async () => {
    const id = await seedIg("ig1", 120);
    expect((await runPedirTelefono(env, NOW)).sent).toBe(1);
    expect(sendOutboundMock.mock.calls[0][1]).toMatchObject({ conversationId: id, channel: "zernio", text: TEXTO_PEDIR_TELEFONO });
    expect((await runPedirTelefono(env, NOW)).sent).toBe(0);
  });

  it("no escribe a quien ya dio su número (en el chat o en la ficha)", async () => {
    await seedIg("ig2", 120, "mi número es +34 600 111 222");
    const id3 = await seedIg("ig3", 120);
    await db.run(
      "INSERT INTO leads (id, conversation_id, name, contact, intent, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [crypto.randomUUID(), id3, "Luis", "+34600999888", "compra", "new", NOW - H, NOW - H],
    );
    expect((await runPedirTelefono(env, NOW)).sent).toBe(0);
  });

  it("respeta la ventana: ni charla activa (<45 min) ni pasadas 22 h", async () => {
    await seedIg("ig4", 10);
    await seedIg("ig5", 23 * 60);
    expect((await runPedirTelefono(env, NOW)).sent).toBe(0);
  });

  it("solo Instagram: no toca WhatsApp", async () => {
    const id = await seedConv("ycloud", "34600000009");
    await msgs.append(id, "user", "hola", { createdAt: NOW - 3 * H });
    expect((await runPedirTelefono(env, NOW)).sent).toBe(0);
  });

  it("solo en horario de España (9–21 h)", async () => {
    await seedIg("ig6", 120);
    const noche = Date.UTC(2026, 9, 20, 23, 0, 0); // 01:00 en Madrid
    expect((await runPedirTelefono(env, noche)).sent).toBe(0);
  });

  it("envía de a 5 por pasada", async () => {
    for (let i = 0; i < 7; i++) await seedIg(`igm${i}`, 120);
    expect((await runPedirTelefono(env, NOW)).sent).toBe(5);
    expect((await runPedirTelefono(env, NOW)).sent).toBe(2);
  });

  it("no repite si el bot ya le pidió el número y espera respuesta", async () => {
    const id = await seedConv("zernio", "ig7");
    await msgs.append(id, "user", "hola", { createdAt: NOW - 3 * H });
    await msgs.append(id, "assistant", "¿Me compartes tu número de WhatsApp?", { createdAt: NOW - 3 * H + 1000 });
    expect((await runPedirTelefono(env, NOW)).sent).toBe(0);
  });
});

describe("pedir los datos que faltan para el formulario", () => {
  async function seedCalificado(channel: string, userId: string, lead: { name: string; contact: string; meta: object }, idleMin = 120) {
    const id = await seedConv(channel, userId, lead.name);
    await msgs.append(id, "user", "ok", { createdAt: NOW - idleMin * 60_000 });
    await msgs.append(id, "assistant", "gracias", { createdAt: NOW - idleMin * 60_000 + 1000 });
    await db.run(
      "INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [crypto.randomUUID(), id, lead.name, lead.contact, "compra", JSON.stringify(lead.meta), "new", NOW - 3 * H, NOW - 3 * H],
    );
    await seedTicket(id, NOW - 2 * H);
    return id;
  }

  it("el texto pide solo lo que falta", () => {
    expect(textoPedirDatos("Ana", ["apellido", "correo"])).toContain("tu apellido y tu correo electrónico");
    expect(textoPedirDatos("", ["ciudad donde vive"])).toContain("el país y la ciudad donde vives");
  });

  it("escribe una sola vez a quien le falta algo", async () => {
    const id = await seedCalificado("ycloud", "34600000011", { name: "Ana", contact: "ana@x.com", meta: { ciudadResidencia: "España, Girona", ciudadCompra: "Cali" } });
    expect((await runPedirDatos(env, NOW)).sent).toBe(1);
    expect(sendOutboundMock.mock.calls[0][1]).toMatchObject({ conversationId: id, channel: "ycloud" });
    expect(sendOutboundMock.mock.calls[0][1].text).toContain("tu apellido");
    expect((await runPedirDatos(env, NOW)).sent).toBe(0);
  });

  it("no escribe si ya tiene todo, si ya está registrado o si pasaron las ventanas", async () => {
    await seedCalificado("ycloud", "34600000012", { name: "Luis Pérez", contact: "l@x.com", meta: { ciudadResidencia: "España, Girona", ciudadCompra: "Cali" } });
    const reg = await seedCalificado("ycloud", "34600000013", { name: "Eva", contact: "", meta: {} });
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viventa_registrado','x') WHERE id = ?", [reg]);
    await seedCalificado("zernio", "ig-vieja", { name: "Zoe", contact: "", meta: {} }, 23 * 60);
    expect((await runPedirDatos(env, NOW)).sent).toBe(0);
  });

  it("solo en horario de España", async () => {
    await seedCalificado("ycloud", "34600000014", { name: "Ana", contact: "", meta: {} });
    expect((await runPedirDatos(env, Date.UTC(2026, 9, 20, 23, 0))).sent).toBe(0);
  });

  it("si ya se le pidió el teléfono de Instagram, no se lo repite", async () => {
    const id = await seedCalificado("zernio", "ig-tel", { name: "Marta Ruiz", contact: "m@x.com", meta: { ciudadResidencia: "España, Girona", ciudadCompra: "Cali" } });
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viventa_pidetel','x') WHERE id = ?", [id]);
    expect((await runPedirDatos(env, NOW)).sent).toBe(0);
  });

  it("cuando completan lo pedido avisa al equipo con el enlace una sola vez", async () => {
    const id = await seedCalificado("ycloud", "34600000015", { name: "Ana Gil", contact: "a@x.com", meta: { ciudadResidencia: "España, Girona", ciudadCompra: "Cali" } });
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viventa_pidedatos','x') WHERE id = ?", [id]);
    await runPedirDatos(env, NOW);
    expect(notifyCamilaMock).toHaveBeenCalledTimes(1);
    expect(notifyCamilaMock.mock.calls[0][1].heading).toContain("completó");
    await runPedirDatos(env, NOW);
    expect(notifyCamilaMock).toHaveBeenCalledTimes(1);
  });
});
