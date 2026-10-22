// member/puente-whatsapp.local.ts — «Instagram es la puerta, WhatsApp es donde se hace la prospección» (pedido de Maricela y Camila, 22 oct 2026).
// En Instagram el bot solo pide la autorización y el nombre y manda UN enlace de WhatsApp (wa.me) con el mensaje ya escrito:
//   «Hola, soy Laura y vengo de Instagram. Quiero información para comprar vivienda en Colombia. (Ref K7Q2)».
// El cliente solo toca el enlace y pulsa enviar. Al llegar ese mensaje al WhatsApp del bot, la «Ref» identifica su conversación de Instagram: se copia
// el historial, se pasan los datos de la ficha y el bot sigue donde se quedaron (sin repetir la autorización). Si no pasa en ~18 h y la ventana de
// Instagram sigue abierta, se le recuerda UNA vez; si no, queda en el auditor / «Esperando un humano».
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";

const H = 3_600_000;
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin O/0/I/1/l: el cliente puede equivocarse al leerlo

async function asegurarTabla(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS puente_whatsapp (ref TEXT PRIMARY KEY, ig_conv TEXT NOT NULL, nombre TEXT, creado INTEGER NOT NULL, recordado_en INTEGER, wa_conv TEXT, usado_en INTEGER)");
  await db.run("CREATE INDEX IF NOT EXISTS idx_puente_ig ON puente_whatsapp(ig_conv)");
}

function refNueva(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join("");
}

export interface Enlace {
  ref: string;
  url: string;
  texto: string;
}

export function construirEnlace(numeroWhatsApp: string, nombre: string, ref: string): Enlace {
  const limpio = nombre.replace(/\s+/g, " ").trim().slice(0, 40) || "un cliente";
  const texto = `Hola, soy ${limpio} y vengo de Instagram. Quiero información para comprar vivienda en Colombia. (Ref ${ref})`;
  return { ref, texto, url: `https://wa.me/${numeroWhatsApp.replace(/\D/g, "")}?text=${encodeURIComponent(texto)}` };
}

/** Crea (o reutiliza) el enlace de WhatsApp de una conversación de Instagram. */
export async function crearEnlace(env: Env, igConvId: string, nombre: string, now = Date.now()): Promise<Enlace | null> {
  const numero = env.YCLOUD_WA_FROM ?? "";
  if (!numero.replace(/\D/g, "")) return null;
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const previo = await db.first<{ ref: string; nombre: string | null }>("SELECT ref, nombre FROM puente_whatsapp WHERE ig_conv = ? AND usado_en IS NULL ORDER BY creado DESC LIMIT 1", [igConvId]);
  if (previo) {
    if (nombre && nombre !== previo.nombre) await db.run("UPDATE puente_whatsapp SET nombre = ? WHERE ref = ?", [nombre, previo.ref]);
    return construirEnlace(numero, nombre || previo.nombre || "", previo.ref);
  }
  const ref = refNueva();
  await db.run("INSERT INTO puente_whatsapp (ref, ig_conv, nombre, creado) VALUES (?,?,?,?)", [ref, igConvId, nombre, now]);
  return construirEnlace(numero, nombre, ref);
}

/** Herramienta del bot: solo en Instagram. Devuelve el enlace que hay que mandarle al cliente. */
export function enlaceWhatsAppTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Solo en Instagram. Cuando el cliente ya autorizó el registro de sus datos y dijo su nombre, llámala para obtener el ENLACE de WhatsApp con el mensaje ya escrito. Mándale el enlace tal cual lo devuelve (sin cambiarlo) en un mensaje corto y amable que le explique que solo tiene que tocarlo y pulsar enviar. Devuelve {url, ref}.",
    inputSchema: z.object({ nombre: z.string().min(1).describe("Nombre del cliente, tal como lo dijo (sin apellidos largos)") }),
    execute: async ({ nombre }) => {
      const convId = getConversationId();
      if (!convId || !convId.startsWith("zernio:")) return { ok: false as const, motivo: "Solo se usa en Instagram." };
      const e = await crearEnlace(env, convId, nombre);
      if (!e) return { ok: false as const, motivo: "No hay número de WhatsApp configurado." };
      return { ok: true as const, url: e.url, ref: e.ref, mensajeSugerido: `Gracias, ${nombre}. Para atenderte mejor seguimos por WhatsApp. Toca este enlace y pulsa «enviar» (el mensaje ya viene escrito): ${e.url}` };
    },
  });
}

const RE_REF = /\(?\bRef\.?\s*([A-Z0-9]{4})\)?/i;

/**
 * Se llama ANTES de que el bot procese un mensaje de WhatsApp: si trae una «Ref» de un enlace del puente, une esta conversación con la de Instagram
 * (historial + ficha) para que el bot continúe donde se quedaron. Devuelve el id de la conversación de Instagram, o null si no aplica.
 */
export async function vincularPuente(env: Env, waConvId: string, waUserId: string, texto: string, nombreWa: string | undefined, now = Date.now()): Promise<string | null> {
  const m = RE_REF.exec(texto);
  if (!m) return null;
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const p = await db.first<{ ref: string; ig_conv: string; nombre: string | null; usado_en: number | null; wa_conv: string | null }>("SELECT ref, ig_conv, nombre, usado_en, wa_conv FROM puente_whatsapp WHERE ref = ?", [m[1].toUpperCase()]);
  if (!p) return null;
  if (p.usado_en) return p.wa_conv === waConvId ? p.ig_conv : null; // ya se unió antes
  const conv = await new ConversationsRepo(db).getOrCreate("ycloud", waUserId, p.nombre || nombreWa);
  const waId = conv.id;
  const hist = await db.all<{ role: string; content: string; created_at: number }>("SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 60", [p.ig_conv]);
  const repo = new MessagesRepo(db);
  for (const h of hist.reverse()) await repo.append(waId, h.role as "user" | "assistant", h.content, { createdAt: Math.min(h.created_at, now - 1000) });
  // La ficha pasa a la conversación de WhatsApp (el CRM, las cotizaciones y los recordatorios viven ahí); Instagram queda solo como chat.
  await db.run("UPDATE leads SET conversation_id = ?, channel_user_id = COALESCE(channel_user_id, ?) WHERE conversation_id = ?", [waId, waUserId, p.ig_conv]);
  await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_puente_de', ?) WHERE id = ?", [p.ig_conv, waId]);
  await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_puente', ?) WHERE id = ?", [waId, p.ig_conv]);
  await db.run("UPDATE puente_whatsapp SET wa_conv = ?, usado_en = ? WHERE ref = ?", [waId, now, p.ref]);
  return p.ig_conv;
}

/** A las ~18 h de mandado el enlace, si no pasó a WhatsApp y la ventana de Instagram sigue abierta, se le recuerda UNA vez. */
export async function runPuenteRecordatorio(env: Env, now = Date.now()): Promise<number> {
  const numero = env.YCLOUD_WA_FROM ?? "";
  if (!numero.replace(/\D/g, "")) return 0;
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const pend = await db.all<{ ref: string; ig_conv: string; nombre: string | null }>("SELECT ref, ig_conv, nombre FROM puente_whatsapp WHERE usado_en IS NULL AND recordado_en IS NULL AND creado BETWEEN ? AND ? LIMIT 10", [now - 21 * H, now - 16 * H]);
  let n = 0;
  for (const p of pend) {
    const conv = await db.first<{ channel_user_id: string; paused_until: number | null }>("SELECT channel_user_id, paused_until FROM conversations WHERE id = ?", [p.ig_conv]);
    const ult = (await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [p.ig_conv]))?.t ?? 0;
    if (!conv || (conv.paused_until && conv.paused_until > now) || now - ult > 22 * H) { await db.run("UPDATE puente_whatsapp SET recordado_en = ? WHERE ref = ?", [now, p.ref]); continue; }
    const e = construirEnlace(numero, p.nombre ?? "", p.ref);
    try {
      const { sendOutbound } = await import("../src/followup/send");
      await sendOutbound(env, { conversationId: p.ig_conv, channel: "zernio", channelUserId: conv.channel_user_id, text: `Hola${p.nombre ? ` ${p.nombre}` : ""}, para no perder nuestra conversación seguimos por WhatsApp, es más cómodo. Toca este enlace y pulsa «enviar»: ${e.url}` }, now);
      n++;
    } catch (err) {
      console.error("[puenteWhatsApp] recordatorio:", err);
    }
    await db.run("UPDATE puente_whatsapp SET recordado_en = ? WHERE ref = ?", [now, p.ref]);
  }
  return n;
}

/** Cuántos enlaces se mandaron y cuántos clientes pasaron a WhatsApp desde `desde` (para el recorrido del cliente). */
export async function estadisticaPuente(env: Env, desde: number): Promise<{ enviados: number; pasaron: number }> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const r = await db.first<{ e: number; p: number }>("SELECT COUNT(*) AS e, SUM(CASE WHEN usado_en IS NOT NULL THEN 1 ELSE 0 END) AS p FROM puente_whatsapp WHERE creado > ?", [desde]);
  return { enviados: r?.e ?? 0, pasaron: r?.p ?? 0 };
}
