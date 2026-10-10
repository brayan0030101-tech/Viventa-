// member/llamada.local.ts — oferta de videollamada con Maricela para clientes
// calientes o tibios. Vive en member/ (el `forjabot update` no la pisa).
//
// La tool `proponerLlamada` decide SI toca ofrecer la llamada (prioridad del
// cliente) y, de ser así, devuelve hasta 12 horarios reales de Cal.com: 4 por día
// en los próximos 3 días hábiles, de 10:00 a 16:00 (hora de España, llamadas de
// 30 min). Reservar lo hace agendarCita; si ninguno le sirve, el bot usa el
// comodín (reglas en las instrucciones del bot).
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { calcomConfigured, calcomTimeZone, getAvailableSlotsRange, getUpcomingBookingStarts, resolveEventTypeId } from "../src/integrations/calcom";
import { armarLeads, llamadasAgendadas, formatoLlamada } from "../src/followup/resumenDia";

const H = 3600_000;
/** Primer inicio permitido y último inicio (la llamada dura 30 min: termina a las 16:00). */
const DESDE = "10:00";
const HASTA = "15:30";
const MAX_DIAS = 5;
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

const DIA_CORTO = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short" });

/** Título de botón del día (≤ 20 caracteres): «Lun 12 oct». */
export function botonDia(iso: string): string {
  const t = DIA_CORTO.format(new Date(iso)).replace(/\./g, "").replace(",", "");
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 20);
}

/** Hasta 3 horas repartidas (el máximo de botones) para el paso «elige hora». */
export function botonesHoras(opciones: Array<{ hora: string }>): string[] {
  const n = opciones.length;
  const idx = n <= 3 ? opciones.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  return [...new Set(idx)].map((i) => opciones[i].hora);
}

/** Marcadores de botones con MÁS horas del mismo día (3 por tanda, sin repetir las ya mostradas). */
export function tandasMasHoras(libres: Array<{ hora: string }>, yaMostradas: string[], maxTandas = 3): string[] {
  const resto = libres.map((l) => l.hora).filter((h) => !yaMostradas.includes(h));
  const out: string[] = [];
  for (let i = 0; i < resto.length && out.length < maxTandas; i += 3) out.push(`[[botones: ${resto.slice(i, i + 3).join(" | ")}]]`);
  return out;
}

const POR_DIA = 4;
const MAX_TACHADOS_POR_DIA = 2;

/** «13:00» → «1̶3̶:̶0̶0̶»: texto tachado que se ve igual en WhatsApp e Instagram. */
export function tachar(hhmm: string): string {
  return [...hhmm].map((c) => `${c}\u0336`).join("");
}

/** Reparte hasta `n` horarios a lo largo del día (no los primeros pegados). */
function repartir<T>(lista: T[], n: number): T[] {
  if (lista.length <= n) return lista;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(lista[Math.round((i * (lista.length - 1)) / (n - 1))]);
  return out;
}

export interface DiaLlamada {
  fecha: string;
  dia: string;
  opciones: OpcionLlamada[];
  /** TODOS los horarios libres de ese día (para «ver más horarios»). */
  libres: OpcionLlamada[];
  /** Horas de ese día que YA tienen una llamada reservada por otro cliente (reales). */
  ocupadas: string[];
  /** Línea lista para el mensaje: libres normales, ocupadas tachadas. */
  linea: string;
}

/**
 * Elige hasta 4 horarios por día en los primeros `MAX_DIAS` días hábiles con huecos
 * (de 10:00 a 15:30, ignorando lo que queda a menos de 2 h) y añade, tachadas, las
 * horas de ese día que ya están reservadas DE VERDAD en Cal.com (máx. 2 por día).
 * Nunca se inventan horarios ocupados.
 */
export interface VentanaHorario {
  desde: string;
  hasta: string;
  /** Cuántos días distintos puede llegar a ofrecer (los 3 primeros con botones, el resto con «otro día»). */
  maxDias: number;
  dia: (fecha: string) => boolean;
}

/** Horario de día: lunes a viernes, de 10:00 a 15:30 (hora de España). */
export const VENTANA_DIA: VentanaHorario = { desde: DESDE, hasta: HASTA, maxDias: MAX_DIAS, dia: esDiaHabil };

/** Horario nocturno (solo martes y jueves, de 18:00 a 19:30): para quien no puede de día. */
export const VENTANA_NOCHE: VentanaHorario = {
  desde: "18:00",
  hasta: "19:30",
  maxDias: 4,
  dia: (fecha) => {
    const d = new Date(`${fecha}T12:00:00Z`).getUTCDay();
    return d === 2 || d === 4;
  },
};

export function armarDias(
  byDate: Record<string, string[]>,
  reservadas: Array<{ fecha: string; hora: string }>,
  now: number,
  ventana: VentanaHorario = VENTANA_DIA,
): DiaLlamada[] {
  const out: DiaLlamada[] = [];
  for (const fecha of Object.keys(byDate).sort()) {
    if (out.length >= ventana.maxDias) break;
    if (!ventana.dia(fecha)) continue;
    const validos = (byDate[fecha] ?? [])
      .filter((iso) => {
        const hh = iso.slice(11, 16);
        return hh >= ventana.desde && hh <= ventana.hasta && Date.parse(iso) - now >= 2 * H;
      })
      .sort();
    if (!validos.length) continue;
    const opciones: OpcionLlamada[] = repartir(validos, POR_DIA).map((iso) => ({
      fecha, dia: DIAS.format(new Date(iso)), hora: iso.slice(11, 16), startTime: iso,
    }));
    const todos: OpcionLlamada[] = validos.map((iso) => ({ fecha, dia: DIAS.format(new Date(iso)), hora: iso.slice(11, 16), startTime: iso }));
    const libres = new Set(validos.map((iso) => iso.slice(11, 16)));
    const ocupadas = [...new Set(reservadas.filter((r) => r.fecha === fecha && r.hora >= ventana.desde && r.hora <= ventana.hasta && !libres.has(r.hora)).map((r) => r.hora))]
      .sort()
      .slice(0, MAX_TACHADOS_POR_DIA);
    const items = [...opciones.map((o) => ({ hora: o.hora, ocupada: false })), ...ocupadas.map((h) => ({ hora: h, ocupada: true }))].sort((x, y) => (x.hora < y.hora ? -1 : 1));
    out.push({
      fecha, dia: opciones[0].dia, opciones, libres: todos, ocupadas,
      linea: `${opciones[0].dia}: ${items.map((i) => (i.ocupada ? tachar(i.hora) : i.hora)).join(" · ")}`,
    });
  }
  return out;
}

/** Compatibilidad: solo los horarios libres elegidos, en una lista plana. */
export function elegirOpciones(byDate: Record<string, string[]>, now: number): OpcionLlamada[] {
  return armarDias(byDate, [], now).flatMap((d) => d.opciones);
}

const FECHA_HORA_ES = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function aFechaHoraMadrid(iso: string): { fecha: string; hora: string } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(FECHA_HORA_ES.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}` };
}

export function proponerLlamadaTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Úsala UNA vez, justo después de guardar con captureLead los datos del cliente al terminar el guion. Dice si al cliente le toca que se le ofrezca una videollamada con Maricela (clientes calientes o tibios) y, si es así, devuelve los horarios libres reales (hora de España, llamadas de 30 min) para ofrecérselos. Si ofrecerLlamada es false, cierra con el mensaje normal de despedida. Si el cliente dice que no puede de día, vuelve a llamarla con horario «noche».",
    inputSchema: z.object({
      horario: z
        .enum(["dia", "noche"])
        .optional()
        .describe("«dia» (por defecto) o «noche»: solo si el cliente dice que no puede de día (martes y jueves, 18:00 a 20:00)."),
    }),
    execute: async ({ horario }) => {
      const ventana = horario === "noche" ? VENTANA_NOCHE : VENTANA_DIA;
      const convId = getConversationId();
      if (!convId) return { ofrecerLlamada: false as const, motivo: "sin_conversacion" };
      const db = new Db(env.DB);
      const now = Date.now();
      try {
        // Interruptor (en la base de datos, sin desplegar): viventa_llamada_modo =
        // «activo» (todos los calientes/tibios), «prueba» (solo las conversaciones de
        // viventa_llamada_ids, separadas por coma) o cualquier otra cosa = apagado.
        const settings = new SettingsRepo(db);
        const modo = ((await settings.get("viventa_llamada_modo")) ?? "").trim().toLowerCase();
        if (modo !== "activo") {
          const ids = ((await settings.get("viventa_llamada_ids")) ?? "").split(/[,;\s]+/).filter(Boolean);
          const esPrueba = modo === "prueba" && ids.some((x) => convId === x || convId.endsWith(`:${x.replace(/^\+/, "")}`));
          if (!esPrueba) return { ofrecerLlamada: false as const, motivo: "apagado" };
        }
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
        const res = await getAvailableSlotsRange(env, eventTypeId, hoy, sumarDias(hoy, horario === "noche" ? 24 : 10), tz);
        if (!res.ok) return { ofrecerLlamada: true as const, prioridad: nivel, opciones: [], error: res.reason, message: "No pude consultar la agenda: usa el comodín para que Maricela coordine la llamada." };

        const bk = await getUpcomingBookingStarts(env, eventTypeId);
        const reservadas = bk.ok ? bk.starts.map(aFechaHoraMadrid).filter((x): x is { fecha: string; hora: string } => !!x) : [];
        const dias = armarDias(res.byDate, reservadas, now, ventana);
        const opciones = dias.flatMap((d) => d.opciones);
        return {
          ofrecerLlamada: true as const,
          prioridad: nivel,
          timeZone: tz,
          duracionMin: DURACION_LLAMADA_MIN,
          necesitaCorreo: !lead.correo,
          correoDelCliente: lead.correo || undefined,
          telefono: lead.telefono || undefined,
          dias: dias.map((d) => ({
            dia: d.dia,
            boton: botonDia(d.opciones[0].startTime),
            linea: d.linea,
            marcadorHoras: `[[botones: ${botonesHoras(d.opciones).join(" | ")}]]`,
            masHoras: tandasMasHoras(d.libres, botonesHoras(d.opciones)),
            opciones: d.libres.map((o) => ({ hora: o.hora, startTime: o.startTime })),
          })),
          marcadorDias: `[[botones: ${dias.slice(0, 3).map((d) => botonDia(d.opciones[0].startTime)).join(" | ")}]]`,
          // Días 4 y 5 (solo si el cliente pide «otro día» y ya vio los primeros).
          ...(dias.length > 3 ? { marcadorMasDias: `[[botones: ${dias.slice(3, 6).map((d) => botonDia(d.opciones[0].startTime)).join(" | ")}]]` } : {}),
          opciones,
          message: opciones.length
            ? "Paso 1: pregunta qué día le queda mejor y termina con `marcadorDias` tal cual. Paso 2 (cuando elija día): muestra la `linea` de ese día tal cual (los tachados YA están ocupados: no los ofrezcas), añade «Si necesitas más horarios, házmelo saber» y termina con el `marcadorHoras` de ese día. Si pide ver más horarios, envía la siguiente tanda de `masHoras` de ese día (una por vez). Si pide otro día, repite el paso 2 con ese día; si no dice cuál y existe `marcadorMasDias`, envíalo (son más días con horarios). Siempre 'hora de España'."
            : horario === "noche"
              ? "No hay horarios nocturnos libres: usa el comodín para que Maricela coordine la llamada."
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
