/**
 * Watchdog nocturno — lo ÚNICO que debe despertar al dueño.
 *
 * En cada tick del cron frecuente cuenta las respuestas fallidas ("Algo
 * falló…") de los últimos 30 minutos. Si hay 3 o más, algo está roto de
 * verdad (proveedor caído, keys agotadas) y avisa vía notifyOwner (WhatsApp
 * template / Telegram / email, lo que esté configurado). Throttle de 6 h
 * entre alertas para no metrallar el teléfono con el mismo incidente.
 */
import type { Env } from "./env";
import { Db } from "./db/client";
import { SettingsRepo } from "./db/settings";
import { notifyOwner, createHandoffTicket } from "./tools/handoffHuman";
import { dispatchMobilePush } from "./mobile-push";
import { renderPush } from "./lib/push-templates";

const WINDOW_MS = 30 * 60 * 1000;
export const ALERT_THRESHOLD = 3;
const THROTTLE_MS = 6 * 60 * 60 * 1000;
/** Cuándo se disparó la última alerta de salud (throttle + la lee
 *  GET /api/maintenance para pintarla en "Alertas recientes"). */
export const LAST_ALERT_KEY = "last_health_alert_at";

export interface WatchdogResult {
  failures: number;
  alerted: boolean;
}

export async function checkBotHealth(env: Env, now = Date.now()): Promise<WatchdogResult> {
  const db = new Db(env.DB);
  const failures =
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE role = 'assistant' AND content LIKE 'Algo falló%' AND created_at > ?",
        [now - WINDOW_MS],
      )
    )?.n ?? 0;

  if (failures < ALERT_THRESHOLD) return { failures, alerted: false };

  const settings = new SettingsRepo(db);
  const lastRaw = await settings.get(LAST_ALERT_KEY);
  const last = lastRaw ? Number.parseInt(lastRaw, 10) : 0;
  if (Number.isFinite(last) && now - last < THROTTLE_MS) {
    return { failures, alerted: false };
  }

  await settings.set(LAST_ALERT_KEY, String(now));
  await notifyOwner(env, {
    reason: "salud del bot",
    summary: `⚠ ${failures} respuestas fallidas en los últimos 30 min — revisa el proveedor de IA (rate limits/keys) o pausa el bot desde el panel.`,
    ticketId: "watchdog",
  });
  // Ping a la app móvil (Forja Inbox) — hereda el throttle de 6 h de arriba.
  const push = renderPush("watchdog", {
    motivo: `${failures} respuestas fallidas en los últimos 30 min — revisa tu proveedor de IA o pausa el bot.`,
  });
  await dispatchMobilePush(env, { type: "watchdog", title: push.title, body: push.body });
  console.error(`[watchdog] ALERTA: ${failures} fallos en 30 min — dueño notificado`);
  return { failures, alerted: true };
}

/**
 * Vigilante de "silencio" — corre cada pocos minutos (cron dedicado, ver
 * index.ts). checkBotHealth() de arriba SOLO ve fallos explícitos ("Algo
 * falló…"); si un reset de Durable Object (u otro corte a medio camino) deja
 * el turno sin generar NINGÚN mensaje, ese caso es invisible para checkBotHealth
 * y el cliente queda sin respuesta hasta que alguien lo note a ojo (así se
 * escapó la conversación de Luz Carime, 2026-09-25). Esto lo cierra: busca
 * conversaciones activas (no pausadas) cuyo último mensaje sea del cliente y
 * ya pasó el umbral sin respuesta, y abre un ticket + avisa al dueño — mismo
 * canal que un handoff normal (Telegram/email), así no hace falta un canal
 * nuevo. Dedupe: no repite alerta si la conversación ya tiene un ticket
 * abierto (conversations.open_ticket_id), hasta que alguien lo resuelva.
 */
const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // margen sobre el buffer normal (~15-40s)
const STUCK_LOOKBACK_MS = 24 * 60 * 60 * 1000; // no repescar leads viejísimos cada tick

export interface StuckCheckResult {
  stuck: number;
  alerted: number;
}

export async function checkStuckConversations(
  env: Env,
  now = Date.now(),
): Promise<StuckCheckResult> {
  const db = new Db(env.DB);
  const rows = await db.all<{
    id: string;
    display_name: string | null;
    channel: string;
    content: string;
    created_at: number;
  }>(
    `SELECT c.id, c.display_name, c.channel, m.content, m.created_at
     FROM conversations c
     JOIN messages m ON m.id = (
       SELECT id FROM messages
       WHERE conversation_id = c.id
       ORDER BY created_at DESC LIMIT 1
     )
     WHERE m.role = 'user'
       AND m.created_at < ?
       AND m.created_at > ?
       AND (c.paused_until IS NULL OR c.paused_until <= ?)
       AND c.open_ticket_id IS NULL`,
    [now - STUCK_THRESHOLD_MS, now - STUCK_LOOKBACK_MS, now],
  );

  let alerted = 0;
  for (const r of rows) {
    const minutos = Math.round((now - r.created_at) / 60000);
    await createHandoffTicket(env, {
      conversationId: r.id,
      reason: "bot sin responder",
      summary: `${r.display_name ?? "Cliente"} (${r.channel}) escribió hace ${minutos} min y el bot no respondió: "${r.content.slice(0, 140)}"`,
      category: "other",
    }).catch((e) => console.error("[watchdog:stuck] no se pudo crear el ticket:", e));
    alerted++;
  }
  return { stuck: rows.length, alerted };
}
