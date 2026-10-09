/**
 * Reintento automático cuando el proveedor de IA falla.
 *
 * Antes: si Anthropic fallaba en los 3 intentos seguidos (~15 s), el bot se
 * quedaba mudo y se abría un ticket para responder a mano (≈1 % de los turnos).
 * Ahora: el primer fallo se anota en la conversación (metadata.viventa_fallo) y
 * el cron lo reintenta a los 3 min y a los 10 min, sin guardar otra vez el
 * mensaje del cliente. Solo si también fallan los reintentos se avisa a una
 * persona. El error real de cada fallo queda en la tabla `ai_fallos` para poder
 * diagnosticar (los registros de Cloudflare no se conservan).
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { agentStub } from "../agent-stub";

const MIN = 60_000;
/** Intentos totales (el original + 2 reintentos) antes de avisar a una persona. */
export const MAX_INTENTOS_IA = 3;
const ESPERA_MIN: Record<number, number> = { 1: 3, 2: 10 };

interface FalloFlag {
  n?: number;
  at?: number;
}

async function asegurarTabla(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS ai_fallos (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       conversation_id TEXT,
       at INTEGER NOT NULL,
       status INTEGER,
       message TEXT,
       es_reintento INTEGER NOT NULL DEFAULT 0
     )`,
  );
}

function describir(e: unknown): { status: number | null; message: string } {
  const x = e as { statusCode?: number; status?: number; message?: string; responseBody?: string; cause?: { message?: string } };
  const status = x?.statusCode ?? x?.status ?? null;
  const msg = [x?.message, x?.responseBody, x?.cause?.message].filter(Boolean).join(" | ") || String(e);
  return { status, message: msg.slice(0, 500) };
}

async function leerFlag(db: Db, convId: string): Promise<FalloFlag | null> {
  const r = await db.first<{ n: number | null; at: number | null }>(
    `SELECT json_extract(COALESCE(metadata, '{}'), '$.viventa_fallo.n') AS n,
            json_extract(COALESCE(metadata, '{}'), '$.viventa_fallo.at') AS at
       FROM conversations WHERE id = ?`,
    [convId],
  );
  return r && r.n != null ? { n: r.n, at: r.at ?? 0 } : null;
}

/**
 * Anota un fallo del proveedor. `retry` indica que viene de un reintento del cron
 * (que ya subió el contador al reclamarlo). Devuelve `final: true` cuando ya no
 * quedan reintentos y hay que avisar a una persona. Nunca lanza.
 */
export async function registrarFalloIA(
  env: Env,
  db: Db,
  convId: string,
  error: unknown,
  retry: boolean,
  now = Date.now(),
): Promise<{ final: boolean; n: number }> {
  try {
    await asegurarTabla(db);
    const d = describir(error);
    await db.run("INSERT INTO ai_fallos (conversation_id, at, status, message, es_reintento) VALUES (?,?,?,?,?)", [
      convId, now, d.status, d.message, retry ? 1 : 0,
    ]);
    let n = 1;
    if (retry) n = (await leerFlag(db, convId))?.n ?? MAX_INTENTOS_IA;
    await db.run(
      "UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_fallo', json(?)) WHERE id = ?",
      [JSON.stringify({ n, at: now }), convId],
    );
    return { final: n >= MAX_INTENTOS_IA, n };
  } catch (e) {
    console.error("[reintentosIA] registrarFalloIA:", e);
    return { final: true, n: MAX_INTENTOS_IA };
  }
}

export async function limpiarFalloIA(db: Db, convId: string): Promise<void> {
  await db.run(
    "UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.viventa_fallo') WHERE id = ?",
    [convId],
  );
}

/** Cron (cada 5 min): reintenta los turnos que fallaron y ya cumplieron su espera. */
export async function runReintentosIA(env: Env, now = Date.now()): Promise<{ retried: number }> {
  const db = new Db(env.DB);
  const rows = await db.all<{
    id: string;
    channel: string;
    channel_user_id: string;
    paused_until: number | null;
    n: number;
    at: number;
  }>(
    `SELECT id, channel, channel_user_id, paused_until,
            json_extract(metadata, '$.viventa_fallo.n') AS n,
            json_extract(metadata, '$.viventa_fallo.at') AS at
       FROM conversations
      WHERE last_message_at > ?
        AND json_extract(COALESCE(metadata, '{}'), '$.viventa_fallo.n') IS NOT NULL`,
    [now - 2 * 60 * MIN],
  );

  let retried = 0;
  for (const c of rows) {
    const espera = ESPERA_MIN[c.n];
    if (!espera || now - c.at < espera * MIN) continue;
    // Una persona tomó la conversación, o ya se respondió: no hay nada que reintentar.
    const last = (await new MessagesRepo(db).lastN(c.id, 1))[0];
    if ((c.paused_until != null && c.paused_until > now) || !last || last.role !== "user") {
      await limpiarFalloIA(db, c.id);
      continue;
    }
    // Reclamo atómico: sube el contador y fija la hora; solo gana una pasada.
    const r = await db.run(
      `UPDATE conversations
          SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_fallo', json(?))
        WHERE id = ? AND json_extract(COALESCE(metadata, '{}'), '$.viventa_fallo.at') = ?`,
      [JSON.stringify({ n: c.n + 1, at: now }), c.id, c.at],
    );
    if ((r.meta?.changes ?? 0) === 0) continue;
    try {
      await agentStub(env, c.channel, c.channel_user_id).retryFailedTurn();
      retried++;
    } catch (e) {
      console.error(`[reintentosIA] reintento ${c.id}:`, e);
    }
  }
  return { retried };
}
