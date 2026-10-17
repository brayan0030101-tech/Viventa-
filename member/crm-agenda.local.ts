// member/crm-agenda.local.ts — reglas de agenda de Maricela para las tareas que crea el CRM en Zoho:
//  · sábados y domingos no se asignan tareas (no trabajan);
//  · máximo 25 tareas por día; si el día está lleno, la tarea pasa al día siguiente disponible.
// La fecha que se pide se respeta cuando se puede; si no, se corre al siguiente día hábil con espacio y se avisa por qué.
import type { Env } from "../src/env";
import { coql, duenoZoho, type FetchFn } from "./crm-zohoapi.local";

export const MAX_TAREAS_DIA = 25;
/** Máximo de días que se busca hacia adelante (si no hay hueco en ~2 meses, algo anda mal: se usa el último día probado). */
const TOPE_BUSQUEDA = 60;

export function masDiasAgenda(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export const esFinDeSemana = (fecha: string): boolean => {
  const d = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

const NOMBRE_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const nombreDia = (fecha: string): string => NOMBRE_DIA[new Date(`${fecha}T12:00:00Z`).getUTCDay()]!;

export interface FechaElegida {
  fecha: string;
  /** Vacío si se respetó la fecha pedida; si no, la razón en español. */
  motivo: string;
}

/**
 * Primer día desde `deseada` (nunca antes de `hoy`) que no sea fin de semana y tenga menos de 25 tareas.
 * `contar(fecha)` devuelve cuántas tareas hay ya ese día (se consulta como máximo una vez por fecha).
 */
export async function elegirFecha(deseada: string, hoy: string, contar: (fecha: string) => Promise<number>): Promise<FechaElegida> {
  let f = deseada < hoy ? hoy : deseada;
  const razones: string[] = [];
  if (deseada < hoy) razones.push("esa fecha ya pasó");
  for (let i = 0; i < TOPE_BUSQUEDA; i++) {
    if (esFinDeSemana(f)) {
      if (!razones.some((r) => r.startsWith("cae en fin de semana"))) razones.push(`cae en fin de semana (${nombreDia(f)})`);
      f = masDiasAgenda(f, 1);
      continue;
    }
    const n = await contar(f);
    if (n >= MAX_TAREAS_DIA) {
      razones.push(`el ${nombreDia(f)} ${f} ya tiene ${n} tareas (tope ${MAX_TAREAS_DIA})`);
      f = masDiasAgenda(f, 1);
      continue;
    }
    break;
  }
  return { fecha: f, motivo: f === deseada ? "" : `La pasé del ${deseada} al ${nombreDia(f)} ${f}: ${razones.join("; ")}.` };
}

/** Cuántas tareas de Maricela hay ese día en Zoho (cualquier estado). Zoho entrega hasta 200 por consulta. */
export async function tareasDelDia(env: Env, fecha: string, f?: FetchFn, now = Date.now()): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return 0;
  const dueno = await duenoZoho(env, f, now);
  const filas = await coql(env, `select id from Tasks where (Owner = '${dueno.id}' and Due_Date = '${fecha}') limit 200`, f, now);
  return filas.length;
}

export async function fechaDisponibleZoho(env: Env, deseada: string, hoy: string, f?: FetchFn, now = Date.now()): Promise<FechaElegida> {
  const cache = new Map<string, number>();
  return elegirFecha(deseada, hoy, async (d) => {
    if (!cache.has(d)) cache.set(d, await tareasDelDia(env, d, f, now));
    return cache.get(d)!;
  });
}
