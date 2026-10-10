// member/crm-ia.local.ts — CRM de Viventa, fase 4: análisis con IA de las conversaciones.
//  1) «Analizar esta conversación»: un cliente (qué pasó, dudas, qué hizo bien/mal el bot,
//     la mejor próxima acción para Maricela, sugerencias).
//  2) Análisis semanal automático: todas las conversaciones de la semana → recomendaciones
//     para mejorar el guion y la atención. Los nombres NO se envían a la IA: se le manda
//     «Cliente 7» y aquí se vuelve a poner el nombre real.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { armarLeads, type LeadResumen } from "../src/followup/resumenDia";
import { workModel } from "../src/llm/work-model";
import { notifyCamila, camilaConfigured } from "../src/lib/camila";
import { SettingsRepo } from "../src/db/settings";
import { esc, ESTILO_CRM, subnav, fechaHora, NIVEL } from "./crm.local";
import { calcularInforme, resumenGeneral } from "./crm-informes.local";

const H = 3600_000;
const DIA = 24 * H;

// ─── Almacén ─────────────────────────────────────────────────────────────────

export interface AnalisisGuardado {
  id: string;
  tipo: "conv" | "semanal";
  conversationId: string | null;
  creado: number;
  ultimoMensaje: number;
  contenido: string;
  modelo: string;
}

async function asegurarTabla(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_analisis (
       id TEXT PRIMARY KEY, tipo TEXT NOT NULL, conversation_id TEXT, creado INTEGER NOT NULL,
       ultimo_mensaje INTEGER NOT NULL DEFAULT 0, contenido TEXT NOT NULL, modelo TEXT NOT NULL DEFAULT ''
     )`,
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_crm_analisis_conv ON crm_analisis(conversation_id, creado)");
}

function fila(r: { id: string; tipo: string; conversation_id: string | null; creado: number; ultimo_mensaje: number; contenido: string; modelo: string }): AnalisisGuardado {
  return { id: r.id, tipo: r.tipo === "semanal" ? "semanal" : "conv", conversationId: r.conversation_id, creado: r.creado, ultimoMensaje: r.ultimo_mensaje, contenido: r.contenido, modelo: r.modelo };
}

export async function ultimoAnalisisConv(env: Env, convId: string): Promise<AnalisisGuardado | null> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const r = await db.first<Parameters<typeof fila>[0]>(
    "SELECT * FROM crm_analisis WHERE tipo = 'conv' AND conversation_id = ? ORDER BY creado DESC LIMIT 1",
    [convId],
  );
  return r ? fila(r) : null;
}

export async function analisisSemanales(env: Env, limite = 12): Promise<AnalisisGuardado[]> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const rs = await db.all<Parameters<typeof fila>[0]>(`SELECT * FROM crm_analisis WHERE tipo = 'semanal' ORDER BY creado DESC LIMIT ${limite}`);
  return rs.map(fila);
}

// ─── Textos para la IA ───────────────────────────────────────────────────────

const CONTEXTO_NEGOCIO = `Viventa (Maricela Naranjo) ayuda a colombianos en el exterior a comprar vivienda en Colombia. Un bot atiende por WhatsApp e Instagram con un guion corto de unas 13 preguntas (autorización de datos, nombre, correo, dónde vive, ciudad de interés, para quién, entrega inmediata o futura, ahorro, cuota mensual, empleo, ingresos, situación de residencia) y, a los clientes calientes y tibios, les ofrece una videollamada de 30 minutos con Maricela con botones de día y hora. Reglas del bot: un mensaje corto con una sola pregunta por turno, tono cercano, sin precios hasta el final, nunca promete créditos ni fechas, y cuando no sabe usa un mensaje comodín y pasa el caso a una persona. Los mensajes de «Equipo (persona)» los escribió una persona, no el bot.`;

const REGLAS_SALIDA = `Responde en español sencillo, directo y útil para Maricela (no técnica). Usa EXACTAMENTE los títulos con «## ». Frases cortas, viñetas con «- ». No inventes datos que no estén en las conversaciones; si algo no se sabe, dilo. Cuando critiques al bot, cita el mensaje (entre comillas) y propón cómo decirlo mejor.`;

/** Quita los marcadores [[botones: …]] y recorta. */
function limpio(t: string, max: number): string {
  const s = t.replace(/\[\[\s*botones?\s*:\s*([^\]]*)\]\]/gi, "(botones: $1)").replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Quita de un mensaje lo que identifica a la persona: correos, teléfonos y las palabras de su nombre. */
export function anonimizar(texto: string, nombre: string): string {
  let t = texto
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[correo]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[teléfono]");
  for (const w of nombre.split(/\s+/).filter((x) => x.replace(/[^\p{L}]/gu, "").length >= 3)) {
    const seguro = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`(?<![\\p{L}])${seguro}(?![\\p{L}])`, "giu"), "[nombre]");
  }
  return t;
}

const quien = (r: string): string => (r === "user" ? "CLIENTE" : r === "owner" ? "EQUIPO" : "BOT");

// ─── 1) Una conversación ─────────────────────────────────────────────────────

export interface ResultadoAnalisis {
  ok: boolean;
  analisis?: AnalisisGuardado;
  error?: string;
  reutilizado?: boolean;
}

export async function analizarConversacion(env: Env, convId: string, opts: { forzar?: boolean } = {}, now = Date.now()): Promise<ResultadoAnalisis> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const conv = await db.first<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number; metadata: string | null }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at, metadata FROM conversations WHERE id = ?",
    [convId],
  );
  if (!conv) return { ok: false, error: "No encontré esa conversación." };

  const previo = await ultimoAnalisisConv(env, convId);
  // Sin mensajes nuevos desde el último análisis: se reutiliza (no se gasta IA otra vez).
  if (previo && !opts.forzar && previo.ultimoMensaje >= conv.last_message_at) return { ok: true, analisis: previo, reutilizado: true };

  const msgs = await db.all<{ role: string; content: string; created_at: number }>(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 140",
    [convId],
  );
  msgs.reverse();
  if (msgs.length < 2) return { ok: false, error: "Todavía hay muy pocos mensajes para analizar." };

  const leadsRows = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
    "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
    [convId],
  );
  const [lead] = armarLeads([conv], leadsRows);
  const llamadas = await db.all<{ metadata: string | null }>("SELECT metadata FROM leads WHERE conversation_id = ? AND intent LIKE 'Cita · Videollamada%'", [convId]);
  const tickets = await db.all<{ summary: string; created_at: number }>("SELECT summary, created_at FROM tickets WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 6", [convId]);

  const ficha = lead
    ? Object.entries(lead.ficha.metadata).filter(([k, v]) => v && !/^(cita|cal)/i.test(k)).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "(sin ficha)";
  const transcript = msgs.map((m) => `[${fechaHora(m.created_at)}] ${quien(m.role)}: ${limpio(m.content, 600)}`).join("\n");

  const prompt = `${CONTEXTO_NEGOCIO}

CLIENTE (canal ${lead?.canal ?? conv.channel}; prioridad ${lead ? `${NIVEL[lead.prioridad.nivel].nombre}, ${lead.prioridad.puntos} puntos` : "sin ficha"}${llamadas.length ? `; ${llamadas.length} videollamada(s) agendada(s)` : ""}):
${ficha}

TICKETS DEL EQUIPO:
${tickets.map((t) => `- ${limpio(t.summary, 300)}`).join("\n") || "(ninguno)"}

CONVERSACIÓN (de la más antigua a la más reciente):
${transcript}

Analiza esta conversación. ${REGLAS_SALIDA} Máximo 330 palabras en total, con estas secciones:
## Resumen
## Dónde está el cliente
## Dudas y objeciones
## Lo que hizo bien el bot
## Lo que se puede mejorar
## Próxima mejor acción para Maricela
## Sugerencia para el guion del bot (solo si aplica)`;

  try {
    const llm = await workModel(env, "smart", "insights");
    const r = await llm.generate({ prompt, maxOutputTokens: 1400, temperature: 0.3 } as never);
    const texto = String((r as { text?: string }).text ?? "").trim();
    if (!texto) return { ok: false, error: "La IA no devolvió texto. Inténtalo de nuevo." };
    const id = crypto.randomUUID();
    await db.run("INSERT INTO crm_analisis (id, tipo, conversation_id, creado, ultimo_mensaje, contenido, modelo) VALUES (?, 'conv', ?, ?, ?, ?, ?)", [id, convId, now, conv.last_message_at, texto, llm.modelId]);
    return { ok: true, analisis: { id, tipo: "conv", conversationId: convId, creado: now, ultimoMensaje: conv.last_message_at, contenido: texto, modelo: llm.modelId } };
  } catch (e) {
    console.error("[crm-ia] analizarConversacion:", e);
    return { ok: false, error: "No pude consultar a la IA ahora. Inténtalo en unos minutos." };
  }
}

// ─── 2) Análisis semanal ─────────────────────────────────────────────────────

const MAX_CONVERSACIONES_SEMANA = 40;
const MAX_CARACTERES_SEMANA = 110_000;

/** Arma el texto que se le manda a la IA (sin nombres ni teléfonos) y el mapa «Cliente N» → nombre real. */
export async function prepararSemana(env: Env, now: number): Promise<{ texto: string; nombres: Map<string, string>; n: number } | null> {
  const db = new Db(env.DB);
  const desde = now - 7 * DIA;
  const convs = await db.all<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations WHERE last_message_at >= ? AND channel IN ('ycloud', 'zernio') ORDER BY last_message_at DESC LIMIT 200",
    [desde],
  );
  if (convs.length === 0) return null;
  const ids = new Set(convs.map((c) => c.id));
  const leadsRows = (
    await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
      "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE updated_at >= ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
      [desde - 30 * DIA],
    )
  ).filter((l) => l.conversation_id && ids.has(l.conversation_id));
  const leads = new Map(armarLeads(convs, leadsRows).map((l) => [l.convId, l]));
  const tks = await db.all<{ conversation_id: string | null; summary: string }>("SELECT conversation_id, summary FROM tickets WHERE created_at >= ?", [desde]);
  const tipoPorConv = new Map<string, string[]>();
  for (const t of tks) {
    if (!t.conversation_id) continue;
    const tipo = /^\[([^\]]{2,50})\]/.exec(t.summary)?.[1];
    if (tipo) tipoPorConv.set(t.conversation_id, [...(tipoPorConv.get(t.conversation_id) ?? []), tipo]);
  }
  const llamadas = new Set(
    (await db.all<{ conversation_id: string | null }>("SELECT conversation_id FROM leads WHERE intent LIKE 'Cita · Videollamada%' AND created_at >= ?", [desde])).map((r) => r.conversation_id ?? ""),
  );

  // Se priorizan las conversaciones con más sustancia: con ficha, con ticket o con llamada.
  const puntuadas = convs
    .map((c) => ({ c, p: (leads.has(c.id) ? 2 : 0) + (tipoPorConv.has(c.id) ? 2 : 0) + (llamadas.has(c.id) ? 1 : 0) }))
    .sort((a, b) => b.p - a.p || b.c.last_message_at - a.c.last_message_at)
    .slice(0, MAX_CONVERSACIONES_SEMANA);

  const nombres = new Map<string, string>();
  const bloques: string[] = [];
  let total = 0;
  const porConv = Math.floor(MAX_CARACTERES_SEMANA / puntuadas.length);
  let n = 0;
  for (const { c } of puntuadas) {
    const msgs = await db.all<{ role: string; content: string; created_at: number }>(
      "SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 80",
      [c.id, desde - 7 * DIA],
    );
    if (msgs.length < 2) continue;
    n++;
    const etiqueta = `Cliente ${n}`;
    const l: LeadResumen | undefined = leads.get(c.id);
    nombres.set(etiqueta, l?.nombre ?? c.display_name ?? c.channel_user_id);
    let cuerpo = "";
    const nombreReal = l?.nombre ?? c.display_name ?? "";
    const lineas = msgs.map((m) => `${quien(m.role)}: ${anonimizar(limpio(m.content, 260), nombreReal)}`);
    for (const ln of lineas) {
      if (cuerpo.length + ln.length > porConv) { cuerpo += "\n(…se recortó)"; break; }
      cuerpo += `${cuerpo ? "\n" : ""}${ln}`;
    }
    const cab = `### ${etiqueta} · ${l?.canal ?? (c.channel === "zernio" ? "Instagram" : "WhatsApp")} · ${l ? `${NIVEL[l.prioridad.nivel].nombre} (${l.prioridad.puntos} pts)` : "sin ficha"}${llamadas.has(c.id) ? " · AGENDÓ LLAMADA" : ""}${tipoPorConv.has(c.id) ? ` · tickets: ${[...new Set(tipoPorConv.get(c.id))].join(", ")}` : ""}`;
    bloques.push(`${cab}\n${cuerpo}`);
    total += cuerpo.length;
    if (total > MAX_CARACTERES_SEMANA) break;
  }
  if (bloques.length === 0) return null;
  return { texto: bloques.join("\n\n"), nombres, n: bloques.length };
}

function devolverNombres(texto: string, nombres: Map<string, string>): string {
  // De «Cliente 12» a «Ana López (Cliente 12)»; se hace de mayor a menor número para no pisar «Cliente 1» dentro de «Cliente 12».
  const claves = [...nombres.keys()].sort((a, b) => b.length - a.length);
  let out = texto;
  for (const k of claves) out = out.replace(new RegExp(`${k}(?!\\d)`, "g"), `${nombres.get(k)} (${k})`);
  return out;
}

export async function analizarSemana(env: Env, now = Date.now()): Promise<ResultadoAnalisis> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const base = await prepararSemana(env, now);
  if (!base || base.n < 3) return { ok: false, error: "Esta semana hay muy pocas conversaciones para analizar." };
  const inf = await calcularInforme(env, "7d", now);
  const prompt = `${CONTEXTO_NEGOCIO}

CIFRAS DE LOS ÚLTIMOS 7 DÍAS (ya calculadas):
${resumenGeneral(inf).map((t) => `- ${t.replace(/\*\*/g, "")}`).join("\n")}

A continuación van ${base.n} conversaciones de la semana (los nombres se cambiaron por «Cliente N»). CLIENTE = lo que escribió la persona; BOT = el bot; EQUIPO = una persona de Viventa.

${base.texto}

Eres un analista de ventas conversacionales. ${REGLAS_SALIDA}
Entrega, con estos títulos exactos:
## Resumen de la semana
(3 a 4 líneas)
## Las 5 mejoras que más valen la pena
(ordenadas por impacto; cada una con: qué cambiar, por qué, y un ejemplo con «Cliente N»)
## Dónde se pierden los clientes
(en qué pregunta o momento dejan de contestar y qué hacer)
## Lo que funciona y hay que mantener
## Mensajes del bot que confunden o espantan
(cita el mensaje y propón la redacción mejor)
## Preguntas de clientes que el bot maneja mal
## Cambios concretos sugeridos al guion o a las instrucciones del bot
(texto propuesto, listo para copiar)
## Clientes para contactar primero
(Cliente N y por qué)`;
  try {
    const llm = await workModel(env, "smart", "insights");
    const r = await llm.generate({ prompt, maxOutputTokens: 3500, temperature: 0.3 } as never);
    const crudo = String((r as { text?: string }).text ?? "").trim();
    if (!crudo) return { ok: false, error: "La IA no devolvió texto." };
    const texto = devolverNombres(crudo, base.nombres);
    const id = crypto.randomUUID();
    await db.run("INSERT INTO crm_analisis (id, tipo, conversation_id, creado, ultimo_mensaje, contenido, modelo) VALUES (?, 'semanal', NULL, ?, ?, ?, ?)", [id, now, now, texto, llm.modelId]);
    return { ok: true, analisis: { id, tipo: "semanal", conversationId: null, creado: now, ultimoMensaje: now, contenido: texto, modelo: llm.modelId } };
  } catch (e) {
    console.error("[crm-ia] analizarSemana:", e);
    return { ok: false, error: "No pude consultar a la IA ahora. Inténtalo en unos minutos." };
  }
}

/** Cron: los lunes entre las 9:00 y las 10:00 de España genera el análisis y avisa a Camila y Maricela. */
export async function runAnalisisSemanal(env: Env, now = Date.now()): Promise<{ hecho: boolean }> {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  if (g("weekday") !== "Mon" || Number(g("hour")) !== 9) return { hecho: false };
  const db = new Db(env.DB);
  const ajustes = new SettingsRepo(db);
  if (((await ajustes.get("viventa_analisis_semanal")) ?? "").trim().toLowerCase() === "off") return { hecho: false };
  const clave = `viventa_analisis_${g("year")}-${g("month")}-${g("day")}`;
  const res = await db.run("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", [clave, "1", now]);
  if ((res.meta?.changes ?? 0) === 0) return { hecho: false };
  const r = await analizarSemana(env, now);
  if (!r.ok || !r.analisis) {
    console.warn("[crm-ia] análisis semanal no generado:", r.error);
    return { hecho: false };
  }
  if (camilaConfigured(env)) {
    const origen = env.DASHBOARD_BASE_URL ? env.DASHBOARD_BASE_URL.replace(/\/$/, "") : "";
    const top = /## Las 5 mejoras[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(r.analisis.contenido)?.[1]?.trim().slice(0, 900) ?? "";
    await notifyCamila(env, {
      heading: "🧠 Análisis semanal del bot",
      body: `Ya está listo el análisis de la semana con recomendaciones para mejorar el guion y la atención.${top ? `\n\nLas mejoras principales:\n${top}` : ""}`,
      url: `${origen}/crm/recomendaciones`,
    }).catch(() => false);
  }
  return { hecho: true };
}

// ─── Vistas ──────────────────────────────────────────────────────────────────

/** Markdown mínimo (títulos «##», viñetas, negritas) → HTML seguro. */
export function mdHtml(md: string): string {
  const lineas = esc(md).split("\n");
  const out: string[] = [];
  let lista = false;
  const cerrar = () => { if (lista) { out.push("</ul>"); lista = false; } };
  const inline = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--cream)">$1</b>').replace(/&quot;(.+?)&quot;/g, "«$1»");
  for (const raw of lineas) {
    const ln = raw.trimEnd();
    if (/^#{2,3}\s+/.test(ln)) {
      cerrar();
      out.push(`<h4 style="font-family:'Space Grotesk';font-weight:700;font-size:14px;color:var(--accent);margin:16px 0 6px">${inline(ln.replace(/^#{2,3}\s+/, ""))}</h4>`);
    } else if (/^\s*[-*]\s+/.test(ln)) {
      if (!lista) { out.push('<ul style="margin:0 0 6px;padding-left:20px">'); lista = true; }
      out.push(`<li style="margin-bottom:4px">${inline(ln.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (/^\s*\d+[.)]\s+/.test(ln)) {
      cerrar();
      out.push(`<p style="margin:6px 0">${inline(ln)}</p>`);
    } else if (ln.trim() === "") {
      cerrar();
    } else {
      cerrar();
      out.push(`<p style="margin:5px 0">${inline(ln)}</p>`);
    }
  }
  cerrar();
  return `<div style="font-size:13px;line-height:1.65;color:var(--muted)">${out.join("")}</div>`;
}

/** Tarjeta para la ficha del cliente: botón + último análisis. */
export async function tarjetaAnalisisConv(env: Env, convId: string, lastMessageAt: number, opts: { error?: string; reutilizado?: boolean } = {}): Promise<string> {
  const a = await ultimoAnalisisConv(env, convId);
  const cid = encodeURIComponent(convId);
  const desactualizado = a && a.ultimoMensaje < lastMessageAt;
  const boton = (texto: string, forzar: boolean) =>
    `<form method="POST" action="/crm/c/${cid}/analizar" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Analizando… (unos 15 segundos)'">
      ${forzar ? '<input type="hidden" name="forzar" value="1">' : ""}
      <button class="bigbtn" style="background:var(--accent);color:var(--bg);padding:8px 14px;font-size:12px;font-weight:700;border:0;cursor:pointer">${texto}</button></form>`;
  return `<div class="crm-card" style="padding:16px;margin-bottom:14px;border-left:4px solid var(--accent)">
    <div class="crm-sec">🧠 Análisis con IA</div>
    ${opts.error ? `<div style="color:var(--bad);font-size:12.5px;margin-bottom:8px">${esc(opts.error)}</div>` : ""}
    ${a ? `${mdHtml(a.contenido)}
      <div class="text-dim" style="font-size:10.5px;margin:10px 0 8px">Analizado ${esc(fechaHora(a.creado))} (España) · ${esc(a.modelo)}${desactualizado ? " · hay mensajes nuevos desde entonces" : ""}</div>
      ${boton(desactualizado ? "Actualizar análisis" : "Volver a analizar", true)}`
      : `<div class="text-dim" style="font-size:12.5px;margin-bottom:10px">La IA lee toda la conversación y explica qué pasó, qué dudas tiene el cliente, qué hizo bien y mal el bot y qué hacer ahora. Cuesta unos 2 centavos de dólar.</div>${boton("Analizar esta conversación", false)}`}
  </div>`;
}

export async function renderCrmRecomendaciones(env: Env, opts: { id?: string; mensaje?: string; error?: string } = {}, now = Date.now()): Promise<string> {
  const lista = await analisisSemanales(env);
  const elegido = lista.find((x) => x.id === opts.id) ?? lista[0];
  const historial = lista
    .map((x) => `<a href="/crm/recomendaciones?id=${x.id}" style="display:block;padding:7px 10px;border-bottom:1px dashed var(--line);font-size:12px;color:${x.id === elegido?.id ? "var(--cream)" : "var(--muted)"};${x.id === elegido?.id ? "background:var(--accent-soft)" : ""}">${esc(fechaHora(x.creado))}</a>`)
    .join("");
  const ultimaGeneracion = lista[0]?.creado ?? 0;
  const enfriamiento = now - ultimaGeneracion < 30 * 60_000;
  const cuerpo = elegido
    ? `<div class="crm-card" style="padding:18px 22px">
        <div class="text-dim" style="font-size:11px;margin-bottom:6px">Análisis del ${esc(fechaHora(elegido.creado))} (hora de España) · ${esc(elegido.modelo)}</div>
        ${mdHtml(elegido.contenido)}
      </div>`
    : `<div class="crm-card" style="padding:30px;text-align:center;color:var(--dim)">Todavía no hay ningún análisis. El primero se genera solo el próximo lunes a las 9:00 (hora de España), o puedes generarlo ahora con el botón.</div>`;
  const body = `${ESTILO_CRM}
    ${subnav("recomendaciones")}
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div>
        <div style="font-weight:700;font-size:16px;color:var(--cream)">Recomendaciones para mejorar el bot y la atención</div>
        <div class="text-dim" style="font-size:12px">Una IA lee las conversaciones de la semana y dice qué cambiar. Se genera sola cada lunes a las 9:00 y avisa a Camila y a Maricela por Telegram.</div>
      </div>
      <form method="POST" action="/crm/recomendaciones/generar" style="margin-left:auto" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Analizando… (puede tardar un minuto)'">
        <button class="bigbtn" ${enfriamiento ? "disabled title=\"Ya se generó hace menos de 30 minutos\"" : ""} style="background:var(--accent);color:var(--bg);padding:9px 16px;font-size:12.5px;font-weight:700;border:0;cursor:${enfriamiento ? "not-allowed" : "pointer"};opacity:${enfriamiento ? ".5" : "1"}">Generar análisis ahora (≈ $0,10)</button>
      </form>
    </div>
    ${opts.error ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:12px;color:var(--bad);font-size:12.5px">${esc(opts.error)}</div>` : ""}
    ${opts.mensaje ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:12px;color:var(--ok);font-size:12.5px">${esc(opts.mensaje)}</div>` : ""}
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:16px;align-items:start">
      <div>${cuerpo}</div>
      <div class="crm-card"><div class="crm-sec" style="padding:10px 10px 0">Anteriores</div>${historial || '<div class="text-dim" style="padding:10px;font-size:12px">—</div>'}</div>
    </div>`;
  return crmLayout({ title: "Recomendaciones", activa: "recomendaciones", body, env });
}
