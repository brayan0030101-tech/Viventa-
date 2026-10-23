/**
 * AUDITOR. Cada 5 min revisa que ninguna conversación se quede trabada y deja constancia (tabla `auditoria_hallazgos`, visible en el
 * CRM → «Auditoría») y avisa al equipo una sola vez por hallazgo. Detecta:
 *  · listo_sin_cita — el cliente ya dio todos los datos (o tiene ticket «Lead calificado») y 45 min después no hay videollamada agendada;
 *  · sin_respuesta — el cliente escribió algo que parece pregunta/pedido y a los 10 min nadie respondió (bot ni persona);
 *  · handoff_silencioso — el bot abrió un ticket «Consulta fuera del guion» y no le dijo nada al cliente;
 *  · dato_sin_respaldo — el verificador bloqueó la respuesta del bot (el cliente recibió el comodín «lo confirma el equipo»);
 *  · entrega_fallida — WhatsApp/Instagram rechazó un mensaje (ventana de 24 h, saldo agotado, límite…);
 *  · fallo_ia — falló la IA al preparar la respuesta;
 *  · entrega_al_agente — un mensaje del cliente no pudo entregarse al bot (lo registra el webhook);
 *  · pausada_olvidada — una persona del equipo intervino (el bot quedó pausado) y el cliente lleva ≥ 3 h esperando respuesta; se vuelve a avisar cada 12 h hasta que alguien conteste;
 *  · cotizacion_fallida — el bot no pudo crear o enviar una cotización de ViveHome (lo registra src/vivehome/cola.ts).
 * Cada hallazgo se cierra solo cuando la situación se resuelve (cita agendada, alguien respondió, pasaron 24 h).
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { esCortesia } from "./sinRespuesta";
import { esNumeroColombiano } from "../channels/ycloud";

const MIN = 60_000;
const H = 3_600_000;

export type TipoHallazgo = "listo_sin_cita" | "sin_respuesta" | "handoff_silencioso" | "dato_sin_respaldo" | "entrega_fallida" | "fallo_ia" | "entrega_al_agente" | "mensaje_ilegible" | "revision_ia" | "mejora_sugerida" | "cotizacion_fallida" | "pausada_olvidada" | "instagram_sin_telefono";

export const ETIQUETA_TIPO: Record<TipoHallazgo, { icono: string; texto: string; grave: boolean }> = {
  listo_sin_cita: { icono: "🎯", texto: "Buen perfil sin videollamada agendada", grave: true },
  sin_respuesta: { icono: "💬", texto: "Cliente sin respuesta", grave: true },
  handoff_silencioso: { icono: "🤐", texto: "El bot pasó el caso al equipo y no le contestó al cliente", grave: true },
  dato_sin_respaldo: { icono: "🛑", texto: "El bot no pudo contestar (dato sin respaldo)", grave: true },
  entrega_fallida: { icono: "📵", texto: "Mensaje que no llegó al cliente", grave: true },
  fallo_ia: { icono: "⚠️", texto: "Falló la IA", grave: true },
  entrega_al_agente: { icono: "📥", texto: "Mensaje del cliente que no llegó al bot", grave: true },
  mejora_sugerida: { icono: "💡", texto: "Mejora sugerida para el bot", grave: false },
  revision_ia: { icono: "🧠", texto: "Revisión diaria con IA: el bot actuó mal", grave: true },
  instagram_sin_telefono: { icono: "📵", texto: "Cliente de Instagram que aún no pasó a WhatsApp (hay que empujarlo mientras la ventana está abierta)", grave: false },
  pausada_olvidada: { icono: "⏸️", texto: "Cliente esperando respuesta con el bot pausado (una persona intervino y no volvió a contestar)", grave: true },
  cotizacion_fallida: { icono: "🧾", texto: "Cotización del bot que falló (ViveHome)", grave: true },
  mensaje_ilegible: { icono: "🙈", texto: "Mensaje de WhatsApp que el bot no pudo leer (el cliente no recibió respuesta)", grave: true },
};

export interface Hallazgo {
  id: number;
  tipo: TipoHallazgo;
  conv_id: string;
  clave: string;
  detalle: string;
  creado: number;
  avisado_en: number | null;
  resuelto_en: number | null;
  /** Quién lo marcó como resuelto a mano (vacío si se cerró solo). */
  resuelto_por?: string | null;
}

export async function asegurarTablaAuditoria(db: Db): Promise<void> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS auditoria_hallazgos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, conv_id TEXT NOT NULL, clave TEXT NOT NULL DEFAULT '', detalle TEXT NOT NULL DEFAULT '', creado INTEGER NOT NULL, avisado_en INTEGER, resuelto_en INTEGER, UNIQUE (tipo, conv_id, clave))",
  );
  // Tablas creadas antes del 22 oct 2026 no tienen la columna «resuelto_por».
  const tiene = await db.first<{ x: number }>("SELECT 1 AS x FROM pragma_table_info('auditoria_hallazgos') WHERE name = 'resuelto_por'");
  if (!tiene) await db.run("ALTER TABLE auditoria_hallazgos ADD COLUMN resuelto_por TEXT").catch(() => undefined);
}

/** Marca un hallazgo como resuelto a mano («ya lo vimos»). */
export async function resolverHallazgo(db: Db, id: number, quien: string, now = Date.now()): Promise<boolean> {
  await asegurarTablaAuditoria(db);
  const r = await db.run("UPDATE auditoria_hallazgos SET resuelto_en = ?, resuelto_por = ? WHERE id = ? AND resuelto_en IS NULL", [now, quien.slice(0, 60), id]);
  return ((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

/** Marca como resueltos de una vez todos los abiertos con más de `dias` días (opcionalmente solo de un tipo). */
export async function resolverAntiguos(db: Db, dias: number, quien: string, tipo = "", now = Date.now()): Promise<number> {
  await asegurarTablaAuditoria(db);
  const r = await db.run(`UPDATE auditoria_hallazgos SET resuelto_en = ?, resuelto_por = ? WHERE resuelto_en IS NULL AND creado < ?${tipo ? " AND tipo = ?" : ""}`, tipo ? [now, quien.slice(0, 60), now - dias * 24 * H, tipo] : [now, quien.slice(0, 60), now - dias * 24 * H]);
  return (r as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

/** Vuelve a abrir uno marcado por error. */
export async function reabrirHallazgo(db: Db, id: number): Promise<void> {
  await asegurarTablaAuditoria(db);
  await db.run("UPDATE auditoria_hallazgos SET resuelto_en = NULL, resuelto_por = NULL WHERE id = ?", [id]);
}

/** Registra un hallazgo; true si es nuevo (no existía el mismo tipo + conversación + clave). */
export async function registrarHallazgo(env: Env, h: { tipo: TipoHallazgo; convId: string; clave?: string; detalle: string }, now = Date.now()): Promise<boolean> {
  if (esNumeroColombiano(h.convId.replace(/^\w+:/, ""))) return false; // regla fija: los números colombianos no se atienden ni se auditan
  const db = new Db(env.DB);
  await asegurarTablaAuditoria(db);
  const r = await db.run("INSERT OR IGNORE INTO auditoria_hallazgos (tipo, conv_id, clave, detalle, creado) VALUES (?,?,?,?,?)", [h.tipo, h.convId, h.clave ?? "", h.detalle.slice(0, 400), now]);
  return ((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

// ─── Detectores ──────────────────────────────────────────────────────────────

interface Candidato {
  tipo: TipoHallazgo;
  convId: string;
  clave: string;
  detalle: string;
}

const DATOS_OBLIGATORIOS = ["ciudadResidencia", "ciudadCompra", "entregaInmediataOFutura", "ahorroDisponible", "capacidadMensual", "tipoEmpleo", "ingresosMensuales"];

async function nombreDe(db: Db, convId: string): Promise<string> {
  return (await db.first<{ display_name: string | null }>("SELECT display_name FROM conversations WHERE id = ?", [convId]))?.display_name || "Cliente";
}

async function detectarSinRespuesta(db: Db, now: number): Promise<Candidato[]> {
  const ult = await db.all<{ conversation_id: string; created_at: number; content: string }>(
    "SELECT conversation_id, created_at, content FROM messages WHERE role = 'user' AND created_at BETWEEN ? AND ? ORDER BY created_at ASC",
    [now - 3 * H, now - 10 * MIN],
  );
  const porConv = new Map<string, { created_at: number; content: string }>();
  for (const m of ult) porConv.set(m.conversation_id, { created_at: m.created_at, content: m.content });
  const out: Candidato[] = [];
  for (const [id, m] of porConv) {
    if (esCortesia(m.content)) continue;
    const despues = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at > ? AND role IN ('assistant', 'owner')", [id, m.created_at]);
    if ((despues?.n ?? 0) > 0) continue;
    const conv = await db.first<{ display_name: string | null; channel: string; paused_until: number | null }>("SELECT display_name, channel, paused_until FROM conversations WHERE id = ?", [id]);
    if (!conv || !["ycloud", "zernio"].includes(conv.channel) || (conv.paused_until && conv.paused_until > now)) continue;
    out.push({ tipo: "sin_respuesta", convId: id, clave: String(m.created_at), detalle: `${conv.display_name || "Cliente"}: «${m.content.replace(/\s+/g, " ").slice(0, 90)}»` });
  }
  return out;
}

/** El bot se pausa cuando Maricela o Camila contestan: si después se les olvida, el cliente se enfría. Pasadas ≥ 3 h sin respuesta se avisa (hasta 10 días atrás). */
async function detectarPausadasOlvidadas(db: Db, now: number): Promise<Candidato[]> {
  const convs = await db.all<{ id: string; display_name: string | null; paused_until: number | null }>(
    "SELECT id, display_name, paused_until FROM conversations WHERE last_message_at BETWEEN ? AND ? AND channel IN ('ycloud', 'zernio')",
    [now - 10 * 24 * H, now - 3 * H],
  );
  const out: Candidato[] = [];
  for (const c of convs) {
    const ult = await db.first<{ role: string; created_at: number; content: string }>("SELECT role, created_at, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", [c.id]);
    if (!ult || ult.role !== "user" || now - ult.created_at < 3 * H || esCortesia(ult.content)) continue;
    const pausada = !!c.paused_until && c.paused_until > now;
    const intervino = pausada || ((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'owner' AND created_at > ?", [c.id, now - 10 * 24 * H]))?.n ?? 0) > 0;
    if (!intervino) continue;
    const leads = await db.all<{ name: string | null; intent: string | null; notes: string | null }>("SELECT name, intent, notes FROM leads WHERE conversation_id = ?", [c.id]);
    if (leads.some((l) => /no quiere continuar|ya no estoy interesad/i.test(`${l.intent ?? ""} ${l.notes ?? ""}`))) continue;
    const horas = Math.floor((now - ult.created_at) / H);
    const tiempo = horas >= 48 ? `${Math.floor(horas / 24)} días` : `${horas} h`;
    out.push({
      tipo: "pausada_olvidada",
      convId: c.id,
      clave: String(ult.created_at),
      detalle: `${c.display_name || leads.find((l) => l.name)?.name || "Cliente"} lleva ${tiempo} esperando respuesta${pausada ? " y el bot está pausado" : ""}: «${ult.content.replace(/\s+/g, " ").slice(0, 90)}»`,
    });
  }
  return out;
}

/** Instagram solo deja escribir 24 h: quien conversa mucho y no dio su WhatsApp se pierde después. Mientras la ventana está abierta, hay que pedírselo. */
async function detectarInstagramSinTelefono(db: Db, now: number): Promise<Candidato[]> {
  const convs = await db.all<{ id: string; display_name: string | null; metadata: string | null }>(
    "SELECT id, display_name, metadata FROM conversations WHERE channel = 'zernio' AND last_message_at > ? AND (paused_until IS NULL OR paused_until < ?)", [now - 20 * H, now]);
  const out: Candidato[] = [];
  for (const c of convs) {
    const n = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'", [c.id]))?.n ?? 0;
    if (n < 3) continue;
    if (/"viventa_puente"/.test(c.metadata ?? "")) continue; // ya pasó a WhatsApp
    const ls = await db.all<{ contact: string | null; intent: string | null }>("SELECT contact, intent FROM leads WHERE conversation_id = ?", [c.id]);
    if (ls.some((l) => (l.intent ?? "").startsWith("Cita ·"))) continue;
    if (ls.some((l) => String(l.contact ?? "").split(/[;,\s]+/).some((k) => !k.includes("@") && k.replace(/\D/g, "").length >= 8))) continue;
    out.push({ tipo: "instagram_sin_telefono", convId: c.id, clave: "", detalle: `${c.display_name || "Cliente"} lleva ${n} mensajes en Instagram y no ha pasado a WhatsApp: mándale el enlace o pídele su número ahora` });
  }
  return out;
}

async function detectarListosSinCita(db: Db, now: number): Promise<Candidato[]> {
  const convs = await db.all<{ id: string; display_name: string | null; paused_until: number | null }>(
    "SELECT id, display_name, paused_until FROM conversations WHERE last_message_at > ? AND channel IN ('ycloud', 'zernio')",
    [now - 23 * H],
  );
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.id);
  const leads: Array<{ conversation_id: string; name: string | null; contact: string | null; metadata: string | null; intent: string | null; updated_at: number }> = [];
  for (let i = 0; i < ids.length; i += 80) {
    const lote = ids.slice(i, i + 80);
    leads.push(...(await db.all<(typeof leads)[number]>(`SELECT conversation_id, name, contact, metadata, intent, updated_at FROM leads WHERE conversation_id IN (${lote.map(() => "?").join(",")})`, lote)));
  }
  const tickets = await db.all<{ conversation_id: string; created_at: number }>("SELECT conversation_id, created_at FROM tickets WHERE summary LIKE '[Lead calificado%' AND created_at > ?", [now - 23 * H]);
  const ticketDe = new Map<string, number>();
  for (const t of tickets) ticketDe.set(t.conversation_id, Math.min(t.created_at, ticketDe.get(t.conversation_id) ?? Infinity));
  const owners = new Set((await db.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM messages WHERE role = 'owner' AND created_at > ?", [now - 23 * H])).map((r) => r.conversation_id));

  const out: Candidato[] = [];
  for (const c of convs) {
    if (owners.has(c.id) || (c.paused_until && c.paused_until > now)) continue;
    const ls = leads.filter((l) => l.conversation_id === c.id);
    if (ls.some((l) => (l.intent ?? "").startsWith("Cita ·"))) continue;
    const datos: Record<string, string> = {};
    for (const l of ls.filter((x) => !(x.intent ?? "").startsWith("Cita ·"))) {
      try {
        Object.assign(datos, JSON.parse(l.metadata ?? "{}"));
      } catch {
        /* ficha rota */
      }
    }
    const tieneNombre = ls.some((l) => (l.name ?? "").trim().length > 2);
    const tieneCorreo = ls.some((l) => (l.contact ?? "").includes("@"));
    const completo = tieneNombre && tieneCorreo && DATOS_OBLIGATORIOS.every((k) => String(datos[k] ?? "").trim());
    const lista = ticketDe.get(c.id) ?? (completo ? Math.max(...ls.map((l) => l.updated_at)) : null);
    if (lista == null || now - lista < 45 * MIN) continue;
    out.push({ tipo: "listo_sin_cita", convId: c.id, clave: "", detalle: `${c.display_name || "Cliente"} ya dio todos sus datos y no tiene videollamada agendada` });
  }
  return out;
}

async function detectarTickets(db: Db, now: number): Promise<Candidato[]> {
  const out: Candidato[] = [];
  const ts = await db.all<{ id: string; conversation_id: string; summary: string; created_at: number }>(
    "SELECT id, conversation_id, summary, created_at FROM tickets WHERE (summary LIKE '[dato sin respaldo]%' OR summary LIKE '[Consulta fuera del guion]%') AND created_at > ?",
    [now - 6 * H],
  );
  for (const t of ts) {
    if (t.summary.startsWith("[dato sin respaldo]")) {
      out.push({ tipo: "dato_sin_respaldo", convId: t.conversation_id, clave: t.id, detalle: `${await nombreDe(db, t.conversation_id)}: el bot no pudo contestar y mandó «lo confirma el equipo»` });
    } else if (now - t.created_at > 5 * MIN) {
      const resp = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role IN ('assistant', 'owner') AND created_at > ?", [t.conversation_id, t.created_at - 2000]);
      if ((resp?.n ?? 0) === 0) out.push({ tipo: "handoff_silencioso", convId: t.conversation_id, clave: t.id, detalle: `${await nombreDe(db, t.conversation_id)}: ${t.summary.replace(/^\[[^\]]*\]\s*/, "").slice(0, 110)}` });
    }
  }
  return out;
}

async function detectarEntregasYFallosIA(db: Db, now: number): Promise<Candidato[]> {
  const out: Candidato[] = [];
  try {
    const fs = await db.all<{ id: number; canal: string; destino: string; detalle: string; ts: number }>("SELECT id, canal, destino, detalle, ts FROM envios_fallidos WHERE ts > ?", [now - 6 * H]);
    for (const f of fs) {
      const convId = `${f.canal}:${f.destino}`;
      out.push({ tipo: "entrega_fallida", convId, clave: String(f.id), detalle: `${await nombreDe(db, convId)}: ${/BALANCE/i.test(f.detalle) ? "saldo de YCloud agotado" : /131047|24 ?h/i.test(f.detalle) ? "pasaron más de 24 h desde su último mensaje" : f.detalle.slice(0, 90)}` });
    }
  } catch {
    /* la tabla aún no existe: no hubo fallos */
  }
  try {
    const ia = await db.all<{ id: number; conversation_id: string; message: string | null }>("SELECT id, conversation_id, message FROM ai_fallos WHERE at > ? AND es_reintento = 0", [now - 3 * H]);
    for (const f of ia) out.push({ tipo: "fallo_ia", convId: f.conversation_id, clave: String(f.id), detalle: `${await nombreDe(db, f.conversation_id)}: ${(f.message ?? "error de IA").slice(0, 100)}` });
  } catch {
    /* sin tabla */
  }
  return out;
}

// ─── Cierre automático ───────────────────────────────────────────────────────

async function cerrarResueltos(db: Db, now: number): Promise<number> {
  const abiertos = await db.all<Hallazgo>("SELECT * FROM auditoria_hallazgos WHERE resuelto_en IS NULL");
  let cerrados = 0;
  for (const h of abiertos) {
    let resuelto = now - h.creado > (h.tipo === "pausada_olvidada" ? 10 * 24 * H : 24 * H);
    if (!resuelto) {
      const conv = await db.first<{ paused_until: number | null; metadata: string | null }>("SELECT paused_until, metadata FROM conversations WHERE id = ?", [h.conv_id]);
      const pausada = !!conv?.paused_until && conv.paused_until > now;
      // Un cliente ya perdido, cerrado o descartado en el CRM no necesita atención: el caso se cierra solo.
      let descartado = false;
      try {
        const m = conv?.metadata ? (JSON.parse(conv.metadata) as { crm_etapa?: string; crm_descarte?: unknown }) : {};
        descartado = !!m.crm_descarte || m.crm_etapa === "perdido" || m.crm_etapa === "cerrado";
      } catch { /* metadatos rotos */ }
      const desde = h.tipo === "sin_respuesta" || h.tipo === "pausada_olvidada" ? Number(h.clave) : h.creado;
      const rol = h.tipo === "sin_respuesta" || h.tipo === "handoff_silencioso" || h.tipo === "mensaje_ilegible" || h.tipo === "pausada_olvidada" ? "('assistant', 'owner')" : "('owner')";
      const resp = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role IN ${rol} AND created_at > ?`, [h.conv_id, desde + (h.tipo === "handoff_silencioso" ? 0 : 1000)]);
      const cita = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE conversation_id = ? AND intent LIKE 'Cita ·%' AND created_at > ?", [h.conv_id, h.creado - 24 * H]);
      const cotizada = h.tipo === "cotizacion_fallida"
        ? (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM cotizaciones_enviadas WHERE tel = ? AND enviada_en > ?", [h.conv_id.replace(/^\w+:/, ""), h.creado]).catch(() => null))?.n ?? 0
        : 0;
      resuelto = descartado || cotizada > 0 || (resp?.n ?? 0) > 0 || ((h.tipo === "listo_sin_cita" || h.tipo === "dato_sin_respaldo" || h.tipo === "handoff_silencioso") && (cita?.n ?? 0) > 0) || (pausada && h.tipo !== "entrega_fallida" && h.tipo !== "pausada_olvidada");
    }
    if (resuelto) {
      await db.run("UPDATE auditoria_hallazgos SET resuelto_en = ? WHERE id = ?", [now, h.id]);
      cerrados++;
    }
  }
  return cerrados;
}

// ─── Pasada principal ────────────────────────────────────────────────────────

export async function runAuditor(env: Env, now = Date.now()): Promise<{ nuevos: number; cerrados: number }> {
  const db = new Db(env.DB);
  await asegurarTablaAuditoria(db);
  const candidatos: Candidato[] = [];
  for (const d of [detectarSinRespuesta, detectarPausadasOlvidadas, detectarInstagramSinTelefono, detectarListosSinCita, detectarTickets, detectarEntregasYFallosIA]) {
    try {
      candidatos.push(...(await d(db, now)));
    } catch (e) {
      console.error(`[auditor] ${d.name}:`, e);
    }
  }
  let nuevos = 0;
  let reintentos = 0;
  for (const c of candidatos) {
    if (await registrarHallazgo(env, { tipo: c.tipo, convId: c.convId, clave: c.clave, detalle: c.detalle }, now)) {
      nuevos++;
      // Un cliente sin respuesta no puede esperar a que alguien lo vea (caso zolanyi24, 23 oct 2026: el turno del bot se cortó y estuvo 1 h callado).
      // Se le hace UN reintento automático por mensaje (el hallazgo solo es «nuevo» una vez): el bot vuelve a contestar su último mensaje.
      if (c.tipo === "sin_respuesta" && reintentos < 3) {
        reintentos++;
        try {
          const conv = await db.first<{ channel: string; channel_user_id: string }>("SELECT channel, channel_user_id FROM conversations WHERE id = ?", [c.convId]);
          if (conv) {
            const { agentStub } = await import("../agent-stub");
            await agentStub(env, conv.channel as never, conv.channel_user_id).retryFailedTurn({ id: c.convId, channel: conv.channel, channelUserId: conv.channel_user_id });
          }
        } catch (e) {
          console.error(`[auditor] reintento de ${c.convId}:`, e);
        }
      }
    }
  }
  const cerrados = await cerrarResueltos(db, now);
  // Un cliente olvidado sigue esperando: se vuelve a avisar cada 12 h mientras nadie conteste.
  await db.run("UPDATE auditoria_hallazgos SET avisado_en = NULL WHERE tipo = 'pausada_olvidada' AND resuelto_en IS NULL AND avisado_en IS NOT NULL AND avisado_en < ?", [now - 12 * H]);

  // Aviso: todo lo abierto que aún no se avisó, en un solo mensaje.
  const sinAvisar = await db.all<Hallazgo>("SELECT * FROM auditoria_hallazgos WHERE resuelto_en IS NULL AND avisado_en IS NULL ORDER BY creado ASC LIMIT 30");
  if (sinAvisar.length > 0) {
    try {
      const { notifyCamila } = await import("../lib/camila");
      const lineas = sinAvisar.slice(0, 10).map((h) => `${ETIQUETA_TIPO[h.tipo].icono} ${ETIQUETA_TIPO[h.tipo].texto}\n   ${h.detalle}`);
      const ok = await notifyCamila(env, {
        heading: `🔎 Auditor: ${sinAvisar.length} ${sinAvisar.length === 1 ? "caso necesita" : "casos necesitan"} atención`,
        body: `${lineas.join("\n")}${sinAvisar.length > 10 ? `\n… y ${sinAvisar.length - 10} más` : ""}\n\nDetalle en el CRM → Auditoría.`,
        url: `${env.DASHBOARD_BASE_URL || ""}/crm/auditoria`,
      }).catch(() => false);
      // Se marca aunque no haya canal de aviso configurado: queda visible en la página de Auditoría.
      void ok;
      await db.run(`UPDATE auditoria_hallazgos SET avisado_en = ? WHERE id IN (${sinAvisar.map(() => "?").join(",")})`, [now, ...sinAvisar.map((h) => h.id)]);
    } catch (e) {
      console.error("[auditor] aviso:", e);
    }
  }
  return { nuevos, cerrados };
}
