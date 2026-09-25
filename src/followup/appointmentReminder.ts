import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { pickAdapter, sendChunkedReply } from "../replies/sender";
import type { ChannelId } from "../channels/shared";
import { botTimezone } from "../time/dateAnchor";
import { chunkReply } from "../replies/chunker";

/**
 * Recordatorio del día anterior para citas agendadas (Outlet / videollamada)
 * — pedido explícito del dueño (2026-09-25): el bot debe confirmar la cita un
 * día antes, no solo agendarla y olvidarla. Lee las citas de captureLead
 * (metadata.citaFecha/citaHora/citaTipo) y le escribe al cliente, una sola
 * vez por cita (metadata.recordatorioEnviadoEn evita duplicados).
 *
 * Corre desde el cron frecuente (cada 5 min) pero gateado a UNA franja
 * horaria del día — ver index.ts — así en la práctica dispara una vez por día.
 */

function isoDateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

interface LeadRow {
  id: string;
  conversation_id: string | null;
  channel_user_id: string | null;
  name: string | null;
  metadata: string | null;
}

export interface AppointmentReminderResult {
  sent: number;
}

export async function sendAppointmentReminders(
  env: Env,
  now = new Date(),
): Promise<AppointmentReminderResult> {
  const db = new Db(env.DB);
  const tz = botTimezone(env);
  const tomorrow = addDaysIso(isoDateInTz(now, tz), 1);

  const rows = await db.all<LeadRow>(
    `SELECT id, conversation_id, channel_user_id, name, metadata FROM leads
     WHERE json_extract(metadata, '$.citaFecha') = ?
       AND json_extract(metadata, '$.recordatorioEnviadoEn') IS NULL`,
    [tomorrow],
  );

  let sent = 0;
  const msgs = new MessagesRepo(db);
  for (const row of rows) {
    if (!row.conversation_id || !row.channel_user_id) continue;
    const sep = row.conversation_id.indexOf(":");
    const channel = (sep === -1 ? "" : row.conversation_id.slice(0, sep)) as ChannelId;
    if (!channel) continue;

    let meta: Record<string, string> = {};
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      continue;
    }
    const hora = meta.citaHora ?? "";
    const tipoLegible = meta.citaTipo === "outlet" ? "visita al Outlet" : "videollamada";
    const nombre = row.name ? row.name.split(" ")[0] : "";

    const text =
      `¡Hola${nombre ? ` ${nombre}` : ""}! 😊 Te escribo para confirmar tu ${tipoLegible} de mañana` +
      `${hora ? ` a las ${hora}` : ""}. ¿Sigue en pie, o preferís que la reprogramemos?`;

    try {
      const adapter = pickAdapter(channel);
      await sendChunkedReply(adapter, channel, row.channel_user_id, chunkReply(text, 1), env);
      await msgs.append(row.conversation_id, "assistant", text);
      await db.run("UPDATE leads SET metadata = json_set(metadata, '$.recordatorioEnviadoEn', ?) WHERE id = ?", [
        now.toISOString(),
        row.id,
      ]);
      sent++;
    } catch (e) {
      console.error(`[appointmentReminder] no se pudo avisar a lead ${row.id}:`, e);
    }
  }
  return { sent };
}
