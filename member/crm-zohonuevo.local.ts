// member/crm-zohonuevo.local.ts — CRM de Viventa: «Nota y tarea del candidato nuevo» en Zoho.
// Cuando Maricela sube un cliente a Zoho (pestaña «Subidos»), un botón busca ese candidato en Zoho (por correo o teléfono) y le crea:
//  · la NOTA (mini resumen que ya genera el CRM) y · la TAREA (videollamada programada en la fecha de la llamada, o seguimiento al siguiente
//  día hábil con espacio: sin sábados ni domingos y máximo 25 por día). Cada paso se hace una sola vez por cliente (no duplica al reintentar).
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { armarLeads } from "../src/followup/resumenDia";
import { esc } from "./crm.local";
import { notaZoho } from "./crm-zohonota.local";
import { fechaDisponibleZoho, nombreDia } from "./crm-agenda.local";
import { buscarCandidato, crearNota, crearTarea, duenoZoho, zohoListo, ZohoError, type FetchFn } from "./crm-zohoapi.local";
import { escrituraActiva, hoyMadrid, masDias } from "./crm-seguimientos.local";

async function asegurar(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_zoho_nuevo (
       conversation_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, nota_id TEXT NOT NULL DEFAULT '', tarea_id TEXT NOT NULL DEFAULT '',
       tarea_asunto TEXT NOT NULL DEFAULT '', tarea_fecha TEXT NOT NULL DEFAULT '', creado INTEGER NOT NULL
     )`,
  );
}

export type ResultadoNuevo =
  | { ok: true; yaHecho: boolean; asunto: string; fecha: string; ajuste: string; candidato: string }
  | { ok: false; error: string };

export async function crearNotaYTarea(env: Env, convId: string, opts: { f?: FetchFn } = {}, now = Date.now()): Promise<ResultadoNuevo> {
  if (!zohoListo(env)) return { ok: false, error: "Zoho todavía no está conectado." };
  if (!(await escrituraActiva(env))) return { ok: false, error: "Zoho está en modo solo lectura. Avísale a Brayan para activar la escritura." };
  const db = new Db(env.DB);
  await asegurar(db);
  const previo = await db.first<{ lead_id: string; nota_id: string; tarea_id: string; tarea_asunto: string; tarea_fecha: string }>("SELECT * FROM crm_zoho_nuevo WHERE conversation_id = ?", [convId]);
  if (previo?.nota_id && previo.tarea_id) return { ok: true, yaHecho: true, asunto: previo.tarea_asunto, fecha: previo.tarea_fecha, ajuste: "", candidato: "" };

  const conv = await db.first<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations WHERE id = ?",
    [convId],
  );
  if (!conv) return { ok: false, error: "No encontré a ese cliente." };
  const leadsRows = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
    "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
    [convId],
  );
  const [lead] = armarLeads([conv], leadsRows);
  if (!lead) return { ok: false, error: "Ese cliente no tiene ficha." };

  try {
    let leadId = previo?.lead_id ?? "";
    let candidato = "";
    if (!leadId) {
      const c = await buscarCandidato(env, { correos: lead.correo.split(","), telefono: lead.telefono }, opts.f, now);
      if (!c) return { ok: false, error: "No encuentro a este cliente en Zoho (busqué por correo y por teléfono). Súbelo primero y vuelve a intentarlo." };
      leadId = c.id;
      candidato = c.nombre;
      await db.run("INSERT OR REPLACE INTO crm_zoho_nuevo (conversation_id, lead_id, creado) VALUES (?,?,?)", [convId, leadId, now]);
    }
    const n = await notaZoho(env, convId, {}, now);
    if (!n.ok) return { ok: false, error: n.error };
    const hoy = hoyMadrid(now);

    // Fecha: si hay videollamada agendada, el día de la llamada; si no, seguimiento mañana (corrido a día hábil con espacio).
    const { cargarLlamadas } = await import("./crm-calendario.local");
    const futura = (await cargarLlamadas(env, now)).filter((l) => l.convId === convId && l.estado === "agendada").sort((a, b) => a.inicio - b.inicio)[0];
    const asunto = (n.nota.cuando ? `${n.nota.tarea} — ${n.nota.cuando}` : n.nota.tarea).replace(/\s+/g, " ").trim().slice(0, 200);
    let fecha: string;
    let ajuste = "";
    if (futura) {
      fecha = hoyMadrid(futura.inicio);
    } else {
      const d = await fechaDisponibleZoho(env, masDias(hoy, 1), hoy, opts.f, now);
      fecha = d.fecha;
      ajuste = d.motivo;
    }

    let notaId = previo?.nota_id ?? "";
    if (!notaId) {
      notaId = (await crearNota(env, leadId, n.nota.nota, opts.f, now)) || "ok";
      await db.run("UPDATE crm_zoho_nuevo SET nota_id = ? WHERE conversation_id = ?", [notaId, convId]);
    }
    let tareaId = previo?.tarea_id ?? "";
    if (!tareaId) {
      const dueno = await duenoZoho(env, opts.f, now);
      tareaId = (await crearTarea(env, { leadId, asunto, fecha, ownerId: dueno.id }, opts.f, now)) || "ok";
      await db.run("UPDATE crm_zoho_nuevo SET tarea_id = ?, tarea_asunto = ?, tarea_fecha = ? WHERE conversation_id = ?", [tareaId, asunto, fecha, convId]);
    }
    return { ok: true, yaHecho: false, asunto, fecha, ajuste, candidato };
  } catch (e) {
    console.error("[crm-zohonuevo]", e);
    return { ok: false, error: `${e instanceof ZohoError ? e.message : "No pude hablar con Zoho."} Lo que ya se creó no se repite si vuelves a intentar.` };
  }
}

export async function fragmentoNuevo(env: Env, convId: string, now = Date.now(), f?: FetchFn): Promise<string> {
  const r = await crearNotaYTarea(env, convId, { f }, now);
  if (!r.ok) return `<div style="color:var(--bad);font-size:11.5px;margin-top:4px">${esc(r.error)}</div>`;
  return `<div style="color:var(--ok);font-size:11.5px;margin-top:4px">✔ ${r.yaHecho ? "Ya estaban creadas" : "Listo en Zoho"}${r.candidato ? ` (${esc(r.candidato)})` : ""}: nota y tarea «${esc(r.asunto)}» para el ${esc(nombreDia(r.fecha))} ${esc(r.fecha)}.${r.ajuste ? ` <b>${esc(r.ajuste)}</b>` : ""}</div>`;
}
