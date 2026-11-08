// member/viabilidad.local.ts — el bot envía el enlace del formulario de VIABILIDAD (estudio previo gratuito).
// Zoho genera para cada candidato su enlace personal (campo Enlace_corto_Formulario_Consulta_Centrales, un cutt.ly con sus datos precargados).
// El bot lo lee de la ficha del candidato y se lo manda por WhatsApp; si el candidato aún no está en Zoho, lo sube primero (con nota y tarea, como siempre).
// Si Zoho todavía no generó el enlace, queda pendiente y una pasada del sistema (cada 15 min) lo envía en cuanto exista y avisa al equipo si tarda.
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { buscarCandidato, crearNota, zohoGet, zohoListo, type FetchFn } from "./crm-zohoapi.local";
import { escrituraActiva, hoyMadrid } from "./crm-seguimientos.local";

const H = 3_600_000;

export const textoViabilidad = (url: string): string =>
  `Aquí tienes el formulario del estudio previo de viabilidad: ${url}\n\nTe tomará menos de 5 minutos y es gratis: solo ten a mano tu cédula de ciudadanía colombiana. Es una estimación preliminar de cuánto podrías financiar con un banco en Colombia: no garantiza la aprobación del crédito y no te compromete en nada con Viventa. 😊`;

const esc = (v: string) => v.replace(/[^\w:.+-]/g, "");

/** Enlace personal del formulario de viabilidad del cliente (null si Zoho todavía no lo generó). Sube al cliente a Zoho si aún no está. */
export async function obtenerEnlaceViabilidad(env: Env, convId: string, f: FetchFn = fetch, now = Date.now()): Promise<{ ok: true; url: string } | { ok: false; motivo: string; pendiente?: boolean }> {
  if (!zohoListo(env)) return { ok: false, motivo: "Zoho no está conectado." };
  const db = new Db(env.DB);
  const c = await db.first<{ channel: string; channel_user_id: string; z: string | null }>("SELECT channel, channel_user_id, json_extract(COALESCE(metadata,'{}'),'$.zoho_lead_id') AS z FROM conversations WHERE id = ?", [convId]);
  if (!c) return { ok: false, motivo: "No encontré la conversación." };
  let leadId = c.z && /^\d{6,30}$/.test(c.z) ? c.z : "";
  if (!leadId) {
    const leads = await db.all<{ contact: string | null }>("SELECT contact FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%'", [convId]);
    const contactos = leads.map((l) => l.contact ?? "").join(" ");
    const cand = await buscarCandidato(env, { correos: contactos.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g) ?? [], telefono: c.channel === "ycloud" ? c.channel_user_id : (contactos.match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? "") }, f, now).catch(() => null);
    if (cand?.id) leadId = cand.id;
    else if (await escrituraActiva(env)) {
      const { subirCliente } = await import("./crm-zohosubida.local");
      const r = await subirCliente(env, convId, { manual: true, f, now });
      if (r.estado === "creado" || r.estado === "ya_existe") leadId = r.leadId;
      else return { ok: false, motivo: r.estado === "no_corresponde" ? r.motivo : r.motivo };
    }
    if (!leadId) return { ok: false, motivo: "El cliente todavía no está en Zoho." };
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_lead_id', ?) WHERE id = ?", [leadId, convId]);
  }
  // Zoho genera el enlace unos segundos o minutos después de crear el candidato: se reintenta un momento.
  for (let i = 0; i < 4; i++) {
    const j = (await zohoGet(env, `/Leads/${esc(leadId)}?fields=Enlace_corto_Formulario_Consulta_Centrales,Enlace_largo_Formulario_Consulta_Centrales`, f, now).catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
    const d = j?.data?.[0];
    const url = String(d?.["Enlace_corto_Formulario_Consulta_Centrales"] || d?.["Enlace_largo_Formulario_Consulta_Centrales"] || "").trim();
    if (/^https?:\/\//.test(url)) return { ok: true, url };
    if (i < 3 && f === fetch) await new Promise((r) => setTimeout(r, 6_000));
    else if (i < 3) break;
  }
  return { ok: false, motivo: "Zoho todavía no generó el enlace del formulario.", pendiente: true };
}

/** Marca el envío y deja la nota en Zoho (sin mencionar al bot). */
async function registrarEnvio(env: Env, convId: string, f: FetchFn, now: number): Promise<void> {
  const db = new Db(env.DB);
  await db.run("UPDATE conversations SET metadata = json_remove(json_set(COALESCE(metadata,'{}'),'$.viabilidad_enviada', ?), '$.viabilidad_pendiente') WHERE id = ?", [new Date(now).toISOString(), convId]);
  try {
    const z = (await db.first<{ z: string | null }>("SELECT json_extract(COALESCE(metadata,'{}'),'$.zoho_lead_id') AS z FROM conversations WHERE id = ?", [convId]))?.z;
    if (z && (await escrituraActiva(env))) await crearNota(env, z, `Estudio de viabilidad (${hoyMadrid(now)}): se le envió por WhatsApp el enlace del formulario gratuito.`, f, now);
  } catch (e) {
    console.error("[viabilidad] nota:", e instanceof Error ? e.message : e);
  }
}

export function enviarViabilidadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Úsala cuando el cliente ACEPTA el estudio previo de viabilidad gratuito (o lo pide). Devuelve el ENLACE personal del formulario para mandárselo por WhatsApp. Si devuelve ok=true, envía el mensaje `mensajeSugerido` tal cual (lleva el enlace). Si ok=false con pendiente=true, dile que en unos minutos le llega el formulario por aquí (el sistema se lo manda solo). Nunca inventes ni escribas un enlace tú.",
    inputSchema: z.object({}),
    execute: async () => {
      const convId = getConversationId();
      if (!convId || !convId.startsWith("ycloud:")) return { ok: false as const, motivo: "Solo se envía por WhatsApp." };
      const db = new Db(env.DB);
      try {
        const r = await obtenerEnlaceViabilidad(env, convId);
        if (r.ok) {
          await registrarEnvio(env, convId, fetch, Date.now());
          return { ok: true as const, url: r.url, mensajeSugerido: textoViabilidad(r.url) };
        }
        if (r.pendiente) await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_pendiente', ?) WHERE id = ?", [Date.now(), convId]);
        return { ok: false as const, pendiente: !!r.pendiente, motivo: r.motivo };
      } catch (e) {
        console.error("[viabilidad]", e instanceof Error ? e.message : e);
        await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_pendiente', ?) WHERE id = ?", [Date.now(), convId]).catch(() => undefined);
        return { ok: false as const, pendiente: true, motivo: "No pude obtener el enlace ahora." };
      }
    },
  });
}

/** Cada 15 min: a los que quedaron pendientes les manda el enlace en cuanto Zoho lo genera; si pasan 6 h sin enlace avisa al equipo (una vez). */
export async function runViabilidadPendiente(env: Env, now = Date.now(), f: FetchFn = fetch): Promise<number> {
  if (!zohoListo(env)) return 0;
  const db = new Db(env.DB);
  const filas = await db.all<{ id: string; channel_user_id: string; display_name: string | null; p: number; aviso: string | null; ult: number | null }>(
    `SELECT c.id, c.channel_user_id, c.display_name, CAST(json_extract(c.metadata,'$.viabilidad_pendiente') AS INTEGER) AS p, json_extract(c.metadata,'$.viabilidad_aviso') AS aviso,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS ult
       FROM conversations c WHERE c.channel = 'ycloud' AND json_extract(c.metadata,'$.viabilidad_pendiente') IS NOT NULL LIMIT 20`,
  );
  let n = 0;
  for (const c of filas) {
    const r = await obtenerEnlaceViabilidad(env, c.id, f, now).catch(() => ({ ok: false as const, motivo: "error" }));
    if (r.ok) {
      if (!c.ult || now - c.ult > 23 * H) {
        // Ventana de 24 h cerrada: no se puede escribir libre; se avisa para que lo envíe una persona.
        const { notifyCamila } = await import("../src/lib/camila");
        await notifyCamila(env, { heading: "📋 Enviar formulario de viabilidad", body: `${c.display_name || c.channel_user_id} aceptó el estudio gratuito y ya hay enlace, pero pasaron más de 24 h desde su último mensaje: ${r.url}` }).catch(() => false);
        await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata,'{}'),'$.viabilidad_pendiente') WHERE id = ?", [c.id]);
        continue;
      }
      try {
        const { sendOutbound } = await import("../src/followup/send");
        const conv = await db.first<{ channel: string; channel_user_id: string }>("SELECT channel, channel_user_id FROM conversations WHERE id = ?", [c.id]);
        if (conv) await sendOutbound(env, { conversationId: c.id, channel: conv.channel, channelUserId: conv.channel_user_id, text: textoViabilidad(r.url) }, now);
        await registrarEnvio(env, c.id, f, now);
        n++;
      } catch (e) {
        console.error("[viabilidad] envío pendiente:", e instanceof Error ? e.message : e);
      }
    } else if (now - c.p > 6 * H && !c.aviso) {
      const { notifyCamila } = await import("../src/lib/camila");
      await notifyCamila(env, { heading: "📋 Formulario de viabilidad sin enlace", body: `${c.display_name || c.channel_user_id} aceptó el estudio gratuito pero Zoho no generó su enlace (${r.motivo}). Envíaselo tú.` }).catch(() => false);
      await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_aviso', ?) WHERE id = ?", [new Date(now).toISOString(), c.id]);
    }
  }
  return n;
}
