/**
 * Sistema de atención Viventa — automatismos del embudo (cron cada 5 min):
 *
 *  1. Seguimiento del guion: si un lead dejó de responder en medio del guion de
 *     calificación, UN solo recordatorio suave + aviso a Camila. Se manda entre
 *     las 20 h y las 23,5 h del último mensaje del cliente (no a las 24 h justas:
 *     la ventana de WhatsApp se cierra a las 24 h y el texto libre rebotaría).
 *  2. Seguimiento de proyectos: Camila envía los proyectos desde su app (queda
 *     como mensaje "owner" tras el traspaso "Lead calificado"). Si el lead no
 *     responde en 48 h, UN seguimiento suave + aviso a Camila. A esa altura la
 *     ventana de 24 h ya está cerrada: en WhatsApp necesita plantilla aprobada
 *     (setting viventa_tpl_seguimiento); sin ella no se envía y se avisa.
 *  3. Videollamada con Maricela: recordatorio al cliente 24 h y 1 h antes (hora
 *     de España) y resumen del lead para Maricela 1 h antes. Las citas salen de
 *     los leads "Cita ·" reservados en Cal.com (metadata.calStart, instante exacto).
 *
 * Todos reclaman antes de enviar (marca en metadata) → imposible duplicar.
 * Best-effort: un candidato que falla no frena a los demás.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { ConversationsRepo } from "../db/conversations";
import { SettingsRepo } from "../db/settings";
import { botTimezone } from "../time/dateAnchor";
import { selfOrigin } from "../lib/self-origin";
import { notifyCamila, leadFicha } from "../lib/camila";
import { messageOwner } from "../tools/handoffHuman";
import { sendOutbound } from "./send";
import { sendYCloudTemplate } from "../channels/ycloud";

const H = 3600_000;
const MIN = 60_000;
/** Ventana de servicio de WhatsApp con 5 min de margen. */
const WINDOW_MS = 24 * H - 5 * MIN;

export const TPL_SEGUIMIENTO = "viventa_tpl_seguimiento";
export const TPL_RECORDATORIO = "viventa_tpl_recordatorio";
const TPL_LANG = "viventa_tpl_lang";

interface ConvRef {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
}

function primerNombre(...candidatos: Array<string | null | undefined>): string {
  for (const c of candidatos) {
    const n = (c ?? "").trim().split(/\s+/)[0];
    if (n) return n;
  }
  return "";
}

function horaEs(iso: number, tz: string): string {
  return new Intl.DateTimeFormat("es-ES", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );
}

function fechaEs(iso: number, tz: string): string {
  return new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(
    new Date(iso),
  );
}

/** Reclama una marca JSON en `table.metadata`; true solo para quien la ganó. */
async function claim(db: Db, table: "conversations" | "leads", id: string, key: string, now: number): Promise<boolean> {
  const path = `$.${key}`;
  const res = await db.run(
    `UPDATE ${table}
        SET metadata = json_set(COALESCE(metadata, '{}'), '${path}', ?)
      WHERE id = ? AND json_extract(COALESCE(metadata, '{}'), '${path}') IS NULL`,
    [new Date(now).toISOString(), id],
  );
  return (res.meta?.changes ?? 0) > 0;
}

type SendResult = "libre" | "plantilla";

/**
 * Envía a un cliente. WhatsApp (ycloud) fuera de la ventana de 24 h solo admite
 * plantilla aprobada; el resto de canales va en texto libre. Lanza
 * "sin_plantilla" si hace falta plantilla y no está configurada.
 */
async function enviarACliente(
  env: Env,
  db: Db,
  conv: ConvRef,
  text: string,
  plantilla: { setting: string; params: string[] } | null,
  lastUserAt: number | null,
  now: number,
): Promise<SendResult> {
  const conVentana = conv.channel === "ycloud";
  const dentro = lastUserAt != null && now - lastUserAt < WINDOW_MS;
  if (!conVentana || dentro) {
    await sendOutbound(env, { conversationId: conv.id, channel: conv.channel, channelUserId: conv.channel_user_id, text }, now);
    return "libre";
  }
  const settings = new SettingsRepo(db);
  const nombre = plantilla ? ((await settings.get(plantilla.setting)) ?? "").trim() : "";
  if (!plantilla || !nombre) throw new Error("sin_plantilla");
  const lang = ((await settings.get(TPL_LANG)) ?? "").trim() || "es";
  await sendYCloudTemplate(env, conv.channel_user_id, nombre, lang, plantilla.params);
  await new MessagesRepo(db).append(conv.id, "assistant", text);
  await new ConversationsRepo(db).touchLastMessage(conv.id, now);
  return "plantilla";
}

async function avisarEquipo(env: Env, heading: string, body: string): Promise<void> {
  const url = `${await selfOrigin(env)}/admin`;
  await notifyCamila(env, { heading, body, url }).catch(() => false);
}

// ─── 1. Seguimiento del guion (≈24 h sin respuesta) ────────────────────────────

interface GuionRow extends ConvRef {
  last_user_at: number | null;
  last_role: string | null;
}

export async function runGuionSeguimiento(env: Env, now = Date.now()): Promise<{ sent: number }> {
  const db = new Db(env.DB);
  const rows = await db.all<GuionRow>(
    `SELECT c.id, c.channel, c.channel_user_id, c.display_name,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at,
            (SELECT role FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_role
       FROM conversations c
      WHERE c.channel IN ('ycloud', 'zernio')
        AND c.open_ticket_id IS NULL
        AND (c.paused_until IS NULL OR c.paused_until < ?)
        AND c.last_message_at > ?
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_guion24') IS NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'owner')
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id AND t.summary LIKE '[Lead calificado%')`,
    [now, now - 30 * H],
  );

  let sent = 0;
  for (const c of rows) {
    if (c.last_role !== "assistant" || c.last_user_at == null) continue;
    const idle = now - c.last_user_at;
    if (idle < 20 * H || idle > 23.5 * H) continue;
    if (!(await claim(db, "conversations", c.id, "viventa_guion24", now))) continue;

    const nombre = primerNombre(c.display_name);
    const text =
      `Hola${nombre ? ` ${nombre}` : ""} 😊 ¿Seguimos con las preguntas? ` +
      `Me faltan pocas para que el equipo comercial de Maricela pueda orientarte mejor.`;
    try {
      await enviarACliente(env, db, c, text, null, c.last_user_at, now);
      sent++;
      await avisarEquipo(
        env,
        "⏰ Seguimiento enviado (sin respuesta en el guion)",
        `${nombre || c.channel_user_id} no respondió en ~24 h durante las preguntas. Le mandé un recordatorio suave.\n\n${await leadFicha(db, c.id)}`,
      );
    } catch (e) {
      console.error(`[sistemaViventa] seguimiento guion ${c.id}:`, e);
    }
  }
  return { sent };
}

// ─── 2. Seguimiento de proyectos (48 h sin respuesta) ──────────────────────────

interface ProyectosRow extends ConvRef {
  projects_at: number | null;
  last_user_at: number | null;
}

export async function runSeguimientoProyectos(env: Env, now = Date.now()): Promise<{ sent: number; sinPlantilla: number }> {
  const db = new Db(env.DB);
  const rows = await db.all<ProyectosRow>(
    `SELECT c.id, c.channel, c.channel_user_id, c.display_name,
            (SELECT MIN(m.created_at) FROM messages m
               WHERE m.conversation_id = c.id AND m.role = 'owner'
                 AND m.created_at > (SELECT MIN(t.created_at) FROM tickets t
                                      WHERE t.conversation_id = c.id AND t.summary LIKE '[Lead calificado%')) AS projects_at,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at
       FROM conversations c
      WHERE c.channel IN ('ycloud', 'zernio')
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_proy48') IS NULL
        AND EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id AND t.summary LIKE '[Lead calificado%')
        AND c.last_message_at > ?`,
    [now - 8 * 24 * H],
  );

  let sent = 0;
  let sinPlantilla = 0;
  for (const c of rows) {
    if (c.projects_at == null) continue;
    const desde = now - c.projects_at;
    if (desde < 48 * H || desde > 7 * 24 * H) continue;
    if (c.last_user_at != null && c.last_user_at > c.projects_at) continue; // ya respondió
    if (!(await claim(db, "conversations", c.id, "viventa_proy48", now))) continue;

    const nombre = primerNombre(c.display_name);
    const text =
      `Hola${nombre ? ` ${nombre}` : ""} 😊 Te escribo para saber si pudiste revisar las opciones de proyectos que te enviamos. ` +
      `¿Te quedó alguna duda o quieres que agendemos tu videollamada con Maricela?`;
    try {
      const via = await enviarACliente(env, db, c, text, { setting: TPL_SEGUIMIENTO, params: [nombre || "hola"] }, c.last_user_at, now);
      sent++;
      await avisarEquipo(
        env,
        "⏰ Seguimiento a 48 h enviado",
        `${nombre || c.channel_user_id} no respondió en 48 h tras recibir los proyectos. Le mandé un seguimiento suave (${via}).\n\n${await leadFicha(db, c.id)}`,
      );
    } catch (e) {
      if ((e as Error).message === "sin_plantilla") {
        sinPlantilla++;
        await avisarEquipo(
          env,
          "⚠️ Seguimiento a 48 h NO enviado",
          `${nombre || c.channel_user_id} no respondió en 48 h tras los proyectos, pero WhatsApp ya cerró la ventana de 24 h y falta la plantilla aprobada de seguimiento. Escríbele tú, por favor.\n\n${await leadFicha(db, c.id)}`,
        );
      } else {
        console.error(`[sistemaViventa] seguimiento proyectos ${c.id}:`, e);
      }
    }
  }
  return { sent, sinPlantilla };
}

// ─── 3. Videollamada: recordatorios 24 h / 1 h y resumen para Maricela ─────────

interface CitaRow {
  id: string;
  conversation_id: string | null;
  name: string | null;
  created_at: number;
  metadata: string | null;
}

export async function runRecordatoriosLlamada(
  env: Env,
  now = Date.now(),
): Promise<{ r24: number; r1: number; resumenes: number }> {
  const db = new Db(env.DB);
  const tz = botTimezone(env);
  const rows = await db.all<CitaRow>(
    `SELECT id, conversation_id, name, created_at, metadata FROM leads
      WHERE intent LIKE 'Cita ·%'
        AND json_extract(COALESCE(metadata, '{}'), '$.estado') = 'Reservada (Cal.com)'
        AND json_extract(COALESCE(metadata, '{}'), '$.calStart') IS NOT NULL
        AND created_at > ?`,
    [now - 90 * 24 * H],
  );

  const out = { r24: 0, r1: 0, resumenes: 0 };
  for (const lead of rows) {
    let meta: Record<string, string> = {};
    try {
      meta = lead.metadata ? JSON.parse(lead.metadata) : {};
    } catch {
      continue;
    }
    const inicio = Date.parse(meta.calStart ?? "");
    if (!Number.isFinite(inicio)) continue;
    const falta = inicio - now;
    if (falta <= 0 || falta > 25 * H) continue;

    const conv = lead.conversation_id ? await new ConversationsRepo(db).getById(lead.conversation_id) : null;
    const lastUser = conv
      ? ((await db.first<{ t: number | null }>(
          "SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'",
          [conv.id],
        ))?.t ?? null)
      : null;
    const nombre = primerNombre(lead.name, conv?.display_name);
    const hora = horaEs(inicio, tz);

    // Resumen del lead para Maricela, ~1 h antes (entre 70 y 10 min).
    if (falta <= 70 * MIN && falta > 10 * MIN && (await claim(db, "leads", lead.id, "viventa_resumen", now))) {
      try {
        const ficha = await leadFicha(db, lead.conversation_id);
        await messageOwner(env, {
          heading: `📞 Videollamada a las ${hora} (hora de España)`,
          body: `Cliente: ${nombre || "(sin nombre)"}\nFecha: ${fechaEs(inicio, tz)}\n\n${ficha}`,
          url: `${await selfOrigin(env)}/admin`,
        });
        out.resumenes++;
      } catch (e) {
        console.error(`[sistemaViventa] resumen ${lead.id}:`, e);
      }
    }

    if (!conv) continue;
    const ref: ConvRef = { id: conv.id, channel: conv.channel, channel_user_id: conv.channel_user_id, display_name: conv.display_name };

    // Recordatorio 24 h: solo si la cita se agendó con ≥ 24 h de antelación.
    if (falta <= 24 * H && falta > 2 * H && lead.created_at <= inicio - 24 * H && (await claim(db, "leads", lead.id, "viventa_r24", now))) {
      const text =
        `¡Hola${nombre ? ` ${nombre}` : ""}! 😊 Te recuerdo que mañana tienes tu videollamada con Maricela a las ${hora} (hora de España). ` +
        `¿Sigue en pie, o prefieres reprogramarla?`;
      try {
        await enviarACliente(env, db, ref, text, { setting: TPL_RECORDATORIO, params: [nombre || "hola", hora] }, lastUser, now);
        out.r24++;
      } catch (e) {
        await falloRecordatorio(env, "24 h", nombre || ref.channel_user_id, hora, e);
      }
    }

    // Recordatorio 1 h antes.
    if (falta <= H && lead.created_at <= inicio - H && (await claim(db, "leads", lead.id, "viventa_r1", now))) {
      const text =
        `¡Hola${nombre ? ` ${nombre}` : ""}! 😊 En una hora, a las ${hora} (hora de España), es tu videollamada con Maricela. ¡Te esperamos!`;
      try {
        await enviarACliente(env, db, ref, text, { setting: TPL_RECORDATORIO, params: [nombre || "hola", hora] }, lastUser, now);
        out.r1++;
      } catch (e) {
        await falloRecordatorio(env, "1 h", nombre || ref.channel_user_id, hora, e);
      }
    }
  }
  return out;
}

async function falloRecordatorio(env: Env, cuando: string, quien: string, hora: string, e: unknown): Promise<void> {
  const motivo =
    (e as Error).message === "sin_plantilla"
      ? "WhatsApp ya cerró la ventana de 24 h y falta la plantilla aprobada de recordatorio"
      : String((e as Error).message ?? e);
  console.error(`[sistemaViventa] recordatorio ${cuando} a ${quien}: ${motivo}`);
  await messageOwner(env, {
    heading: `⚠️ Recordatorio de ${cuando} NO enviado`,
    body: `Cliente: ${quien}\nVideollamada a las ${hora} (hora de España)\nMotivo: ${motivo}.\nAvísale tú, por favor.`,
  }).catch(() => undefined);
  await avisarEquipo(env, `⚠️ Recordatorio de ${cuando} NO enviado`, `Cliente: ${quien} · videollamada a las ${hora} (hora de España). ${motivo}.`);
}

/** Corre los tres automatismos; cada uno es independiente. */
export async function runSistemaViventa(env: Env, now = Date.now()): Promise<void> {
  await runGuionSeguimiento(env, now).catch((e) => console.error("[sistemaViventa] guion:", e));
  await runSeguimientoProyectos(env, now).catch((e) => console.error("[sistemaViventa] proyectos:", e));
  await runRecordatoriosLlamada(env, now).catch((e) => console.error("[sistemaViventa] llamada:", e));
}
