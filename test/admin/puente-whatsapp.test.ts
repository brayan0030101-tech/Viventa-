/** Instagram → WhatsApp: enlace con mensaje escrito, unión de las dos conversaciones y recordatorio. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const enviarMock = vi.fn();
vi.mock("../../src/followup/send", () => ({ sendOutbound: (...a: unknown[]) => enviarMock(...a) }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { construirEnlace, crearEnlace, vincularPuente, runPuenteRecordatorio, estadisticaPuente } from "../../member/puente-whatsapp.local";
import type { Env } from "../../src/env";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 22, 12, 0);
let db: Db;
let env: Env;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, YCLOUD_WA_FROM: "+34611688609" } as unknown as Env;
  enviarMock.mockReset().mockResolvedValue(undefined);
});

describe("enlace", () => {
  it("lleva el número de Viventa, el nombre, «vengo de Instagram» y la referencia, bien codificado", () => {
    const e = construirEnlace("+34611688609", "Laura Pérez", "K7Q2");
    expect(e.url.startsWith("https://wa.me/34611688609?text=")).toBe(true);
    expect(decodeURIComponent(e.url.split("text=")[1])).toBe("Hola, soy Laura Pérez y vengo de Instagram. Quiero información para comprar vivienda en Colombia. (Ref K7Q2)");
  });
  it("reutiliza el mismo enlace mientras no se use", async () => {
    const ig = await new ConversationsRepo(db).getOrCreate("zernio", "9001", "laura_ig");
    const a = await crearEnlace(env, ig.id, "Laura", NOW);
    const b = await crearEnlace(env, ig.id, "Laura", NOW + 1000);
    expect(a!.ref).toBe(b!.ref);
    expect(a!.ref).toMatch(/^[A-Z2-9]{4}$/);
  });
});

describe("unir Instagram con WhatsApp", () => {
  it("copia el historial, pasa la ficha a la conversación de WhatsApp y marca el puente", async () => {
    const ig = await new ConversationsRepo(db).getOrCreate("zernio", "9002", "maria_ig");
    await new MessagesRepo(db).append(ig.id, "user", "Hola, quiero información", { createdAt: NOW - 2 * H });
    await new MessagesRepo(db).append(ig.id, "assistant", "¿Nos autorizas?", { createdAt: NOW - 2 * H + 1000 });
    await db.run("INSERT INTO leads (id, conversation_id, name, intent, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ["l1", ig.id, "María", "Lead", JSON.stringify({ ciudadCompra: "Cali" }), NOW - 2 * H, NOW - 2 * H]);
    const e = await crearEnlace(env, ig.id, "María", NOW - H);
    const r = await vincularPuente(env, "ycloud:34600000111", "34600000111", `Hola, soy María y vengo de Instagram. (Ref ${e!.ref})`, "María", NOW);
    expect(r).toBe(ig.id);
    const msgs = await db.all<{ conversation_id: string; role: string }>("SELECT conversation_id, role FROM messages WHERE conversation_id = 'ycloud:34600000111'");
    expect(msgs).toHaveLength(2);
    const lead = await db.first<{ conversation_id: string }>("SELECT conversation_id FROM leads WHERE id = 'l1'");
    expect(lead?.conversation_id).toBe("ycloud:34600000111");
    const meta = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [ig.id]);
    expect(meta?.metadata).toContain("viventa_puente");
    expect(await vincularPuente(env, "ycloud:34600000999", "34600000999", `(Ref ${e!.ref})`, undefined, NOW)).toBeNull(); // otra persona no puede reusar la referencia
    expect(await estadisticaPuente(env, NOW - 24 * H)).toEqual({ enviados: 1, pasaron: 1 });
  });

  it("un mensaje sin referencia o con una referencia desconocida no hace nada", async () => {
    expect(await vincularPuente(env, "ycloud:1", "1", "Hola, quiero información", undefined, NOW)).toBeNull();
    expect(await vincularPuente(env, "ycloud:1", "1", "Hola (Ref ZZZZ)", undefined, NOW)).toBeNull();
  });
});

describe("recordatorio", () => {
  it("a las ~18 h, si no pasó a WhatsApp y la ventana de Instagram sigue abierta, recuerda UNA vez", async () => {
    const ig = await new ConversationsRepo(db).getOrCreate("zernio", "9003", "pedro_ig");
    await new MessagesRepo(db).append(ig.id, "user", "Hola", { createdAt: NOW - 19 * H });
    await crearEnlace(env, ig.id, "Pedro", NOW - 18 * H);
    expect(await runPuenteRecordatorio(env, NOW)).toBe(1);
    expect(enviarMock.mock.calls[0][1].text).toContain("https://wa.me/34611688609");
    expect(await runPuenteRecordatorio(env, NOW + H)).toBe(0);
  });
});
