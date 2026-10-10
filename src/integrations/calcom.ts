import type { Env } from "../env";

// Cliente de Cal.com API v2 para los nichos de cita. Dos capacidades:
//  - getAvailableSlots: horarios reales libres de un event type en un día.
//  - createBooking: reserva una cita en el calendario del dueño.
// Cada endpoint fija su cal-api-version (Cal.com versiona por endpoint).
// Docs: https://cal.com/docs/api-reference/v2

const CALCOM_API = "https://api.cal.com/v2";
const SLOTS_VERSION = "2024-09-04";
const BOOKINGS_VERSION = "2026-02-25";

export const DEFAULT_TZ = "America/Mexico_City";

/** ¿El dueño ya conectó Cal.com? (API key + al menos un event type). */
export function calcomConfigured(env: Env): boolean {
  return Boolean(env.CALCOM_API_KEY && (env.CALCOM_EVENT_TYPE_ID || env.CALCOM_EVENT_TYPES));
}

export function calcomTimeZone(env: Env): string {
  return (env.CALCOM_TIMEZONE || "").trim() || DEFAULT_TZ;
}

/**
 * Resuelve el eventTypeId para un servicio. Si hay un mapa CALCOM_EVENT_TYPES,
 * busca por coincidencia de palabra (case-insensitive); si no, usa el default.
 */
export function resolveEventTypeId(env: Env, servicio?: string): number | null {
  const map = parseEventTypes(env.CALCOM_EVENT_TYPES);
  if (map && servicio) {
    const s = servicio.toLowerCase();
    for (const [key, id] of Object.entries(map)) {
      if (s.includes(key.toLowerCase())) return id;
    }
  }
  if (map) {
    const first = Object.values(map)[0];
    if (typeof first === "number") return first;
  }
  const def = Number(env.CALCOM_EVENT_TYPE_ID);
  return Number.isFinite(def) && def > 0 ? def : null;
}

function parseEventTypes(raw?: string): Record<string, number> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

interface Slot {
  start: string;
}

/**
 * Horarios libres de un event type para una fecha (YYYY-MM-DD, en la zona dada).
 * Devuelve los ISO `start` de los slots disponibles ese día.
 */
export async function getAvailableSlots(
  env: Env,
  eventTypeId: number,
  date: string,
  timeZone: string,
): Promise<{ ok: true; slots: string[] } | { ok: false; reason: string }> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  // Ventana [date, date+1día) para traer solo ese día.
  const end = nextDay(date);
  const url = `${CALCOM_API}/slots?eventTypeId=${eventTypeId}&start=${date}&end=${end}&timeZone=${encodeURIComponent(timeZone)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": SLOTS_VERSION },
    });
    if (!res.ok) {
      // El motivo real viene en el CUERPO (un 401 de /bookings con /slots en
      // 200 solo se entendió leyéndolo). Nunca trae la llave — va en cabecera.
      console.error(`[calcom] slots http_${res.status} · eventType=${eventTypeId} date=${date} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as { data?: Record<string, Slot[]> };
    const byDate = body.data ?? {};
    const slots = (byDate[date] ?? [])
      .map((s) => s?.start)
      .filter((s): s is string => typeof s === "string");
    return { ok: true, slots };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/**
 * Horarios libres de varios días de una sola vez: { "YYYY-MM-DD": [ISO start, ...] }.
 * La fecha final cuenta como incluida (así responde Cal.com).
 */
export async function getAvailableSlotsRange(
  env: Env,
  eventTypeId: number,
  startDate: string,
  endDate: string,
  timeZone: string,
): Promise<{ ok: true; byDate: Record<string, string[]> } | { ok: false; reason: string }> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  const url = `${CALCOM_API}/slots?eventTypeId=${eventTypeId}&start=${startDate}&end=${endDate}&timeZone=${encodeURIComponent(timeZone)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": SLOTS_VERSION },
    });
    if (!res.ok) {
      console.error(`[calcom] slots-range http_${res.status} · eventType=${eventTypeId} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as { data?: Record<string, Slot[]> };
    const byDate: Record<string, string[]> = {};
    for (const [date, list] of Object.entries(body.data ?? {})) {
      byDate[date] = (list ?? []).map((s) => s?.start).filter((s): s is string => typeof s === "string");
    }
    return { ok: true, byDate };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/**
 * Inicios (ISO) de las reservas futuras REALES del calendario. Solo el inicio:
 * la imagen de disponibilidad nunca necesita nombres ni datos de nadie.
 */
export async function getUpcomingBookingStarts(
  env: Env,
  eventTypeId?: number,
): Promise<{ ok: true; starts: string[] } | { ok: false; reason: string }> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  const qs = `status=upcoming&take=100${eventTypeId ? `&eventTypeIds=${eventTypeId}` : ""}`;
  try {
    const res = await fetch(`${CALCOM_API}/bookings?${qs}`, {
      headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": BOOKINGS_VERSION },
    });
    if (!res.ok) {
      console.error(`[calcom] bookings-list http_${res.status} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as { data?: { start?: string; status?: string }[] };
    const starts = (body.data ?? [])
      .filter((b) => typeof b?.start === "string" && b.status !== "cancelled" && b.status !== "rejected")
      .map((b) => b.start as string);
    return { ok: true, starts };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

export async function createBooking(
  env: Env,
  args: {
    eventTypeId: number;
    start: string; // ISO
    name: string;
    email: string;
    timeZone: string;
    phone?: string;
    notes?: string;
  },
): Promise<
  | { ok: true; bookingId: number | string; uid?: string; status?: string; start?: string; meetingUrl?: string }
  | { ok: false; reason: string }
> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${CALCOM_API}/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CALCOM_API_KEY}`,
        "cal-api-version": BOOKINGS_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: args.start,
        eventTypeId: args.eventTypeId,
        attendee: {
          name: args.name,
          email: args.email,
          timeZone: args.timeZone,
          ...(args.phone ? { phoneNumber: args.phone } : {}),
        },
        ...(args.notes ? { bookingFieldsResponses: { notes: args.notes } } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`[calcom] booking http_${res.status} · eventType=${args.eventTypeId} start=${args.start} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = (await res.json()) as {
      data?: { id: number | string; uid?: string; status?: string; start?: string; meetingUrl?: string; location?: string };
    };
    const d = body.data;
    if (!d?.id) return { ok: false, reason: "no_booking_id" };
    // Enlace para entrar a la llamada: el que devuelve Cal.com (Google Meet o
    // Cal Video). Solo si la reserva es de Cal Video se arma con el uid; con
    // otra ubicación, un enlace armado sería falso.
    const esUrl = (v?: string) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);
    const meetingUrl = esUrl(d.meetingUrl) ?? esUrl(d.location) ?? (d.uid && /cal-?video/i.test(d.location ?? "") ? `https://app.cal.com/video/${d.uid}` : undefined);
    return { ok: true, bookingId: d.id, uid: d.uid, status: d.status, start: d.start, meetingUrl };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/**
 * Cancela una reserva. Cal.com cancela por `uid` (no por el id numérico) — por
 * eso createBooking lo devuelve y agendarCita lo persiste en el lead
 * (metadata.calBookingUid): sin uid, una cita creada hoy no se puede cancelar mañana.
 */
export async function cancelBooking(
  env: Env,
  uid: string,
  reason?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!env.CALCOM_API_KEY) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${CALCOM_API}/bookings/${encodeURIComponent(uid)}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CALCOM_API_KEY}`,
        "cal-api-version": BOOKINGS_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reason ? { cancellationReason: reason } : {}),
    });
    if (!res.ok) {
      console.error(`[calcom] cancel http_${res.status} · uid=${uid} · ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `transient:${String(e?.message ?? e)}` };
  }
}

/** YYYY-MM-DD del día siguiente (para la ventana de slots). */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
