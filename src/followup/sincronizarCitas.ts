/**
 * Mantiene las videollamadas del bot al día con Cal.com (Maricela, 20 nov 2026):
 *  · si una cita se CANCELA (por Maricela, por el cliente o por el bot) no se le manda ningún recordatorio;
 *  · si se REPROGRAMA (la reserva nueva trae `rescheduledFromUid` de la vieja, o la misma reserva cambia de hora) los recordatorios pasan a la NUEVA fecha:
 *    se actualiza la cita (fecha, hora, enlace) y se borran las marcas de recordatorio para que el de 24 h y el de 1 h salgan para la fecha nueva.
 * Solo se consulta Cal.com si hay citas vigentes en los próximos 14 días. Cualquier duda (error de red, respuesta rara) = no se toca nada.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { botTimezone } from "../time/dateAnchor";
import { detalleReserva, reservasProximas, type ReservaCal } from "../integrations/calcom";
import { camilaConfigured, notifyCamila } from "../lib/camila";

const H = 3_600_000;

interface CitaVigente {
  id: string;
  name: string | null;
  intent: string;
  metadata: string | null;
}

const fechaHora = (iso: string, tz: string): { fecha: string; hora: string } => {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const h = new Intl.DateTimeFormat("es-ES", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { fecha: f, hora: h };
};

const dicho = (iso: string, tz: string): string => {
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d).replace(",", "")} a las ${fechaHora(iso, tz).hora}`;
};

async function avisar(env: Env, heading: string, body: string): Promise<void> {
  try {
    if (camilaConfigured(env)) await notifyCamila(env, { heading, body });
  } catch (e) {
    console.error("[sincronizarCitas] aviso:", e);
  }
}

export async function sincronizarCitas(env: Env, now = Date.now()): Promise<{ canceladas: number; reprogramadas: number }> {
  const out = { canceladas: 0, reprogramadas: 0 };
  if (!env.CALCOM_API_KEY) return out;
  const db = new Db(env.DB);
  const tz = botTimezone(env);
  const citas = await db.all<CitaVigente>(
    `SELECT id, name, intent, metadata FROM leads
      WHERE intent LIKE 'Cita ·%'
        AND json_extract(COALESCE(metadata, '{}'), '$.estado') = 'Reservada (Cal.com)'
        AND json_extract(COALESCE(metadata, '{}'), '$.calBookingUid') IS NOT NULL
        AND json_extract(COALESCE(metadata, '{}'), '$.calStart') IS NOT NULL
        AND created_at > ?`,
    [now - 45 * 24 * H],
  );
  const vigentes = citas.filter((c) => {
    try {
      const inicio = Date.parse(String((JSON.parse(c.metadata ?? "{}") as Record<string, string>).calStart ?? ""));
      return Number.isFinite(inicio) && inicio > now - 2 * H && inicio < now + 14 * 24 * H;
    } catch {
      return false;
    }
  });
  if (!vigentes.length) return out;

  const prox = await reservasProximas(env, 100);
  const proximas: ReservaCal[] = prox.ok ? prox.reservas : [];
  const yaSeguidas = new Set(citas.map((c) => String((JSON.parse(c.metadata ?? "{}") as Record<string, string>).calBookingUid ?? "")));

  for (const c of vigentes) {
    const meta = JSON.parse(c.metadata ?? "{}") as Record<string, string>;
    const uid = String(meta.calBookingUid);
    const d = await detalleReserva(env, uid);
    let actual: ReservaCal | null = null;
    if (d.ok) actual = d.reserva;
    else if (d.reason !== "not_found") continue; // error pasajero: no se toca nada
    const cancelada = !actual || /cancel|reject/.test(actual.status);
    const nombre = (c.name ?? "").split(/\s+/)[0] || "el cliente";

    // La misma reserva cambió de hora (reprogramada sin crear otra).
    if (actual && !cancelada) {
      if (Math.abs(Date.parse(actual.start) - Date.parse(meta.calStart)) < 60_000) continue;
      await mover(db, c, meta, actual, tz);
      out.reprogramadas++;
      await avisar(env, "📅 Videollamada reprogramada", `La videollamada de ${nombre} pasó a ${dicho(actual.start, tz)} (hora de España). Los recordatorios van a la fecha nueva.`);
      continue;
    }

    // Cancelada: ¿se reprogramó (hay una reserva nueva que viene de esta)? Si no, se cancela de verdad.
    const emailsViejos = new Set([...(actual?.emails ?? [])]);
    const nueva =
      proximas.find((r) => r.rescheduledFromUid === uid && /accept|pend/.test(r.status || "accepted")) ??
      (actual?.rescheduledToUid ? proximas.find((r) => r.uid === actual!.rescheduledToUid) : undefined) ??
      (emailsViejos.size ? proximas.find((r) => r.uid !== uid && !yaSeguidas.has(r.uid) && Date.parse(r.start) > now && r.emails.some((e) => emailsViejos.has(e)) && Date.parse(r.start) !== Date.parse(meta.calStart)) : undefined);
    if (nueva) {
      yaSeguidas.add(nueva.uid);
      await mover(db, c, meta, nueva, tz);
      out.reprogramadas++;
      await avisar(env, "📅 Videollamada reprogramada", `La videollamada de ${nombre} pasó a ${dicho(nueva.start, tz)} (hora de España). Los recordatorios van a la fecha nueva.`);
    } else {
      await db.run("UPDATE leads SET metadata = json_set(COALESCE(metadata,'{}'), '$.estado', 'Cancelada (Cal.com)', '$.canceladaDetectada', ?) WHERE id = ?", [new Date(now).toISOString(), c.id]);
      out.canceladas++;
      await avisar(env, "📅 Videollamada cancelada", `La videollamada de ${nombre} (${dicho(meta.calStart, tz)}) quedó cancelada en Cal.com: no se le mandarán recordatorios.`);
    }
  }
  return out;
}

/** Pasa la cita (en el mismo registro) a la reserva nueva y borra las marcas de recordatorio: el de 24 h y el de 1 h saldrán para la fecha nueva. */
async function mover(db: Db, c: CitaVigente, meta: Record<string, string>, nueva: ReservaCal, tz: string): Promise<void> {
  const { fecha, hora } = fechaHora(nueva.start, tz);
  const intent = c.intent.replace(/\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}\s*$/, `${fecha} ${hora}`);
  await db.run(
    `UPDATE leads
        SET intent = ?,
            metadata = json_remove(
              json_set(COALESCE(metadata,'{}'), '$.calBookingUid', ?, '$.calStart', ?, '$.fecha', ?, '$.hora', ?, '$.calMeetingUrl', ?, '$.reprogramadaDe', ?),
              '$.viventa_r24', '$.viventa_r1', '$.viventa_resumen')
      WHERE id = ?`,
    [intent, nueva.uid, nueva.start, fecha, hora, nueva.meetingUrl ?? meta.calMeetingUrl ?? "", meta.calStart, c.id],
  );
}
