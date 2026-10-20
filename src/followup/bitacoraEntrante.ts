/**
 * Bitácora de los mensajes entrantes de WhatsApp (YCloud). Guarda por cada mensaje: tipo, botón pulsado (id y título), si respondía a un
 * mensaje citado y cuántos mensajes salieron del parseo. Si un mensaje de cliente NO produjo ningún mensaje para el bot, guarda el
 * payload crudo (truncado) y deja un hallazgo para el auditor: así se ve qué no se pudo leer (usuarios de WhatsApp sin teléfono, tipos
 * nuevos…). Se limpia a los 7 días.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { registrarHallazgo } from "./auditor";

const DIA = 86_400_000;

interface EventoEntrante {
  id?: string;
  type?: string;
  whatsappInboundMessage?: {
    id?: string;
    wamid?: string;
    from?: string;
    fromUserId?: string;
    to?: string;
    type?: string;
    text?: { body?: string };
    context?: { id?: string; from?: string };
    interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
    customerProfile?: { name?: string; username?: string };
  };
}

export async function bitacoraEntrante(env: Env, ev: EventoEntrante, producidos: number, now = Date.now()): Promise<void> {
  if (ev?.type !== "whatsapp.inbound_message.received") return;
  const m = ev.whatsappInboundMessage ?? {};
  const db = new Db(env.DB);
  await db.run(
    "CREATE TABLE IF NOT EXISTS entrantes_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, wamid TEXT, desde TEXT, tipo TEXT, texto TEXT, boton_id TEXT, boton_titulo TEXT, cita_a TEXT, producidos INTEGER NOT NULL, crudo TEXT)",
  );
  const boton = m.interactive?.button_reply ?? m.interactive?.list_reply;
  await db.run("INSERT INTO entrantes_log (ts, wamid, desde, tipo, texto, boton_id, boton_titulo, cita_a, producidos, crudo) VALUES (?,?,?,?,?,?,?,?,?,?)", [
    now,
    m.wamid ?? m.id ?? ev.id ?? null,
    m.from ?? null,
    m.type ?? null,
    (m.text?.body ?? "").slice(0, 80),
    boton?.id ?? null,
    boton?.title ?? null,
    m.context?.id ?? null,
    producidos,
    producidos === 0 ? JSON.stringify(ev).slice(0, 2500) : null,
  ]);
  if (Math.random() < 0.02) await db.run("DELETE FROM entrantes_log WHERE ts < ?", [now - 7 * DIA]).catch(() => {});
  const digitos = (x?: string): string => String(x ?? "").replace(/\D/g, "");
  const esNuestro = !m.to || digitos(m.to) === digitos(env.YCLOUD_WA_FROM);
  if (producidos === 0 && esNuestro && !["reaction", "unsupported", "system", "request_welcome"].includes(String(m.type))) {
    await registrarHallazgo(env, {
      tipo: "mensaje_ilegible",
      convId: `ycloud:${String(m.from ?? "").replace(/\D/g, "") || m.fromUserId || "desconocido"}`,
      clave: String(m.wamid ?? m.id ?? ev.id ?? now),
      detalle: `Llegó un mensaje de WhatsApp (${m.type ?? "tipo desconocido"}${m.customerProfile?.username ? `, usuario @${m.customerProfile.username}` : ""}) y el bot no pudo leerlo. Respóndele desde WhatsApp Business.`,
    }, now);
  }
}
