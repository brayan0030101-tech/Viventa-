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
 *  4. Teléfono de Instagram: Instagram no entrega el número. A quien escribió por
 *     Instagram y no lo ha dado, UN mensaje (texto de Maricela) pidiéndolo y la
 *     hora para llamarle; así ella puede escribirle por WhatsApp. Solo dentro de
 *     la ventana de 24 h de Instagram y en horario de España.
 *  5. Datos que faltan para el formulario de Zoho: a quien ya terminó el guion y le
 *     falta apellido, correo, teléfono o ciudades, UN mensaje pidiendo solo eso.
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
import { camilaConfigured, notifyCamila, leadFicha } from "../lib/camila";
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

/**
 * IMPORTANTE (límite de lecturas de D1): estas consultas corren en el cron y NO
 * pueden hacer subconsultas correlacionadas por conversación (un EXISTS sobre
 * `tickets`, que no tiene índice por conversación, leía ~60 mil filas por
 * pasada y agotó el cupo diario de D1). Aquí: una consulta acotada por índice
 * para las conversaciones, una sobre los mensajes de las últimas 30 h
 * (índice created_at) y una sobre los tickets "Lead calificado" recientes; el
 * cruce se hace en memoria.
 */
export async function runGuionSeguimiento(env: Env, now = Date.now()): Promise<{ sent: number }> {
  const db = new Db(env.DB);
  const convs = await db.all<ConvRef>(
    `SELECT c.id, c.channel, c.channel_user_id, c.display_name
       FROM conversations c
      WHERE c.last_message_at > ?
        AND c.channel IN ('ycloud', 'zernio')
        AND c.open_ticket_id IS NULL
        AND (c.paused_until IS NULL OR c.paused_until < ?)
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_guion24') IS NULL
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_pidetel') IS NULL`,
    [now - 30 * H, now],
  );
  if (convs.length === 0) return { sent: 0 };

  const recientes = await db.all<{ conversation_id: string; role: string; created_at: number }>(
    "SELECT conversation_id, role, created_at FROM messages WHERE created_at > ? ORDER BY created_at ASC",
    [now - 30 * H],
  );
  const calificados = new Set(
    (
      await db.all<{ conversation_id: string }>(
        "SELECT DISTINCT conversation_id FROM tickets WHERE created_at > ? AND summary LIKE '[Lead calificado%'",
        [now - 14 * 24 * H],
      )
    ).map((r) => r.conversation_id),
  );
  const porConv = new Map<string, { lastUser: number | null; lastRole: string | null; owner: boolean }>();
  for (const m of recientes) {
    const e = porConv.get(m.conversation_id) ?? { lastUser: null, lastRole: null, owner: false };
    if (m.role === "user") e.lastUser = m.created_at;
    if (m.role === "owner") e.owner = true;
    e.lastRole = m.role;
    porConv.set(m.conversation_id, e);
  }
  const rows: GuionRow[] = convs
    .filter((c) => !calificados.has(c.id) && !porConv.get(c.id)?.owner)
    .map((c) => ({ ...c, last_user_at: porConv.get(c.id)?.lastUser ?? null, last_role: porConv.get(c.id)?.lastRole ?? null }));

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
  // Primero los tickets "Lead calificado" de la última semana (tabla chica); de ahí
  // salen las pocas conversaciones a revisar — consultas por clave primaria/índice.
  const tickets = await db.all<{ conversation_id: string; t: number }>(
    `SELECT conversation_id, MIN(created_at) AS t FROM tickets
      WHERE created_at > ? AND conversation_id IS NOT NULL AND summary LIKE '[Lead calificado%'
      GROUP BY conversation_id`,
    [now - 9 * 24 * H],
  );
  const rows: ProyectosRow[] = [];
  for (const tk of tickets) {
    const conv = await db.first<ConvRef & { metadata: string | null }>(
      "SELECT id, channel, channel_user_id, display_name, metadata FROM conversations WHERE id = ?",
      [tk.conversation_id],
    );
    if (!conv || (conv.channel !== "ycloud" && conv.channel !== "zernio")) continue;
    if (/"viventa_proy48"/.test(conv.metadata ?? "")) continue;
    const proy = await db.first<{ t: number | null }>(
      "SELECT MIN(created_at) AS t FROM messages WHERE conversation_id = ? AND created_at > ? AND role = 'owner'",
      [conv.id, tk.t],
    );
    if (proy?.t == null) continue;
    const usr = await db.first<{ t: number | null }>(
      "SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND created_at > ? AND role = 'user'",
      [conv.id, tk.t - 24 * H],
    );
    rows.push({
      id: conv.id,
      channel: conv.channel,
      channel_user_id: conv.channel_user_id,
      display_name: conv.display_name,
      projects_at: proy.t,
      last_user_at: usr?.t ?? null,
    });
  }

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
    [now - 45 * 24 * H],
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
        const aviso = {
          heading: `📞 Videollamada a las ${hora} (hora de España)`,
          body: `Cliente: ${nombre || "(sin nombre)"}\nFecha: ${fechaEs(inicio, tz)}\n\n${ficha}`,
          url: `${await selfOrigin(env)}/admin`,
        };
        // El resumen es para Maricela (y Camila): van al equipo comercial; si no
        // hay equipo configurado, al dueño como antes.
        if (camilaConfigured(env)) await notifyCamila(env, aviso);
        else await messageOwner(env, aviso);
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
// ─── 4. Pedir el teléfono a quien escribió por Instagram ───────────────────────

/** Texto de Maricela (sin cambios) para pedir el número y la hora de la llamada. */
export const TEXTO_PEDIR_TELEFONO =
  "Hola 😊 Muchas gracias por escribirme y por tu interés en comprar vivienda en Colombia 🇨🇴🏡.\n\n" +
  "Quiero llamarte mañana para conocerte mejor, resolver tus dudas y orientarte sobre las opciones disponibles.\n\n" +
  "📞 Si aún no me has compartido tu número de teléfono, ¿me lo puedes enviar por aquí, por favor? " +
  "Y dime qué hora te viene bien mañana para dejar la llamada agendada 😊.";

const RE_TELEFONO = /\+?\d[\d\s().-]{6,}\d/;
const RE_PIDE_TEL = /(n[uú]mero|tel[eé]fono|whats\s?app)/i;
/** Espera mínima desde el último mensaje del cliente: no interrumpe una charla activa. */
const IDLE_MIN_TEL = 45 * MIN;
/** Instagram bloquea el texto libre pasadas 24 h; se corta antes con margen. */
const MAX_IDLE_TEL = 22 * H;
/** Tope por pasada (cada 15 min): enviar de a poco, no una ráfaga que parezca spam. */
const MAX_POR_PASADA_TEL = 5;

export async function runPedirTelefono(env: Env, now = Date.now()): Promise<{ sent: number }> {
  const horaMadrid = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date(now)),
  );
  if (horaMadrid < 9 || horaMadrid >= 21) return { sent: 0 };

  const db = new Db(env.DB);
  const convs = await db.all<ConvRef>(
    `SELECT c.id, c.channel, c.channel_user_id, c.display_name
       FROM conversations c
      WHERE c.last_message_at > ?
        AND c.channel = 'zernio'
        AND (c.paused_until IS NULL OR c.paused_until < ?)
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_pidetel') IS NULL
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_guion24') IS NULL`,
    [now - 30 * H, now],
  );
  if (convs.length === 0) return { sent: 0 };

  const recientes = await db.all<{ conversation_id: string; role: string; content: string; created_at: number }>(
    "SELECT conversation_id, role, content, created_at FROM messages WHERE created_at > ? ORDER BY created_at ASC",
    [now - 30 * H],
  );
  const porConv = new Map<string, { lastUser: number | null; lastRole: string | null; lastAsst: string; owner: boolean; tel: boolean }>();
  for (const m of recientes) {
    const e = porConv.get(m.conversation_id) ?? { lastUser: null, lastRole: null, lastAsst: "", owner: false, tel: false };
    if (m.role === "user") {
      e.lastUser = m.created_at;
      if (RE_TELEFONO.test(m.content)) e.tel = true;
    }
    if (m.role === "owner") e.owner = true;
    if (m.role === "assistant") e.lastAsst = m.content;
    e.lastRole = m.role;
    porConv.set(m.conversation_id, e);
  }

  const candidatos = convs.filter((c) => {
    const e = porConv.get(c.id);
    if (!e || e.lastUser == null || e.owner || e.tel) return false;
    const idle = now - e.lastUser;
    if (idle < IDLE_MIN_TEL || idle > MAX_IDLE_TEL) return false;
    // Si lo último que dijo el bot fue pedir el número, ya está esperando respuesta.
    if (e.lastRole === "assistant" && RE_PIDE_TEL.test(e.lastAsst)) return false;
    return true;
  });
  if (candidatos.length === 0) return { sent: 0 };

  // ¿Ya dejó un teléfono en su ficha? (leads es chica; solo se lee si hay candidatos)
  const conTelefono = new Set<string>();
  const leads = await db.all<{ conversation_id: string; contact: string | null }>(
    "SELECT conversation_id, contact FROM leads WHERE created_at > ? AND contact IS NOT NULL AND contact != ''",
    [now - 7 * 24 * H],
  );
  for (const l of leads) {
    if (l.contact && !l.contact.includes("@") && RE_TELEFONO.test(l.contact)) conTelefono.add(l.conversation_id);
  }

  let sent = 0;
  for (const c of candidatos) {
    if (conTelefono.has(c.id)) continue;
    if (sent >= MAX_POR_PASADA_TEL) break;
    if (!(await claim(db, "conversations", c.id, "viventa_pidetel", now))) continue;
    try {
      await enviarACliente(env, db, c, TEXTO_PEDIR_TELEFONO, null, porConv.get(c.id)?.lastUser ?? null, now);
      sent++;
    } catch (e) {
      console.error(`[sistemaViventa] pedir teléfono ${c.id}:`, e);
    }
  }
  if (sent > 0) {
    await avisarEquipo(env, "📞 Pedí el teléfono por Instagram", `Le escribí a ${sent} cliente(s) de Instagram que no habían dado su número, para poder llamarles/escribirles por WhatsApp. Cuando respondan, el número queda en su ficha y en el Excel.`);
  }
  return { sent };
}

// ─── 5. Pedir los datos que faltan para registrar en Zoho ──────────────────────

const PIDE: Record<string, string> = {
  apellido: "tu apellido",
  correo: "tu correo electrónico",
  "teléfono": "tu número de WhatsApp con el indicativo del país",
  "ciudad donde quiere comprar": "la ciudad de Colombia donde te gustaría comprar",
  "ciudad donde vive": "el país y la ciudad donde vives",
};

export function textoPedirDatos(nombre: string, faltan: string[]): string {
  const items = faltan.map((f) => PIDE[f] ?? f);
  const lista = items.length > 1 ? `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}` : items[0];
  return (
    `Hola${nombre ? ` ${nombre}` : ""} 😊 Para dejar registrada tu solicitud con el equipo comercial de Maricela ` +
    `me falta confirmar ${lista}. ¿Me lo compartes por aquí, por favor?`
  );
}

const MAX_POR_PASADA_DATOS = 5;
/** Ventana de texto libre con margen: WhatsApp 24 h, Instagram 22 h. */
const VENTANA_DATOS: Record<string, number> = { ycloud: 23 * H, zernio: 22 * H };

export async function runPedirDatos(env: Env, now = Date.now()): Promise<{ sent: number }> {
  const horaMadrid = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date(now)),
  );
  const enHorario = horaMadrid >= 9 && horaMadrid < 21;

  const db = new Db(env.DB);
  const { leadsPendientes, faltantes, enlaceRegistro } = await import("./resumenDia");
  const todos = (await leadsPendientes(db, now)).filter(({ conv }) => conv.channel === "ycloud" || conv.channel === "zernio");
  const marca = (meta: string | null, k: string): boolean => {
    try {
      return Boolean(JSON.parse(meta ?? "{}")[k]);
    } catch {
      return false;
    }
  };

  // Ya se les pidió y completaron lo que faltaba → aviso inmediato con el enlace listo.
  for (const { conv, lead } of todos) {
    if (!marca(conv.metadata, "viventa_pidedatos") || marca(conv.metadata, "viventa_completo")) continue;
    if (faltantes(lead).length > 0) continue;
    if (!(await claim(db, "conversations", conv.id, "viventa_completo", now))) continue;
    await avisarEquipo(env, "✅ Cliente completó sus datos", `${lead.nombre} ya respondió. Listo para registrar.\n\n${await enlaceRegistro(env, db, conv.id)}`);
  }

  if (!enHorario) return { sent: 0 };
  const pend = todos.filter(({ conv }) => !marca(conv.metadata, "viventa_pidedatos"));
  if (pend.length === 0) return { sent: 0 };

  const ids = pend.map((p) => p.conv.id);
  const recientes = await db.all<{ conversation_id: string; role: string; created_at: number }>(
    `SELECT conversation_id, role, created_at FROM messages WHERE created_at > ? AND conversation_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at ASC`,
    [now - 30 * H, ...ids],
  );
  const ult = new Map<string, { user: number | null; owner: boolean }>();
  for (const m of recientes) {
    const e = ult.get(m.conversation_id) ?? { user: null, owner: false };
    if (m.role === "user") e.user = m.created_at;
    if (m.role === "owner") e.owner = true;
    ult.set(m.conversation_id, e);
  }

  let sent = 0;
  for (const { conv, lead } of pend) {
    if (sent >= MAX_POR_PASADA_DATOS) break;
    const u = ult.get(conv.id);
    if (!u || u.user == null || u.owner) continue;
    const idle = now - u.user;
    if (idle < 45 * MIN || idle > VENTANA_DATOS[conv.channel]) continue;
    let falta = faltantes(lead);
    let yaPidioTel = false;
    try {
      yaPidioTel = Boolean(JSON.parse(conv.metadata ?? "{}").viventa_pidetel);
    } catch { /* metadata rota */ }
    if (yaPidioTel) falta = falta.filter((f) => f !== "teléfono");
    if (falta.length === 0) continue;
    if (!(await claim(db, "conversations", conv.id, "viventa_pidedatos", now))) continue;
    try {
      await enviarACliente(env, db, conv, textoPedirDatos(primerNombre(lead.nombre, conv.display_name), falta), null, u.user, now);
      sent++;
    } catch (e) {
      console.error(`[sistemaViventa] pedir datos ${conv.id}:`, e);
    }
  }
  if (sent > 0) {
    await avisarEquipo(env, "📝 Pedí datos que faltaban", `Le escribí a ${sent} cliente(s) para completar lo que exige el formulario de Zoho. Cuando respondan, el aviso con el enlace listo les llega a Camila y Maricela.`);
  }
  return { sent };
}

export async function runSistemaViventa(env: Env, now = Date.now()): Promise<void> {
  await runGuionSeguimiento(env, now).catch((e) => console.error("[sistemaViventa] guion:", e));
  await runSeguimientoProyectos(env, now).catch((e) => console.error("[sistemaViventa] proyectos:", e));
  await runRecordatoriosLlamada(env, now).catch((e) => console.error("[sistemaViventa] llamada:", e));
  await runPedirTelefono(env, now).catch((e) => console.error("[sistemaViventa] teléfono:", e));
  await runPedirDatos(env, now).catch((e) => console.error("[sistemaViventa] datos:", e));
  const { runResumenDia } = await import("./resumenDia");
  await runResumenDia(env, now).catch((e) => console.error("[sistemaViventa] resumen:", e));
}
