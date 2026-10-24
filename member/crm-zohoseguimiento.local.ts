// member/crm-zohoseguimiento.local.ts — regla de Maricela: cada vez que se vuelve a contactar a un cliente que ya está en Zoho
// (seguimiento, retomar, recordatorio, cotización…) queda una nota en su ficha de Zoho. La nota NO dice «bot»: se escribe como
// un seguimiento normal. Máximo una nota por cliente y día, y nunca interrumpe el envío (si algo falla, solo se registra).
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { OtraAsesoraError, buscarCandidato, crearNota, zohoListo } from "./crm-zohoapi.local";
import { escrituraActiva, hoyMadrid } from "./crm-seguimientos.local";

const NOMBRE_CANAL: Record<string, string> = { ycloud: "WhatsApp", zernio: "Instagram", kapso: "WhatsApp" };

export function textoNotaSeguimiento(canal: string, mensaje: string, hoy: string): string {
  const medio = NOMBRE_CANAL[canal] ?? "mensaje";
  const lim = mensaje.replace(/\s+/g, " ").trim().slice(0, 300);
  return `Seguimiento (${hoy}): se le volvió a escribir por ${medio}${lim ? `. Mensaje: «${lim}»` : " para retomar el contacto"}.`;
}

/** Id del candidato en Zoho de esta conversación: el guardado, o (si ya figura como registrado) se busca por correo/teléfono y se guarda. */
async function leadIdDe(env: Env, db: Db, convId: string, buscarSiempre = false): Promise<string> {
  const c = await db.first<{ channel: string; channel_user_id: string; z: string | null; reg: string | null; exi: string | null }>(
    "SELECT channel, channel_user_id, json_extract(metadata,'$.zoho_lead_id') AS z, json_extract(metadata,'$.viventa_registrado') AS reg, json_extract(metadata,'$.viventa_existente') AS exi FROM conversations WHERE id = ?",
    [convId],
  );
  if (!c) return "";
  if (c.z && /^\d{6,30}$/.test(c.z)) return c.z;
  const hoy = hoyMadrid(Date.now());
  const noEnc = await db.first<{ d: string | null }>("SELECT json_extract(metadata,'$.zoho_no_encontrado') AS d FROM conversations WHERE id = ?", [convId]);
  if (noEnc?.d === hoy && !buscarSiempre) return ""; // ya se buscó hoy y no está en Zoho
  const leads = await db.all<{ contact: string | null }>("SELECT contact FROM leads WHERE conversation_id = ?", [convId]).catch(() => []);
  const contactos = leads.map((l) => l.contact ?? "").join(" ");
  const correos = contactos.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g) ?? [];
  const tel = c.channel === "ycloud" ? c.channel_user_id : (contactos.match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? "");
  const cand = await buscarCandidato(env, { correos, telefono: tel });
  if (!cand?.id) {
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_no_encontrado', ?) WHERE id = ?", [hoy, convId]);
    return "";
  }
  await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_lead_id', ?) WHERE id = ?", [cand.id, convId]);
  return cand.id;
}

/** Deja la nota de seguimiento en Zoho. Devuelve true si la creó. No lanza nunca. */
export async function notaSeguimientoZoho(env: Env, convId: string, canal: string, mensaje: string, now = Date.now()): Promise<boolean> {
  try {
    if (!zohoListo(env) || !(await escrituraActiva(env))) return false;
    const db = new Db(env.DB);
    const hoy = hoyMadrid(now);
    const ya = await db.first<{ d: string | null }>("SELECT json_extract(metadata,'$.zoho_nota_seguimiento') AS d FROM conversations WHERE id = ?", [convId]);
    if (!ya || ya.d === hoy) return false;
    // Cualquier cliente que ya esté en Zoho (aunque lo haya subido Maricela a mano) recibe la nota: se busca por teléfono/correo.
    const leadId = await leadIdDe(env, db, convId);
    if (!leadId) return false;
    try {
      await crearNota(env, leadId, textoNotaSeguimiento(canal, mensaje, hoy), undefined, now);
    } catch (e) {
      // Regla de Maricela: si el cliente no está a su nombre no se deja nota (y no se vuelve a intentar hoy).
      if (e instanceof OtraAsesoraError) {
        await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_nota_seguimiento', ?) WHERE id = ?", [hoy, convId]);
        return false;
      }
      throw e;
    }
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_nota_seguimiento', ?) WHERE id = ?", [hoy, convId]);
    return true;
  } catch (e) {
    console.error("[notaSeguimientoZoho]", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Para el botón «Abrir en Zoho»: id del candidato de esa conversación (busca por correo/teléfono si aún no se conoce). */
export async function leadZohoDeConversacion(env: Env, convId: string): Promise<string> {
  try {
    if (!zohoListo(env)) return "";
    return await leadIdDe(env, new Db(env.DB), convId, true);
  } catch (e) {
    console.error("[leadZohoDeConversacion]", e instanceof Error ? e.message : e);
    return "";
  }
}
