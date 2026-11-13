// member/crm-seguros.local.ts — Oferta de seguros ERGO|DKV de Maricela a los clientes en «Descartado», «Cliente perdido» y «Revisar en el futuro».
// Pedido de Maricela (13 nov 2026, ya confirmó que puede usar su lista). Oferta: 1 mes de seguro gratis (salud, vida, decesos) en nuevas contrataciones con ella.
// Va por una plantilla de Meta (categoría MARKETING) con botones «Quiero información» y «No me interesa» (Meta no permite enlaces directos a WhatsApp en botones: al pulsar «Quiero información» el bot manda el enlace wa.me/34603039032 de Maricela).
// SOLO corre con `viventa_seguros_masivo = activo`, y solo cuando Meta aprobó la plantilla `viventa_tpl_seguros`. De a poco: máx. por día
// (ajuste `viventa_seguros_max_dia`, 10 por defecto) y 3 por pasada; una sola vez por cliente; de 9 a 21 h del cliente; nunca a números de Colombia.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { puedeEscribirAhora } from "../src/lib/horarioCliente";
import { esNumeroColombiano } from "../src/channels/ycloud";
import { enviarACliente } from "../src/followup/sistemaViventa";
import { escrituraActiva, hoyMadrid } from "./crm-seguimientos.local";
import { telefonoInternacional } from "./crm-reactivacion.local";
import { candidatosEnEstado, crearNota, zohoGet, zohoListo, OtraAsesoraError, type FetchFn } from "./crm-zohoapi.local";

export const AJUSTE_SEGUROS = "viventa_seguros_masivo";
export const TPL_SEGUROS = "viventa_tpl_seguros";
export const AJUSTE_MAX_DIA = "viventa_seguros_max_dia";
export const ESTADOS_SEGUROS = ["Descartado", "Cliente perdido", "Revisar en el futuro"];
export const WA_SEGUROS = "https://wa.me/34603039032";
const MAX_POR_PASADA = 3;
const MAX_DIA_DEFECTO = 10;
const DIA = 86_400_000;

/** Texto de la plantilla ({{1}} = nombre). Debe ser EXACTAMENTE el que se manda a aprobar a Meta. */
export const TEXTO_PLANTILLA_SEGUROS =
  "Hola {{1}} 😊, soy Maricela Naranjo. Además de acompañarte con tu proyecto de vivienda en Colombia, trabajo con ERGO|DKV Seguros y quiero ofrecerte un beneficio especial en nuevas contrataciones:\n\n" +
  "🎁 Un mes de seguro gratis\n\n" +
  "🏥 Salud, para cuidar de ti y tu familia\n" +
  "❤️ Vida, para proteger a quienes más quieres\n" +
  "🏡 Decesos, para que tu familia tenga tranquilidad\n\n" +
  "Beneficio exclusivo para nuevas contrataciones gestionadas conmigo.\n\n" +
  "¿Te gustaría conocer las opciones y cuánto te costaría? Pulsa «Quiero información» y te preparo una propuesta sin compromiso.";

/** Si el cliente escribió hace menos de 24 h no hace falta plantilla: sale el mismo texto con el enlace dentro. */
const textoLibre = (nombre: string): string => `${TEXTO_PLANTILLA_SEGUROS.replace(/\{\{1\}\}/g, nombre || "hola")}\n\nEscríbeme aquí y te lo preparo: ${WA_SEGUROS}`;

async function asegurar(db: Db): Promise<void> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS crm_seguros (lead_id TEXT PRIMARY KEY, tel TEXT NOT NULL DEFAULT '', conv_id TEXT NOT NULL DEFAULT '', estado_origen TEXT NOT NULL DEFAULT '', enviado_en INTEGER, resultado TEXT NOT NULL DEFAULT '', aviso INTEGER)",
  );
}

/** Motivos de cierre que NO se contactan (el cliente pidió no ser contactado, número errado o sin datos). Se busca en cualquier campo «motivo» de la ficha. */
export const MOTIVO_EXCLUYE = /no quiere ser contactad|n[uú]mero errado|sin datos de contacto/i;

async function motivoExcluye(env: Env, leadId: string, f?: FetchFn, now?: number): Promise<boolean> {
  try {
    const j = (await zohoGet(env, `/Leads/${leadId}`, f, now)) as { data?: Array<Record<string, unknown>> };
    const d = j.data?.[0] ?? {};
    return Object.entries(d).some(([k, v]) => /motiv|raz[oó]n|reason|descart|perdid/i.test(k) && typeof v === "string" && MOTIVO_EXCLUYE.test(v));
  } catch {
    return true; // ante la duda, no se escribe
  }
}

/** ¿Meta ya aprobó la plantilla? Solo se consulta hasta que sale APPROVED. */
async function plantillaAprobada(env: Env, nombre: string): Promise<boolean> {
  const settings = new SettingsRepo(new Db(env.DB));
  const marca = `${TPL_SEGUROS}_aprobada`;
  if (((await settings.get(marca)) ?? "") === nombre) return true;
  if (!env.YCLOUD_API_KEY) return false;
  try {
    const h = { "X-API-Key": env.YCLOUD_API_KEY };
    const numeros = (await (await fetch("https://api.ycloud.com/v2/whatsapp/phoneNumbers?limit=20", { headers: h })).json()) as { items?: Array<{ phoneNumber?: string; wabaId?: string }> };
    const mio = (numeros.items ?? []).find((n) => String(n.phoneNumber ?? "").replace(/\D/g, "") === (env.YCLOUD_WA_FROM ?? "").replace(/\D/g, "")) ?? numeros.items?.[0];
    if (!mio?.wabaId) return false;
    const t = (await (await fetch(`https://api.ycloud.com/v2/whatsapp/templates?limit=100&filter.wabaId=${encodeURIComponent(mio.wabaId)}`, { headers: h })).json()) as { items?: Array<{ name?: string; status?: string }> };
    const estado = (t.items ?? []).find((x) => x.name === nombre)?.status ?? "";
    if (estado === "APPROVED") {
      await settings.set(marca, nombre);
      await avisar(env, "✅ Meta aprobó la plantilla de seguros", `La plantilla «${nombre}» está APROBADA. El envío empieza cuando el ajuste ${AJUSTE_SEGUROS} esté en «activo» (de a ${MAX_POR_PASADA} por pasada, máx. ${MAX_DIA_DEFECTO} al día).`);
      return true;
    }
    if (/REJECTED|PAUSED|DISABLED/.test(estado)) await avisar(env, "⚠️ Meta NO aprobó la plantilla de seguros", `La plantilla «${nombre}» quedó en estado ${estado}. No se enviará nada hasta crear otra versión del texto.`, estado);
    return false;
  } catch (e) {
    console.error("[seguros] estado de la plantilla:", e);
    return false;
  }
}

async function avisar(env: Env, heading: string, body: string, estado = "aprobada"): Promise<void> {
  try {
    const settings = new SettingsRepo(new Db(env.DB));
    const clave = `${TPL_SEGUROS}_aviso`;
    if (((await settings.get(clave)) ?? "") === estado) return;
    await settings.set(clave, estado);
    const { notifyCamila } = await import("../src/lib/camila");
    await notifyCamila(env, { heading, body }).catch(() => false);
  } catch (e) {
    console.error("[seguros] aviso:", e);
  }
}

export async function runSegurosMasivo(env: Env, now = Date.now(), f?: FetchFn): Promise<{ sent: number; omitidos: number; fallos: number }> {
  const out = { sent: 0, omitidos: 0, fallos: 0 };
  const db = new Db(env.DB);
  const settings = new SettingsRepo(db);
  if (((await settings.get(AJUSTE_SEGUROS)) ?? "").trim().toLowerCase() !== "activo") return out;
  if (!zohoListo(env)) return out;
  const plantilla = ((await settings.get(TPL_SEGUROS)) ?? "").trim();
  if (!plantilla || !(await plantillaAprobada(env, plantilla))) return out;
  await asegurar(db);
  const maxDia = Math.max(1, Number(((await settings.get(AJUSTE_MAX_DIA)) ?? "").trim()) || MAX_DIA_DEFECTO);
  const hoy = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM crm_seguros WHERE enviado_en > ?", [now - DIA]);
  let cupo = Math.min(MAX_POR_PASADA, maxDia - (hoy?.n ?? 0));
  if (cupo <= 0) return out;
  const hechos = new Set((await db.all<{ lead_id: string; tel: string }>("SELECT lead_id, tel FROM crm_seguros")).flatMap((r) => [r.lead_id, r.tel]));
  const convs = new ConversationsRepo(db);
  let seguidosFallidos = 0;
  for (const estado of ESTADOS_SEGUROS) {
    if (cupo <= 0 || seguidosFallidos >= 2) break;
    const lista = await candidatosEnEstado(env, estado, f, now).catch(() => []);
    for (const cand of lista) {
      if (cupo <= 0 || seguidosFallidos >= 2) break;
      if (hechos.has(cand.id)) continue;
      const tel = telefonoInternacional(cand.movil, cand.telefono, cand.pais);
      if (!tel || esNumeroColombiano(tel) || hechos.has(tel)) {
        out.omitidos++;
        continue;
      }
      if (await motivoExcluye(env, cand.id, f, now)) {
        out.omitidos++;
        hechos.add(cand.id);
        continue;
      }
      const conv = await convs.getOrCreate("ycloud", tel, cand.nombre);
      if (conv.taken_by) {
        out.omitidos++;
        continue;
      }
      const ref = { id: conv.id, channel: conv.channel, channel_user_id: conv.channel_user_id, display_name: conv.display_name };
      if (!(await puedeEscribirAhora(db, ref, now))) continue; // madrugada: se reintenta en otra pasada
      const nombre = cand.nombre.split(/\s+/).find((w) => w.replace(/[^\p{L}]/gu, "").length >= 2) ?? "";
      const ult = await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [conv.id]);
      // Se reserva ANTES de enviar: si algo falla a mitad, nunca se le escribe dos veces.
      await db.run("INSERT OR IGNORE INTO crm_seguros (lead_id, tel, conv_id, estado_origen) VALUES (?,?,?,?)", [cand.id, tel, conv.id, estado]);
      hechos.add(cand.id);
      hechos.add(tel);
      try {
        await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_nota_seguimiento', ?) WHERE id = ?", [hoyMadrid(now), conv.id]).catch(() => undefined);
        const via = await enviarACliente(env, db, ref, textoLibre(nombre), { setting: TPL_SEGUROS, params: [nombre || "hola"] }, ult?.t ?? null, now);
        await new MessagesRepo(db).append(
          conv.id,
          "note",
          `Oferta de seguros (ERGO|DKV, 1 mes gratis) enviada ${via === "plantilla" ? "con la plantilla" : "como texto"} a un cliente que estaba en «${estado}». Esto NO es sobre vivienda. Si pulsa «Quiero información» o responde con interés en seguros, contéstale en UN mensaje corto: dile que Maricela le atiende directamente y que le escriba aquí ${WA_SEGUROS}, y llama handoffHuman con el motivo "Interesado en seguros" (sin hablar de vivienda ni de precios). Si dice que no le interesa o pulsa «No me interesa», agradécele en una frase amable, no insistas y no le ofrezcas nada más.`,
        );
        await db.run("UPDATE crm_seguros SET enviado_en = ? WHERE lead_id = ?", [now, cand.id]);
        out.sent++;
        cupo--;
        seguidosFallidos = 0;
        if (await escrituraActiva(env)) {
          await crearNota(env, cand.id, `Oferta de seguros ERGO|DKV por WhatsApp (${hoyMadrid(now)}): se le escribió ofreciendo 1 mes de seguro gratis.`, f, now).catch((e) => {
            if (!(e instanceof OtraAsesoraError)) console.error("[seguros] nota Zoho:", e);
          });
        }
      } catch (e) {
        console.error("[seguros] envío:", e instanceof Error ? e.message : e);
        await db.run("UPDATE crm_seguros SET resultado = 'fallo' WHERE lead_id = ? AND enviado_en IS NULL", [cand.id]);
        out.fallos++;
        seguidosFallidos++;
      }
    }
  }
  return out;
}

/** Cada pasada: quien pulsó «No me interesa» queda marcado (no se le escribe más) y a Maricela se le avisa, una vez, de quien responde con interés. */
export async function runRespuestasSeguros(env: Env, now = Date.now()): Promise<number> {
  const db = new Db(env.DB);
  const ok = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='crm_seguros'");
  if (!ok?.n) return 0;
  const filas = await db.all<{ lead_id: string; conv_id: string; enviado_en: number }>("SELECT lead_id, conv_id, enviado_en FROM crm_seguros WHERE enviado_en > ? AND resultado = ''", [now - 30 * DIA]);
  let n = 0;
  for (const r of filas) {
    const resp = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ? ORDER BY created_at ASC LIMIT 1", [r.conv_id, r.enviado_en]);
    if (!resp) continue;
    const no = /no me interesa|no,? gracias|no quiero|no me (escrib|contact)/i.test(resp.content);
    await db.run("UPDATE crm_seguros SET resultado = ? WHERE lead_id = ?", [no ? "no_interesa" : "respondio", r.lead_id]);
    if (no) {
      await new MessagesRepo(db).append(r.conv_id, "note", "El cliente dijo que NO le interesa la oferta de seguros: no escribirle más ofertas.");
      continue;
    }
    n++;
    try {
      const { notifyCamila } = await import("../src/lib/camila");
      await notifyCamila(env, { heading: "🛡️ Respondió a la oferta de seguros", body: `Un cliente respondió a la oferta de seguros ERGO|DKV: «${resp.content.slice(0, 200)}». Mira la conversación en el CRM.` }).catch(() => false);
    } catch (e) {
      console.error("[seguros] aviso respuesta:", e);
    }
  }
  return n;
}
