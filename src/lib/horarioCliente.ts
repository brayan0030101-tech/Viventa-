/**
 * Horario de contacto del CLIENTE: el bot no le escribe por iniciativa propia (seguimientos, recordatorios,
 * ofertas) de madrugada. «Madrugada» se mide en la hora local de él, no la de España:
 *  1. zona de su ficha (zonaCliente de una cita) o la de su «ciudadResidencia»;
 *  2. si no, el prefijo de su teléfono (WhatsApp);
 *  3. si no se sabe (p. ej. Instagram sin ficha), hora de España, como siempre.
 * Solo aplica a mensajes que el bot inicia; contestar a algo que el cliente acaba de escribir no se frena.
 */
import { Db } from "../db/client";
import { zonaDeResidencia } from "./zonaCliente";

export const HORA_DESDE = 9;
export const HORA_HASTA = 21;
export const ZONA_POR_DEFECTO = "Europe/Madrid";

/** Prefijo internacional → zona. Se prueba del prefijo más largo al más corto. */
const PREFIJOS: Array<[string, string]> = [
  ["34", "Europe/Madrid"],
  ["57", "America/Bogota"],
  ["52", "America/Mexico_City"],
  ["54", "America/Argentina/Buenos_Aires"],
  ["56", "America/Santiago"],
  ["51", "America/Lima"],
  ["593", "America/Guayaquil"],
  ["58", "America/Caracas"],
  ["507", "America/Panama"],
  ["44", "Europe/London"],
  ["351", "Europe/Lisbon"],
  ["353", "Europe/Dublin"],
  ["33", "Europe/Paris"],
  ["39", "Europe/Rome"],
  ["49", "Europe/Berlin"],
  ["41", "Europe/Zurich"],
  ["31", "Europe/Amsterdam"],
  ["32", "Europe/Brussels"],
  ["1", "America/New_York"],
];

export function zonaPorTelefono(canal: string, id: string): string | null {
  if (canal !== "ycloud") return null;
  const d = id.replace(/\D/g, "");
  for (const [p, tz] of [...PREFIJOS].sort((a, b) => b[0].length - a[0].length)) if (d.startsWith(p)) return tz;
  return null;
}

/** Hora (0-23) de un instante en una zona. */
export function horaLocal(now: number, tz: string): number {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(now)));
  return h === 24 ? 0 : h;
}

export const enHorarioDe = (now: number, tz: string): boolean => {
  const h = horaLocal(now, tz);
  return h >= HORA_DESDE && h < HORA_HASTA;
};

/** Zona del cliente de una conversación (ficha → teléfono → España). */
export async function zonaDelCliente(db: Db, conv: { id: string; channel: string; channel_user_id: string }): Promise<string> {
  try {
    const rows = await db.all<{ metadata: string | null }>(
      "SELECT metadata FROM leads WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 5",
      [conv.id],
    );
    for (const r of rows) {
      const m = JSON.parse(r.metadata ?? "{}") as { zonaCliente?: string; ciudadResidencia?: string };
      if (m.zonaCliente) return m.zonaCliente;
      const z = zonaDeResidencia(m.ciudadResidencia);
      if (z) return z.tz;
    }
  } catch {
    /* ficha ilegible: se sigue con el teléfono */
  }
  return zonaPorTelefono(conv.channel, conv.channel_user_id) ?? ZONA_POR_DEFECTO;
}

/** ¿Es buena hora (9-21 h locales) para escribirle a este cliente por iniciativa del bot? */
export async function puedeEscribirAhora(db: Db, conv: { id: string; channel: string; channel_user_id: string }, now = Date.now()): Promise<boolean> {
  return enHorarioDe(now, await zonaDelCliente(db, conv));
}
