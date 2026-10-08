/**
 * Aviso a Camila (equipo comercial): ficha del lead + canales Telegram/correo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { camilaConfigured, notifyCamila, leadFicha, teamTelegramIds, origenCliente } from "../../src/lib/camila";
import type { Env } from "../../src/env";

let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  db = new Db((await mf.getD1Database("DB")) as any);
});
afterEach(() => vi.unstubAllGlobals());

describe("camilaConfigured / notifyCamila", () => {
  it("sin CAMILA_* no está configurado y no envía nada", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = { TELEGRAM_BOT_TOKEN: "t" } as unknown as Env;
    expect(camilaConfigured(env)).toBe(false);
    expect(await notifyCamila(env, { heading: "x", body: "y" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con Telegram manda el aviso al chat de Camila", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const env = { TELEGRAM_BOT_TOKEN: "TOKEN", CAMILA_TELEGRAM_CHAT_ID: "999" } as unknown as Env;
    expect(camilaConfigured(env)).toBe(true);
    expect(await notifyCamila(env, { heading: "📥 Traspaso", body: "ficha", url: "https://x/admin" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("999");
    expect(body.text).toContain("📥 Traspaso");
    expect(body.text).toContain("ficha");
  });

  it("admite VARIOS ids (Camila y Maricela): manda el aviso a cada uno", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const env = { TELEGRAM_BOT_TOKEN: "TOKEN", CAMILA_TELEGRAM_CHAT_ID: "111, 222;333" } as unknown as Env;
    expect(teamTelegramIds(env)).toEqual(["111", "222", "333"]);
    expect(await notifyCamila(env, { heading: "h", body: "b" })).toBe(true);
    const ids = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).chat_id);
    expect(ids).toEqual(["111", "222", "333"]);
  });

  it("si uno de los destinatarios falla, los demás igual reciben el aviso", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const env = { TELEGRAM_BOT_TOKEN: "TOKEN", CAMILA_TELEGRAM_CHAT_ID: "111,222" } as unknown as Env;
    expect(await notifyCamila(env, { heading: "h", body: "b" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("si Telegram falla devuelve false y no lanza", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const env = { TELEGRAM_BOT_TOKEN: "TOKEN", CAMILA_TELEGRAM_CHAT_ID: "999" } as unknown as Env;
    expect(await notifyCamila(env, { heading: "h", body: "b" })).toBe(false);
  });
});

describe("leadFicha", () => {
  async function addConv(id: string) {
    await db.run(
      "INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?, 'ycloud', '34600', 1, 1)",
      [id],
    );
  }
  async function addLead(convId: string, intent: string, name: string | null, meta: object, notes: string | null, at: number) {
    await db.run(
      "INSERT INTO leads (id, conversation_id, name, contact, intent, notes, metadata, created_at, updated_at) VALUES (?, ?, ?, '+34600', ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), convId, name, intent, notes, JSON.stringify(meta), at, at],
    );
  }

  it("junta los leads de la conversación y gana el dato más reciente; ignora las citas", async () => {
    await addConv("c1");
    await addLead("c1", "Quiere vivienda", "Ana", { ciudadCompra: "Pereira", ahorroDisponible: "5 mil" }, null, 1);
    await addLead("c1", "Calificación", "Ana Pérez", { ahorroDisponible: "8 mil euros", tipoEmpleo: "empleada" }, "Situación de residencia: residencia permanente", 2);
    await addLead("c1", "Cita · Videollamada Viventa · 2026-10-21 14:00", "Ana Pérez", { ciudadCompra: "NO DEBE SALIR" }, null, 3);
    const f = await leadFicha(db, "c1");
    expect(f).toContain("Nombre: Ana Pérez");
    expect(f).toContain("Quiere comprar en: Pereira");
    expect(f).toContain("Ahorro para la inicial: 8 mil euros");
    expect(f).toContain("Trabajo: empleada");
    expect(f).toContain("Situación de residencia: residencia permanente");
    expect(f).not.toContain("NO DEBE SALIR");
  });

  it("sin conversación o sin leads devuelve un texto neutro", async () => {
    expect(await leadFicha(db, null)).toContain("sin ficha");
    await addConv("c2");
    expect(await leadFicha(db, "c2")).toContain("sin ficha");
  });
});

describe("origenCliente", () => {
  async function conv(id: string, channel: string, user: string, name: string | null) {
    await db.run(
      "INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)",
      [id, channel, user, name, 1, 1],
    );
  }
  it("WhatsApp muestra el teléfono", async () => {
    await conv("ycloud:34600000001", "ycloud", "34600000001", "Ana");
    expect(await origenCliente(db, "ycloud:34600000001")).toBe("💬 WhatsApp · Ana · +34600000001");
  });
  it("Instagram muestra el perfil y no un número", async () => {
    await conv("zernio:123", "zernio", "123", "Luis");
    expect(await origenCliente(db, "zernio:123")).toBe("📸 Instagram · Luis");
  });
  it("sin conversación devuelve vacío", async () => {
    expect(await origenCliente(db, null)).toBe("");
    expect(await origenCliente(db, "nope")).toBe("");
  });
});
