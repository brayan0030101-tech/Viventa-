/**
 * Envío masivo de la plantilla «retomar»: solo con la plantilla aprobada, a quien está fuera de ventana, sin cita, sin persona atendiendo, una sola vez.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendTemplateMock = vi.fn();
vi.mock("../../src/channels/ycloud", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/channels/ycloud")>()), sendYCloudTemplate: (...a: unknown[]) => sendTemplateMock(...a) }));
vi.mock("../../src/lib/camila", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/lib/camila")>()), notifyCamila: vi.fn().mockResolvedValue(true) }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { SettingsRepo } from "../../src/db/settings";
import { runRetomarMasivo, TPL_RETOMAR } from "../../member/crm-retomar.local";
import type { Env } from "../../src/env";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 12, 0); // 14:00 en Madrid
let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let st: SettingsRepo;
let estado = "APPROVED";
const salientes: Record<string, number> = {};

const f = (async (url: string) => {
  if (String(url).includes("phoneNumbers")) return new Response(JSON.stringify({ items: [{ phoneNumber: "+34611688609", wabaId: "W1" }] }));
  if (String(url).includes("/templates")) return new Response(JSON.stringify({ items: [{ name: TPL_RETOMAR, status: estado }] }));
  const tel = decodeURIComponent(String(url)).match(/filter\.to=\+(\d+)/)?.[1] ?? "";
  return new Response(JSON.stringify({ items: Array.from({ length: salientes[tel] ?? 1 }, () => ({ status: "sent", createTime: new Date(NOW - 20 * H).toISOString() })) }));
}) as unknown as typeof fetch;

async function cliente(tel: string, nombre: string, ultCliHace: number, botHablo = true) {
  const c = await convs.getOrCreate("ycloud", tel, nombre);
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [NOW - ultCliHace * H, c.id]);
  await msgs.append(c.id, "user", "hola", { createdAt: NOW - ultCliHace * H });
  if (botHablo) await msgs.append(c.id, "assistant", "¿Cuánto ahorras?", { createdAt: NOW - ultCliHace * H + 1000 });
  return c.id;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, YCLOUD_API_KEY: "k", YCLOUD_WA_FROM: "+34611688609" } as unknown as Env;
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  st = new SettingsRepo(db);
  await st.set("viventa_retomar_masivo", "activo");
  estado = "APPROVED";
  for (const k of Object.keys(salientes)) delete salientes[k];
  sendTemplateMock.mockReset().mockResolvedValue(undefined);
});

describe("retomar masivo", () => {
  it("no hace nada apagado o con la plantilla pendiente; con ella aprobada escribe una sola vez y deja el texto en el hilo", async () => {
    const id = await cliente("34600000001", "Ana", 48);
    estado = "PENDING";
    expect((await runRetomarMasivo(env, NOW, f)).sent).toBe(0);
    estado = "APPROVED";
    expect((await runRetomarMasivo(env, NOW, f)).sent).toBe(1);
    expect(sendTemplateMock.mock.calls[0].slice(1)).toEqual(["34600000001", TPL_RETOMAR, "es_ES", []]);
    const m = await db.all<{ role: string; content: string }>("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", [id]);
    expect(m[0].content).toContain("¿Sigues interesado/a?");
    expect((await runRetomarMasivo(env, NOW + 15 * 60_000, f)).sent).toBe(0);
  });

  it("salta a quien está dentro de la ventana, tiene cita, lo atendió una persona (también desde la app) o ya está en reactivación", async () => {
    await cliente("34600000002", "Dentro", 5);
    const conCita = await cliente("34600000003", "Cita", 48);
    await db.run("INSERT INTO leads (id, conversation_id, intent, created_at, updated_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), conCita, "Cita · videollamada", NOW - H, NOW - H]);
    const conOwner = await cliente("34600000004", "Equipo", 48);
    await msgs.append(conOwner, "owner", "Te llamo mañana", { createdAt: NOW - 30 * H });
    await cliente("34600000005", "Desde la app", 48);
    salientes["34600000005"] = 3; // YCloud registró 3 mensajes salientes y solo 1 está guardado: alguien contestó desde la app
    const r = await runRetomarMasivo(env, NOW, f);
    expect(r.sent).toBe(0);
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("no escribe de madrugada (hora del cliente) y lo intenta en la siguiente pasada", async () => {
    await cliente("34600000006", "Noche", 48);
    const madrugada = Date.UTC(2026, 9, 21, 1, 0); // 03:00 en Madrid
    expect((await runRetomarMasivo(env, madrugada, f)).sent).toBe(0);
    expect((await runRetomarMasivo(env, NOW, f)).sent).toBe(1);
  });
});
