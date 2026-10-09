/**
 * Aviso al equipo comercial (Camila) — Viventa.
 *
 * Camila envía los proyectos cuando el bot termina el guion de calificación,
 * así que necesita enterarse de cada traspaso con la ficha completa del lead.
 * Canales (cada uno opcional e independiente, best-effort, nunca lanza):
 *   • Telegram: CAMILA_TELEGRAM_CHAT_ID (reusa TELEGRAM_BOT_TOKEN del bot)
 *   • Correo:   CAMILA_EMAIL (Resend, igual que el aviso al dueño)
 * Los valores de contacto viven como secretos del worker; el repo es público.
 */
import { Resend } from "resend";
import type { Env } from "../env";
import type { Db } from "../db/client";

export interface TeamNotice {
  heading: string;
  body: string;
  url?: string;
}

/**
 * Destinatarios de Telegram del equipo comercial: CAMILA_TELEGRAM_CHAT_ID admite
 * VARIOS ids separados por coma (Camila y Maricela), p. ej. "111,222".
 */
export function teamTelegramIds(env: Pick<Env, "CAMILA_TELEGRAM_CHAT_ID">): string[] {
  return String(env.CAMILA_TELEGRAM_CHAT_ID ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function camilaConfigured(env: Env): boolean {
  const telegram = Boolean(env.TELEGRAM_BOT_TOKEN && teamTelegramIds(env).length > 0);
  const mail = Boolean(env.RESEND_API_KEY && env.CAMILA_EMAIL);
  return telegram || mail;
}

/** Manda un aviso a Camila por Telegram y/o correo. Devuelve si algún canal lo aceptó. */
export async function notifyCamila(env: Env, notice: TeamNotice): Promise<boolean> {
  if (!camilaConfigured(env)) {
    console.error(`[camila] "${notice.heading}" sin canal (falta CAMILA_TELEGRAM_CHAT_ID o CAMILA_EMAIL) — Camila no lo verá`);
    return false;
  }
  let delivered = false;

  if (env.TELEGRAM_BOT_TOKEN) {
    const text = `${notice.heading}\n${notice.body}${notice.url ? `\n\n${notice.url}` : ""}`;
    for (const chatId of teamTelegramIds(env)) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (res.ok) delivered = true;
        else console.error(`[camila] telegram ${chatId} http_${res.status}`);
      } catch (e) {
        console.error(`[camila] telegram ${chatId} failed:`, e);
      }
    }
  }

  if (env.RESEND_API_KEY && env.CAMILA_EMAIL) {
    try {
      const resend = new Resend(env.RESEND_API_KEY);
      const html = notice.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
      await resend.emails.send({
        from: `${env.BUSINESS_NAME} Bot <onboarding@resend.dev>`,
        to: env.CAMILA_EMAIL,
        subject: notice.heading,
        html: `<p>${html}</p>${notice.url ? `<p><a href="${notice.url}">Abrir panel</a></p>` : ""}`,
      });
      delivered = true;
    } catch (e) {
      console.error("[camila] resend failed:", e);
    }
  }
  return delivered;
}

const CAMPOS: Array<[string, string]> = [
  ["ciudadResidencia", "Vive en"],
  ["ciudadCompra", "Quiere comprar en"],
  ["motivoCompra", "Para"],
  ["entregaInmediataOFutura", "Entrega"],
  ["plazoCompra", "Plazo"],
  ["ahorroDisponible", "Ahorro para la inicial"],
  ["capacidadMensual", "Podría destinar al mes"],
  ["ingresosMensuales", "Ingresos"],
  ["tipoEmpleo", "Trabajo"],
  ["antiguedadLaboral", "Antigüedad laboral"],
  ["compraSoloOAcompanado", "Compra"],
];

interface LeadRow {
  name: string | null;
  contact: string | null;
  intent: string | null;
  notes: string | null;
  metadata: string | null;
}

/**
 * Ficha del lead de una conversación, lista para pegar en un aviso. Junta todos
 * los leads de la conversación (captureLead guarda uno por llamada): el dato más
 * reciente de cada campo gana. Sin conversación o sin leads devuelve un texto
 * neutro — nunca lanza.
 */
export async function leadFicha(db: Db, conversationId: string | null): Promise<string> {
  if (!conversationId) return "(sin ficha: no hay conversación asociada)";
  let rows: LeadRow[] = [];
  try {
    rows = await db.all<LeadRow>(
      `SELECT name, contact, intent, notes, metadata FROM leads
       WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%'
       ORDER BY created_at ASC`,
      [conversationId],
    );
  } catch (e) {
    console.error("[camila] leadFicha:", e);
  }
  if (!rows.length) return "(sin ficha: el bot todavía no guardó datos de este cliente)";

  let name = "";
  let contact = "";
  const meta: Record<string, string> = {};
  const notes: string[] = [];
  for (const r of rows) {
    if (r.name) name = r.name;
    if (r.contact) contact = r.contact;
    if (r.notes && !notes.includes(r.notes)) notes.push(r.notes);
    if (r.metadata) {
      try {
        Object.assign(meta, JSON.parse(r.metadata));
      } catch {
        // metadata rota: se ignora esa fila
      }
    }
  }

  const lines: string[] = [];
  lines.push(`Nombre: ${name || "(sin nombre)"}`);
  if (contact) lines.push(`Contacto: ${contact}`);
  for (const [key, label] of CAMPOS) {
    if (meta[key]) lines.push(`${label}: ${meta[key]}`);
  }
  for (const n of notes) lines.push(`Notas: ${n}`);
  return lines.join("\n");
}

/**
 * Línea de origen de un aviso: de qué canal viene el cliente y cómo contactarlo.
 * WhatsApp muestra el teléfono; Instagram, el nombre del perfil (no hay número).
 * Nunca lanza: sin conversación devuelve "".
 */
export interface OrigenRow {
  channel: string;
  channel_user_id: string;
  display_name: string | null;
}

/** Texto de origen (canal + cómo contactar) a partir de la fila de la conversación. */
export function etiquetaOrigen(c: OrigenRow): string {
  const nombre = c.display_name ? ` · ${c.display_name}` : "";
  if (c.channel === "ycloud") return `💬 WhatsApp${nombre} · +${c.channel_user_id}`;
  if (c.channel === "zernio" || c.channel === "instagram") return `📸 Instagram${nombre}`;
  if (c.channel === "telegram") return `✈️ Telegram${nombre}`;
  return `${c.channel}${nombre}`;
}

export async function origenCliente(db: Db, conversationId: string | null): Promise<string> {
  if (!conversationId) return "";
  try {
    const rows = await db.all<OrigenRow>(
      "SELECT channel, channel_user_id, display_name FROM conversations WHERE id = ?",
      [conversationId],
    );
    return rows[0] ? etiquetaOrigen(rows[0]) : "";
  } catch (e) {
    console.error("[camila] origenCliente:", e);
    return "";
  }
}

/**
 * Manda un archivo (p. ej. el CSV para Zoho) al equipo por Telegram. Best-effort:
 * nunca lanza; devuelve si algún destinatario lo recibió.
 */
export async function notifyCamilaDocument(
  env: Env,
  doc: { filename: string; content: string | Uint8Array; mime?: string; caption?: string },
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  let delivered = false;
  for (const chatId of teamTelegramIds(env)) {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (doc.caption) form.append("caption", doc.caption.slice(0, 1000));
      form.append("document", new Blob([doc.content as any], { type: doc.mime ?? "text/csv" }), doc.filename);
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: form,
      });
      if (res.ok) delivered = true;
      else console.error(`[camila] documento ${chatId} http_${res.status}`);
    } catch (e) {
      console.error(`[camila] documento ${chatId} failed:`, e);
    }
  }
  return delivered;
}
