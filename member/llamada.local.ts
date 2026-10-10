// member/llamada.local.ts — oferta de videollamada con Maricela para clientes
// calientes o tibios. Vive en member/ (el `forjabot update` no la pisa).
//
// La tool `proponerLlamada` decide SI toca ofrecer la llamada (prioridad del
// cliente) y, de ser así, devuelve hasta 6 horarios reales de Cal.com: 2 por día
// en los próximos 3 días hábiles, de 10:00 a 16:00 (hora de España, llamadas de
// 30 min). Reservar lo hace agendarCita; si ninguno le sirve, el bot usa el
// comodín (reglas en las instrucciones del bot).
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { calcomConfigured, calcomTimeZone, getAvailableSlotsRange, resolveEventTypeId } from "../src/integrations/calcom";
import { armarLeads, llamadasAgendadas, formatoLlamada } from "../src/followup/resumenDia";

const H = 3600_000;
/** Primer inicio permitido y último inicio (la llamada dura 30 min: termina a las 16:00). */
const DESDE = "10:00";
const HASTA = "15:30";
const MAX_DIAS = 3;
export const DURACION_LLAMADA_MIN = 30;

const DIAS = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long" });

export interface OpcionLlamada {
  fecha: string;
  dia: string;
  hora: string;
  startTime: string;
}

function esDiaHabil(fecha: string): boolean {
  const d = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
}

function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Elige hasta 2 horarios por día (uno de mañana y otro de tarde) en los primeros
 * `MAX_DIAS` días hábiles con huecos, ignorando lo que queda a menos de 2 h.
 */
export function elegirOpciones(byDate: Record<string, string[]>, now: number): OpcionLlamada[] {
  const out: OpcionLlamada[] = [];
  let dias = 0;
  for (const fecha of Object.keys(byDate).sort()) {
    if (dias >= MAX_DIAS) break;
    if (!esDiaHabil(fecha)) continue;
    const validos = (byDate[fecha] ?? [])
      .filter((iso) => {
        const hh = iso.slice(11, 16);
        return hh >= DESDE && hh <= HASTA && Date.parse(iso) - now >= 2 * H;
      })
      .sort();
    if (!validos.length) continue;
    const manana = validos.find((iso) => iso.slice(11, 16) < "13:00") ?? validos[0];
    const tarde = validos.find((iso) => iso.slice(11, 16) >= "13:00" && iso !== manana);
    for (const iso of [manana, tarde]) {
      if (iso) out.push({ fecha, dia: DIAS.format(new Date(iso)), hora: iso.slice(11, 16), startTime: iso });
    }
    dias++;
  }
  return out;
}

export function proponerLlamadaTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Úsala UNA vez, justo después de guardar con captureLead los datos del cliente al terminar el guion. Dice si al cliente le toca que se le ofrezca una videollamada con Maricela (clientes calientes o tibios) y, si es así, devuelve los horarios libres reales (hora de España, llamadas de 30 min) para ofrecérselos. Si ofrecerLlamada es false, cierra con el mensaje normal de despedida.",
    inputSchema: z.object({}),
    execute: async () => {
      const convId = getConversationId();
      if (!convId) return { ofrecerLlamada: false as const, motivo: "sin_conversacion" };
      const db = new Db(env.DB);
      const now = Date.now();
      try {
        const convs = await db.all<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number }>(
          "SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations WHERE id = ?",
          [convId],
        );
        const leads = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
          "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
          [convId],
        );
        const llamadas = await llamadasAgendadas(db, now);
        const [lead] = armarLeads(convs, leads, llamadas);
        if (!lead) return { ofrecerLlamada: false as const, motivo: "sin_ficha" };
        if (lead.llamada) {
          return { ofrecerLlamada: false as const, motivo: "ya_tiene_llamada", llamada: lead.llamada };
        }
        const nivel = lead.prioridad.nivel;
        if (nivel === "frio") return { ofrecerLlamada: false as const, prioridad: nivel };

        if (!calcomConfigured(env)) return { ofrecerLlamada: false as const, motivo: "agenda_no_configurada" };
        const eventTypeId = resolveEventTypeId(env, "Videollamada Viventa");
        if (!eventTypeId) return { ofrecerLlamada: false as const, motivo: "sin_tipo_de_evento" };
        const tz = calcomTimeZone(env);
        const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
        const res = await getAvailableSlotsRange(env, eventTypeId, hoy, sumarDias(hoy, 6), tz);
        if (!res.ok) return { ofrecerLlamada: true as const, prioridad: nivel, opciones: [], error: res.reason, message: "No pude consultar la agenda: usa el comodín para que Maricela coordine la llamada." };

        const opciones = elegirOpciones(res.byDate, now);
        return {
          ofrecerLlamada: true as const,
          prioridad: nivel,
          timeZone: tz,
          duracionMin: DURACION_LLAMADA_MIN,
          necesitaCorreo: !lead.correo,
          correoDelCliente: lead.correo || undefined,
          telefono: lead.telefono || undefined,
          opciones,
          message: opciones.length
            ? "Ofrece estas opciones en UN solo mensaje, diciendo 'hora de España'."
            : "No hay huecos en los próximos días: usa el comodín para que Maricela coordine la llamada.",
        };
      } catch (e) {
        console.error("[proponerLlamada]", e);
        return { ofrecerLlamada: false as const, motivo: "error" };
      }
    },
  });
}

export { formatoLlamada };
