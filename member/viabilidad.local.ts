// member/viabilidad.local.ts — el bot envía el enlace del formulario de VIABILIDAD (estudio previo gratuito).
// Zoho genera para cada candidato su enlace personal (campo Enlace_corto_Formulario_Consulta_Centrales, un cutt.ly con sus datos precargados).
// El bot lo lee de la ficha del candidato y se lo manda por WhatsApp; si el candidato aún no está en Zoho, lo sube primero (con nota y tarea, como siempre).
// Si Zoho todavía no generó el enlace, queda pendiente y una pasada del sistema (cada 15 min) lo envía en cuanto exista y avisa al equipo si tarda.
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { buscarCandidato, crearNota, ejecutarFuncion, exigirDeMaricela, zohoGet, zohoListo, type FetchFn } from "./crm-zohoapi.local";
import { SettingsRepo } from "../src/db/settings";
import { escrituraActiva, hoyMadrid } from "./crm-seguimientos.local";

const H = 3_600_000;

export const textoViabilidad = (url: string): string =>
  `Aquí tienes el formulario del estudio previo de viabilidad: ${url}\n\nTe tomará menos de 5 minutos y es gratis: solo ten a mano tu cédula de ciudadanía colombiana. Es una estimación preliminar de cuánto podrías financiar con un banco en Colombia: no garantiza la aprobación del crédito y no te compromete en nada con Viventa. 😊`;

const esc = (v: string) => v.replace(/[^\w:.+-]/g, "");

/** Función de Zoho (independiente, API REST con OAuth2) con el mismo código que el botón «Enviar Formulario CC» (envia_encuesta_centrales): genera el enlace personal y le manda el correo al cliente. */
export const FUNCION_FORMULARIO_ZOHO = "enviar_formulario_bot";
/** Ajuste (D1): solo con «activo» el bot ejecuta esa función por su cuenta. APAGADO hasta una prueba aprobada con un cliente real. */
export const AJUSTE_FUNCION = "viventa_viabilidad_funcion";

/**
 * Hace lo mismo que pulsar el botón «Enviar Formulario CC» de la ficha. Una sola vez por cliente (la marca se guarda ANTES de ejecutar: Zoho además
 * manda un correo, y repetirlo sería un correo doble), solo con el ajuste activo (o forzado a mano) y solo en fichas de Maricela.
 */
export async function generarEnlaceEnZoho(env: Env, convId: string, leadId: string, opts: { forzar?: boolean; f?: FetchFn; now?: number } = {}): Promise<{ ok: true; respuesta?: string } | { ok: false; motivo: string }> {
  const f = opts.f ?? fetch;
  const now = opts.now ?? Date.now();
  const db = new Db(env.DB);
  if (!opts.forzar && ((await new SettingsRepo(db).get(AJUSTE_FUNCION)) ?? "").trim().toLowerCase() !== "activo") return { ok: false, motivo: "La ejecución automática del botón está apagada." };
  const ya = await db.first<{ x: string | null }>("SELECT json_extract(COALESCE(metadata,'{}'),'$.viabilidad_funcion') AS x FROM conversations WHERE id = ?", [convId]);
  if (ya?.x) return { ok: false, motivo: "El botón ya se ejecutó para este cliente." };
  try {
    await exigirDeMaricela(env, leadId, f, now);
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : "La ficha no es de Maricela." };
  }
  const j = (await zohoGet(env, `/Leads/${esc(leadId)}?fields=Phone,Mobile,Email`, f, now).catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
  const d = j?.data?.[0] ?? {};
  // La función de Zoho hace `replaceAll` sobre Mobile y Telefono y FALLA si alguno viene vacío (16 nov 2026: ficha con móvil y sin teléfono fijo). Si falta uno se usa el otro.
  const movil = String(d["Mobile"] ?? "").trim();
  const fijo = String(d["Phone"] ?? "").trim();
  const correo = String(d["Email"] ?? "").trim();
  if (!correo) return { ok: false, motivo: "La ficha no tiene correo: Zoho no puede enviar el formulario." };
  if (!movil && !fijo) return { ok: false, motivo: "La ficha no tiene teléfono." };
  await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_funcion', ?) WHERE id = ?", [new Date(now).toISOString(), convId]);
  try {
    const r = await ejecutarFuncion(env, FUNCION_FORMULARIO_ZOHO, { id: leadId, Telefono: fijo || movil, Mobile: movil || fijo, email: correo }, f, now);
    // Se guarda un resumen de lo que contestó Zoho (sin datos personales) para poder ver si la función dijo «éxito» o «fallo».
    const respuesta = JSON.stringify(r).replace(/[\w.+-]+@[\w.-]+/g, "[correo]").slice(0, 400);
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_funcion_resp', ?) WHERE id = ?", [respuesta, convId]).catch(() => undefined);
    return { ok: true, respuesta };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message.slice(0, 200) : "No se pudo ejecutar la función de Zoho." };
  }
}

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
  // Zoho genera el enlace unos segundos o minutos después de crear el candidato. NO se espera aquí (14 nov 2026: esperar ~20 s dentro del turno del bot
  // hizo que los clientes que decían «Sí, quiero» quedaran sin respuesta hasta 12 min): una lectura y, si aún no está, queda pendiente para la pasada de 15 min.
  for (let i = 0; i < 1; i++) {
    const j = (await zohoGet(env, `/Leads/${esc(leadId)}?fields=Enlace_corto_Formulario_Consulta_Centrales,Enlace_largo_Formulario_Consulta_Centrales`, f, now).catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
    const d = j?.data?.[0];
    const url = String(d?.["Enlace_corto_Formulario_Consulta_Centrales"] || d?.["Enlace_largo_Formulario_Consulta_Centrales"] || "").trim();
    if (/^https?:\/\//.test(url)) return { ok: true, url };
  }
  // Sin enlace: se hace lo mismo que el botón «Enviar Formulario CC» (si el ajuste está activo) y se vuelve a leer una vez.
  const gen = await generarEnlaceEnZoho(env, convId, leadId, { f, now });
  if (gen.ok) {
    if (f === fetch) await new Promise((r) => setTimeout(r, 3_000));
    const j2 = (await zohoGet(env, `/Leads/${esc(leadId)}?fields=Enlace_corto_Formulario_Consulta_Centrales,Enlace_largo_Formulario_Consulta_Centrales`, f, now).catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
    const d2 = j2?.data?.[0];
    const url2 = String(d2?.["Enlace_corto_Formulario_Consulta_Centrales"] || d2?.["Enlace_largo_Formulario_Consulta_Centrales"] || "").trim();
    if (/^https?:\/\//.test(url2)) return { ok: true, url: url2 };
  }
  return { ok: false, motivo: "Zoho todavía no generó el enlace del formulario.", pendiente: true };
}

/** Marca el envío y deja la nota en Zoho (sin mencionar al bot). */
async function registrarEnvio(env: Env, convId: string, f: FetchFn, now: number): Promise<void> {
  const db = new Db(env.DB);
  await db.run("UPDATE conversations SET metadata = json_remove(json_set(COALESCE(metadata,'{}'),'$.viabilidad_enviada', ?), '$.viabilidad_pendiente') WHERE id = ?", [new Date(now).toISOString(), convId]);
  try {
    const z = (await db.first<{ z: string | null }>("SELECT json_extract(COALESCE(metadata,'{}'),'$.zoho_lead_id') AS z FROM conversations WHERE id = ?", [convId]))?.z;
    if (z && (await escrituraActiva(env))) await crearNota(env, z, `Estudio de viabilidad (${hoyMadrid(now)}): le envié por WhatsApp el enlace del formulario gratuito.`, f, now);
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
      // Se marca PENDIENTE desde el principio: subir al cliente a Zoho y esperar su enlace tarda decenas de segundos y, si el turno se corta a
      // mitad (11 nov 2026: la clienta dijo «Sí, quiero» y no recibió nada), la pasada de cada 15 min igualmente le manda el formulario.
      await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_pendiente', ?) WHERE id = ?", [Date.now(), convId]).catch(() => undefined);
      try {
        const r = await obtenerEnlaceViabilidad(env, convId);
        if (r.ok) {
          await registrarEnvio(env, convId, fetch, Date.now());
          return { ok: true as const, url: r.url, mensajeSugerido: textoViabilidad(r.url) };
        }
        // Sin posibilidad de enviarlo por sí solo (no corresponde, Zoho desconectado…): se quita la marca para que no se reintente en bucle.
        if (!r.pendiente) await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata,'{}'),'$.viabilidad_pendiente') WHERE id = ?", [convId]).catch(() => undefined);
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
    } else if (now - c.p > 20 * 60_000 && !c.aviso) {
      // A los 20 min sin enlace se avisa (antes eran 6 h): con publicidad activa el cliente no puede esperar; Maricela lo envía desde la ficha de Zoho.
      const { notifyCamila } = await import("../src/lib/camila");
      const { urlFichaZoho } = await import("./crm-zohoapi.local");
      const z = (await db.first<{ z: string | null }>("SELECT json_extract(COALESCE(metadata,'{}'),'$.zoho_lead_id') AS z FROM conversations WHERE id = ?", [c.id]))?.z;
      await notifyCamila(env, { heading: "📋 Formulario de viabilidad: envíalo tú", body: `${c.display_name || c.channel_user_id} (+${c.channel_user_id}) aceptó el estudio gratuito pero Zoho todavía no generó su enlace (${r.motivo}). Ábrela en Zoho y pulsa el botón «Enviar Formulario CC» (así se genera su enlace); luego envíaselo por WhatsApp.${z ? `\n${urlFichaZoho(env, z)}` : ""}` }).catch(() => false);
      await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.viabilidad_aviso', ?) WHERE id = ?", [new Date(now).toISOString(), c.id]);
    }
  }
  return n;
}
