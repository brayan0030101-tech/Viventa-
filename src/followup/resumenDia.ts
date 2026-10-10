/**
 * Resumen diario para Maricela (Viventa), una vez al día a las 8:00 de España:
 *
 *  1. Mensaje de Telegram con los leads de las últimas 24 h ordenados por
 *     prioridad (🔥 caliente / 🟡 tibio / ⚪ frío): a quién llamar primero, con
 *     teléfono, hora pedida y los datos que pesan (ahorro, pago mensual, trabajo).
 *  2. Un CSV listo para importar en Zoho CRM con los leads que aún no se
 *     exportaron (cada conversación se exporta una sola vez).
 *
 * Solo lee y avisa al equipo; no escribe a ningún cliente. Se reclama por día
 * (una fila en settings): una segunda pasada el mismo día no repite nada.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { selfOrigin } from "../lib/self-origin";
import { camilaConfigured, notifyCamila, notifyCamilaDocument } from "../lib/camila";
import { buildXlsx, type Celda } from "../lib/xlsx";

const H = 3600_000;
const MAX_LINEAS = 15;
/** Ajustes en D1 (no en el repo, que es público): enlace del formulario y CSV opcional. */
export const SETTING_FORM_URL = "viventa_form_url";
const SETTING_CSV = "viventa_csv_activo";

// ─── Puntuación ────────────────────────────────────────────────────────────────

/** Primer monto de un texto libre, en euros aprox. ("15 mil", "10.000", "20 millones de pesos"). */
export function parseMonto(texto: string | null | undefined): number {
  const t = String(texto ?? "").toLowerCase();
  const m = t.match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(millones|mill[oó]n|miles|mil|k)?(?![a-záéíóúñ])/);
  if (!m) return 0;
  let raw = m[1];
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, "");
  else raw = raw.replace(",", ".");
  let n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const suf = m[2] ?? "";
  if (/^mill/.test(suf)) n *= 1_000_000;
  else if (suf === "mil" || suf === "miles" || suf === "k") n *= 1_000;
  // Montos enormes o en pesos colombianos → euros aproximados.
  if (/cop|peso|colomb/.test(t) || n >= 5_000_000) n = n / 4500;
  return Math.round(n);
}

export interface FichaLead {
  metadata: Record<string, string>;
  notas: string;
  telefono: string;
}

export interface Prioridad {
  nivel: "caliente" | "tibio" | "frio";
  puntos: number;
}

const CAMPOS_FICHA = [
  "ciudadResidencia", "ciudadCompra", "motivoCompra", "entregaInmediataOFutura",
  "ahorroDisponible", "capacidadMensual", "tipoEmpleo", "antiguedadLaboral", "compraSoloOAcompanado",
];

export function puntuarLead(f: FichaLead): Prioridad {
  const m = f.metadata;
  let p = 0;
  const ahorro = parseMonto(m.ahorroDisponible);
  const dijoSi = /(s[ií]\s+(tiene|cuenta|dispone)|tiene\s+ahorro|ahorro\s+disponible)/i.test(m.ahorroDisponible ?? "") && !/\bno\b/i.test((m.ahorroDisponible ?? "").slice(0, 12));
  p += ahorro >= 15_000 ? 3 : ahorro >= 5_000 ? 2 : ahorro > 0 || dijoSi ? 1 : 0;
  const mes = parseMonto(m.capacidadMensual);
  p += mes >= 800 ? 2 : mes >= 300 ? 1 : 0;
  if (/(contrato|indefinid|fijo|empleado|n[oó]mina|aut[oó]nomo|empresa|funcionari)/i.test(m.tipoEmpleo ?? "")) p += 1;
  if (/(inmediat|ya\b|ahora|pronto)/i.test(m.entregaInmediataOFutura ?? "")) p += 2;
  if (f.telefono) p += 1;
  const ingresos = parseMonto(m.ingresosMensuales);
  p += ingresos >= 2_000 ? 1 : 0;
  if (/hora de llamada/i.test(f.notas)) p += 1;
  if (CAMPOS_FICHA.filter((k) => m[k]).length >= 6) p += 1;
  return { puntos: p, nivel: p >= 6 ? "caliente" : p >= 3 ? "tibio" : "frio" };
}

// ─── Datos de los leads ────────────────────────────────────────────────────────

interface LeadRow {
  conversation_id: string | null;
  name: string | null;
  contact: string | null;
  notes: string | null;
  metadata: string | null;
}
interface ConvInfo {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  last_message_at: number;
}

export interface LeadResumen {
  convId: string;
  canal: "WhatsApp" | "Instagram" | "Telegram" | string;
  nombre: string;
  telefono: string;
  correo: string;
  ficha: FichaLead;
  prioridad: Prioridad;
  horaLlamada: string;
  /** Videollamada ya agendada en Cal.com (fecha y hora de España), si la hay. */
  llamada: string;
}

function canalDe(channel: string): string {
  return channel === "ycloud" ? "WhatsApp" : channel === "zernio" || channel === "instagram" ? "Instagram" : channel === "telegram" ? "Telegram" : channel;
}

/** Junta los leads de cada conversación (el dato más reciente de cada campo gana). */
export function armarLeads(convs: ConvInfo[], leads: LeadRow[], llamadas: Map<string, number> = new Map()): LeadResumen[] {
  const porConv = new Map<string, LeadRow[]>();
  for (const l of leads) {
    if (!l.conversation_id) continue;
    const a = porConv.get(l.conversation_id) ?? [];
    a.push(l);
    porConv.set(l.conversation_id, a);
  }
  const out: LeadResumen[] = [];
  for (const c of convs) {
    const ls = porConv.get(c.id);
    if (!ls?.length) continue;
    let nombre = "";
    const meta: Record<string, string> = {};
    const notas: string[] = [];
    const telefonos: string[] = [];
    const correos: string[] = [];
    for (const l of ls) {
      if (l.name) nombre = l.name;
      if (l.notes && !notas.includes(l.notes)) notas.push(l.notes);
      if (l.metadata) {
        try { Object.assign(meta, JSON.parse(l.metadata)); } catch { /* fila rota */ }
      }
      for (const k of String(l.contact ?? "").split(/[;,\s]+/).filter(Boolean)) {
        if (k.includes("@")) { if (!correos.includes(k.toLowerCase())) correos.push(k.toLowerCase()); }
        else if (k.replace(/\D/g, "").length >= 7 && !telefonos.includes(k)) telefonos.push(k);
      }
    }
    const telefono = c.channel === "ycloud" ? `+${c.channel_user_id}` : (telefonos[telefonos.length - 1] ?? "");
    const notasTxt = notas.join(" | ");
    const ficha: FichaLead = { metadata: meta, notas: notasTxt, telefono };
    const hora = notasTxt.match(/hora de llamada[^|;\n]*/i)?.[0]?.trim() ?? "";
    out.push({
      convId: c.id,
      canal: canalDe(c.channel),
      nombre: nombre || c.display_name || "(sin nombre)",
      telefono,
      correo: correos.join(", "),
      ficha,
      prioridad: puntuarLead(ficha),
      horaLlamada: hora,
      llamada: llamadas.has(c.id) ? formatoLlamada(llamadas.get(c.id)!) : "",
    });
  }
  return out;
}

/** Dominio reservado (.invalid nunca existe): el correo inventado jamás le llega a nadie real. */
const DOMINIO_SIN_CORREO = "correo-no-proporcionado.invalid";

/**
 * El formulario exige correo. Si el cliente no lo dio, por pedido de Maricela se
 * usa uno inventado con su nombre, siempre en un dominio que no existe y marcado
 * como tal en el Excel y en los avisos (nunca pasa por real).
 */
export function correoParaFormulario(l: LeadResumen): { correo: string; inventado: boolean } {
  const real = l.correo.split(",")[0].trim();
  if (real) return { correo: real, inventado: false };
  const slug = l.nombre
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "cliente";
  return { correo: `${slug}@${DOMINIO_SIN_CORREO}`, inventado: true };
}

/** «mar 14 oct, 10:00» en hora de España. */
export function formatoLlamada(ms: number): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

/** Videollamadas reservadas en Cal.com que aún no pasaron: conversación → instante de inicio. */
export async function llamadasAgendadas(db: Db, now: number): Promise<Map<string, number>> {
  const rows = await db.all<{ conversation_id: string | null; metadata: string | null }>(
    "SELECT conversation_id, metadata FROM leads WHERE intent LIKE 'Cita ·%' AND updated_at > ?",
    [now - 30 * 24 * H],
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.conversation_id || !r.metadata) continue;
    try {
      const m = JSON.parse(r.metadata) as { calStart?: string; estado?: string };
      const t = m.calStart ? Date.parse(m.calStart) : NaN;
      if (m.estado === "Reservada (Cal.com)" && Number.isFinite(t) && t > now) out.set(r.conversation_id, t);
    } catch { /* metadata rota */ }
  }
  return out;
}

/** Datos que exige el formulario y que aún no tenemos del cliente (el correo no cuenta: se inventa). */
export function faltantes(l: LeadResumen): string[] {
  const m = l.ficha.metadata;
  const partes = l.nombre.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  if (partes.length < 2) out.push("apellido");
  if (!l.telefono) out.push("teléfono");
  if (!m.ciudadCompra) out.push("ciudad donde quiere comprar");
  if (!m.ciudadResidencia || !m.ciudadResidencia.includes(",")) out.push("ciudad donde vive");
  return out;
}

const ICONO = { caliente: "🔥", tibio: "🟡", frio: "⚪" } as const;

export function lineaLead(l: LeadResumen, formUrl?: string): string {
  const m = l.ficha.metadata;
  const partes = [
    `${ICONO[l.prioridad.nivel]} ${l.nombre} · ${l.canal}${l.telefono ? ` · ${l.telefono}` : " · SIN TELÉFONO"}`,
    l.llamada ? `📞 Llamada agendada: ${l.llamada} (hora de España)` : l.horaLlamada ? `📞 ${l.horaLlamada}` : "",
    [m.ciudadResidencia && `Vive: ${m.ciudadResidencia}`, m.ciudadCompra && `Quiere: ${m.ciudadCompra}`].filter(Boolean).join(" · "),
    [m.ahorroDisponible && `Ahorro: ${m.ahorroDisponible}`, m.capacidadMensual && `Mensual: ${m.capacidadMensual}`, m.tipoEmpleo && `Trabajo: ${m.tipoEmpleo}`, m.ingresosMensuales && `Ingresos: ${m.ingresosMensuales}`].filter(Boolean).join(" · "),
    formUrl
      ? faltantes(l).length
        ? `⚠️ Falta: ${faltantes(l).join(", ")} (el formulario los exige)\n📝 ${urlFormulario(formUrl, l)}`
        : `✅ Listo para registrar${correoParaFormulario(l).inventado ? " (correo inventado: el cliente no lo dio)" : ""}: ${urlFormulario(formUrl, l)}`
      : "",
  ].filter(Boolean);
  return partes.join("\n");
}

const MAX_MENSAJE = 3600;

/** Resumen listo para Telegram: cabecera + leads ordenados, partido en mensajes de ≤ 3600 caracteres. */
export function mensajesResumen(leads: LeadResumen[], panelUrl: string, formUrl?: string): string[] {
  const orden = { caliente: 0, tibio: 1, frio: 2 } as const;
  const ord = [...leads].sort((a, b) => orden[a.prioridad.nivel] - orden[b.prioridad.nivel] || b.prioridad.puntos - a.prioridad.puntos);
  const n = (nivel: string) => leads.filter((l) => l.prioridad.nivel === nivel).length;
  const sinTel = leads.filter((l) => !l.telefono).length;
  const cab =
    `${leads.length} lead(s) en las últimas 24 h\n` +
    `🔥 ${n("caliente")} calientes · 🟡 ${n("tibio")} tibios · ⚪ ${n("frio")} fríos` +
    (sinTel ? ` · ${sinTel} sin teléfono` : "");
  const bloques = ord.slice(0, MAX_LINEAS).map((l) => lineaLead(l, formUrl));
  const pie = (ord.length > MAX_LINEAS ? `… y ${ord.length - MAX_LINEAS} más en el panel.\n\n` : "") + panelUrl;

  const out: string[] = [];
  let actual = cab;
  for (const b of bloques) {
    if (actual.length + b.length + 2 > MAX_MENSAJE) {
      out.push(actual);
      actual = b;
    } else actual += `\n\n${b}`;
  }
  out.push(`${actual}\n\n${pie}`);
  return out;
}

// ─── Formulario de registro (Zoho Forms) ───────────────────────────────────────

/** Opciones del desplegable «Ciudad de interés» del formulario. */
const CIUDADES_FORM = ["Bogotá", "Cali", "Medellín", "Barranquilla", "Pereira", "Cartagena"];
/** Opciones del desplegable «País de residencia» del formulario. */
const PAISES_FORM = ["USA", "España", "Canadá", "Chile", "Reino Unido", "Francia", "Italia", "Alemania", "Suiza"];

const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function opcion(texto: string | undefined, opciones: string[], alias: Record<string, string> = {}): string {
  const t = sinTildes(texto ?? "");
  for (const [k, v] of Object.entries(alias)) if (t.includes(k)) return v;
  return opciones.find((o) => t.includes(sinTildes(o))) ?? "";
}

/**
 * Enlace del formulario con los datos del cliente ya escritos (Zoho Forms admite
 * valores iniciales por la URL). Maricela solo revisa, marca los términos y envía.
 * Los campos fijos del formulario (fuente, canal, etc.) los pone el propio formulario.
 */
export function urlFormulario(base: string, l: LeadResumen): string {
  const partes = l.nombre.trim().split(/\s+/).filter(Boolean);
  const [pais, ...ciudad] = (l.ficha.metadata.ciudadResidencia ?? "").split(",").map((x) => x.trim());
  const tel = l.telefono.replace(/[^\d+]/g, "");
  const params: Array<[string, string]> = [
    ["Name_First", partes.length > 1 ? partes[0] : partes[0] ?? ""],
    ["Name_Last", partes.length > 1 ? partes.slice(1).join(" ") : ""],
    ["Email", correoParaFormulario(l).correo],
    ["PhoneNumber", tel],
    ["Dropdown", opcion(l.ficha.metadata.ciudadCompra, CIUDADES_FORM)],
    ["Dropdown1", opcion(pais, PAISES_FORM, { "estados unidos": "USA", eeuu: "USA", "ee.uu": "USA", usa: "USA" })],
    ["SingleLine", ciudad.join(", ")],
  ];
  const qs = params.filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
}

// ─── CSV para Zoho ─────────────────────────────────────────────────────────────

const CSV_COLS = ["First Name", "Last Name", "Email", "Phone", "Lead Source", "Country", "City", "Description"];

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function csvZoho(leads: LeadResumen[]): string {
  const filas = leads.map((l) => {
    const partes = l.nombre.trim().split(/\s+/);
    const first = partes.length > 1 ? partes[0] : "";
    const last = partes.length > 1 ? partes.slice(1).join(" ") : partes[0] ?? "";
    const m = l.ficha.metadata;
    const viveEn = (m.ciudadResidencia ?? "").split(",").map((s) => s.trim());
    const desc = [
      m.ciudadCompra && `Quiere comprar en: ${m.ciudadCompra}`,
      m.motivoCompra && `Para: ${m.motivoCompra}`,
      m.entregaInmediataOFutura && `Entrega: ${m.entregaInmediataOFutura}`,
      m.ahorroDisponible && `Ahorro: ${m.ahorroDisponible}`,
      m.capacidadMensual && `Pago mensual: ${m.capacidadMensual}`,
      m.tipoEmpleo && `Trabajo: ${m.tipoEmpleo}`,
      m.ingresosMensuales && `Ingresos mensuales: ${m.ingresosMensuales}`,
      m.antiguedadLaboral && `Antigüedad: ${m.antiguedadLaboral}`,
      correoParaFormulario(l).inventado && "CORREO INVENTADO (el cliente no lo dio)",
      l.ficha.notas && `Notas: ${l.ficha.notas}`,
      `Prioridad: ${l.prioridad.nivel}`,
    ].filter(Boolean).join(" | ");
    return [first, last, correoParaFormulario(l).correo, l.telefono, l.canal, viveEn[0] ?? "", viveEn[1] ?? "", desc].map(csvCell).join(",");
  });
  return "﻿" + [CSV_COLS.join(","), ...filas].join("\r\n") + "\r\n";
}

// ─── Cron ──────────────────────────────────────────────────────────────────────

function madridParts(now: number): { hora: number; dia: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { hora: Number(p.hour) % 24, dia: `${p.year}-${p.month}-${p.day}` };
}

/**
 * Línea del resumen: cuántas videollamadas agendó el bot y cuántas se le fueron a
 * Maricela por el comodín («otro horario»). Tablas chicas, una vez al día.
 */
export async function lineaLlamadas(db: Db, now: number): Promise<string> {
  const cuenta = async (desde: number) => {
    const agendadas = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM leads
        WHERE created_at > ? AND intent LIKE 'Cita · Videollamada%'
          AND json_extract(COALESCE(metadata, '{}'), '$.estado') = 'Reservada (Cal.com)'`,
      [desde],
    );
    const comodin = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tickets WHERE created_at > ? AND summary LIKE '%otro horario%'",
      [desde],
    );
    return { a: agendadas?.n ?? 0, c: comodin?.n ?? 0 };
  };
  const dia = await cuenta(now - 24 * H);
  const semana = await cuenta(now - 7 * 24 * H);
  return `📞 Llamadas · el bot agendó ${dia.a} (pasó a Maricela por otro horario: ${dia.c}) · últimos 7 días: ${semana.a} agendadas, ${semana.c} por comodín`;
}

export async function runResumenDia(env: Env, now = Date.now()): Promise<{ sent: boolean; leads: number }> {
  const { hora, dia } = madridParts(now);
  if (hora !== 8 || !camilaConfigured(env)) return { sent: false, leads: 0 };

  const db = new Db(env.DB);
  // Una vez al día: la fila del día se crea solo la primera vez.
  const res = await db.run("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", [`viventa_resumen_${dia}`, "1", now]);
  if ((res.meta?.changes ?? 0) === 0) return { sent: false, leads: 0 };

  const desde = now - 24 * H;
  const convs = await db.all<ConvInfo>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations WHERE last_message_at > ? AND json_extract(COALESCE(metadata, '{}'), '$.viventa_registrado') IS NULL AND json_extract(COALESCE(metadata, '{}'), '$.viventa_existente') IS NULL",
    [desde],
  );
  if (convs.length === 0) return { sent: false, leads: 0 };
  const ids = new Set(convs.map((c) => c.id));
  const leadsRows = (
    await db.all<LeadRow>(
      "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE updated_at > ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
      [now - 14 * 24 * H],
    )
  ).filter((l) => l.conversation_id && ids.has(l.conversation_id));
  const leads = armarLeads(convs, leadsRows, await llamadasAgendadas(db, now));
  if (leads.length === 0) return { sent: false, leads: 0 };

  const url = `${await selfOrigin(env)}/admin`;
  const settings = new SettingsRepo(db);
  const formUrl = ((await settings.get(SETTING_FORM_URL)) ?? "").trim() || undefined;
  const msgs = mensajesResumen(leads, url, formUrl);
  try {
    msgs[0] = `${await lineaLlamadas(db, now)}\n\n${msgs[0]}`;
  } catch (e) {
    console.error("[resumenDia] lineaLlamadas:", e);
  }
  for (let i = 0; i < msgs.length; i++) {
    await notifyCamila(env, {
      heading: i === 0 ? "☀️ Resumen del día" : `☀️ Resumen del día (${i + 1}/${msgs.length})`,
      body: msgs[i],
    });
  }

  // CSV para importar en Zoho: opcional (settings viventa_csv_activo = 1). El camino
  // normal de registro es el formulario, con los enlaces del propio resumen.
  if (((await settings.get(SETTING_CSV)) ?? "") === "1") {
    const nuevos: LeadResumen[] = [];
    for (const l of leads) {
      if (!l.telefono && !l.correo) continue;
      const r = await db.run(
        `UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_csv', ?)
          WHERE id = ? AND json_extract(COALESCE(metadata, '{}'), '$.viventa_csv') IS NULL`,
        [dia, l.convId],
      );
      if ((r.meta?.changes ?? 0) > 0) nuevos.push(l);
    }
    if (nuevos.length > 0) {
      await notifyCamilaDocument(env, {
        filename: `leads_zoho_${dia}.csv`,
        content: csvZoho(nuevos),
        caption: `📎 ${nuevos.length} lead(s) nuevos para importar en Zoho (Leads → Importar). En duplicados elige «Omitir».`,
      });
    }
  }
  return { sent: true, leads: leads.length };
}

// ─── Aviso inmediato y control de «registrado» ─────────────────────────────────

/** Enlace de registro de UNA conversación, o "" si no hay formulario configurado. Nunca lanza. */
export async function enlaceRegistro(env: Env, db: Db, conversationId: string | null): Promise<string> {
  if (!conversationId) return "";
  try {
    const formUrl = ((await new SettingsRepo(db).get(SETTING_FORM_URL)) ?? "").trim();
    if (!formUrl) return "";
    const convs = await db.all<ConvInfo>(
      "SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations WHERE id = ?",
      [conversationId],
    );
    const leads = await db.all<LeadRow>(
      "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
      [conversationId],
    );
    const [l] = armarLeads(convs, leads);
    if (!l) return "";
    const falta = faltantes(l);
    return falta.length
      ? `⚠️ Falta: ${falta.join(", ")} (el formulario los exige)\n📝 Registrar en Zoho: ${urlFormulario(formUrl, l)}`
      : `✅ Listo para registrar en Zoho${correoParaFormulario(l).inventado ? " (correo inventado: el cliente no lo dio)" : ""}: ${urlFormulario(formUrl, l)}`;
  } catch (e) {
    console.error("[resumenDia] enlaceRegistro:", e);
    return "";
  }
}

const norm = (t: string) => sinTildes(t).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

interface Pendiente {
  convId: string;
  nombre: string;
}

/** Leads calificados de los últimos 7 días que aún no están registrados ni marcados como existentes. */
export async function leadsPendientes(db: Db, now: number): Promise<Array<{ conv: ConvInfo & { metadata: string | null }; lead: LeadResumen }>> {
  const tickets = await db.all<{ conversation_id: string }>(
    "SELECT DISTINCT conversation_id FROM tickets WHERE created_at > ? AND summary LIKE '[Lead calificado%' AND conversation_id IS NOT NULL",
    [now - 7 * 24 * H],
  );
  if (tickets.length === 0) return [];
  const ids = tickets.map((t) => t.conversation_id);
  const marks = ids.map(() => "?").join(",");
  const convs = await db.all<ConvInfo & { metadata: string | null }>(
    `SELECT id, channel, channel_user_id, display_name, last_message_at, metadata FROM conversations
      WHERE id IN (${marks}) AND json_extract(COALESCE(metadata, '{}'), '$.viventa_registrado') IS NULL AND json_extract(COALESCE(metadata, '{}'), '$.viventa_existente') IS NULL`,
    ids,
  );
  if (convs.length === 0) return [];
  const leads = await db.all<LeadRow>(
    `SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id IN (${convs.map(() => "?").join(",")}) AND intent NOT LIKE 'Cita ·%'`,
    convs.map((c) => c.id),
  );
  const porId = new Map(convs.map((c) => [c.id, c]));
  return armarLeads(convs, leads).map((lead) => ({ conv: porId.get(lead.convId)!, lead }));
}

async function pendientesRegistro(db: Db, now: number): Promise<Pendiente[]> {
  return (await leadsPendientes(db, now)).map(({ lead }) => ({ convId: lead.convId, nombre: lead.nombre }));
}

export const AYUDA_EQUIPO =
  "Comandos:\n" +
  "• registrado <nombre> — marca al cliente como ya registrado en Zoho\n" +
  "• existente <nombre> — marca al que ya estaba creado en el sistema (no se vuelve a avisar)\n" +
  "• pendientes — lista los que faltan por registrar\n\n" +
  "Los avisos de clientes nuevos llegan solos, con el enlace del formulario ya rellenado.";

/** Responde a un mensaje del equipo (Camila/Maricela). Devuelve el texto de respuesta. */
export async function comandoEquipo(env: Env, texto: string, now = Date.now()): Promise<string> {
  const db = new Db(env.DB);
  const t = texto.trim();
  const m = t.match(/^\/?(registrad[oa]s?|hecho|listo)\s+(.+)$/i);
  if (m) {
    const buscado = norm(m[2]);
    const pend = await pendientesRegistro(db, now);
    const coinc = pend.filter((p) => norm(p.nombre).includes(buscado) || buscado.includes(norm(p.nombre)));
    if (coinc.length === 0) return `No encuentro a «${m[2].trim()}» entre los pendientes. Escribe «pendientes» para ver la lista.`;
    if (coinc.length > 1) return `Hay varios: ${coinc.map((c) => c.nombre).join(", ")}. Escribe el nombre completo.`;
    await db.run(
      "UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_registrado', ?) WHERE id = ?",
      [new Date(now).toISOString(), coinc[0].convId],
    );
    return `✅ Marcado como registrado: ${coinc[0].nombre}`;
  }
  const e = t.match(/^\/?(existente|duplicado|ya existe)\s+(.+)$/i);
  if (e) {
    const buscado = norm(e[2]);
    const pend = await pendientesRegistro(db, now);
    const coinc = pend.filter((p) => norm(p.nombre).includes(buscado) || buscado.includes(norm(p.nombre)));
    if (coinc.length !== 1) return coinc.length ? `Hay varios: ${coinc.map((c) => c.nombre).join(", ")}. Escribe el nombre completo.` : `No encuentro a «${e[2].trim()}» entre los pendientes.`;
    await db.run(
      "UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_existente', ?) WHERE id = ?",
      [new Date(now).toISOString(), coinc[0].convId],
    );
    return `🔴 Marcado como ya existente en el sistema (no se vuelve a avisar): ${coinc[0].nombre}`;
  }
  if (/^\/?pendientes?$/i.test(t)) {
    const pend = await pendientesRegistro(db, now);
    return pend.length ? `Faltan por registrar (${pend.length}):\n` + pend.map((p) => `• ${p.nombre}`).join("\n") : "No hay pendientes 🎉";
  }
  return AYUDA_EQUIPO;
}

// ─── Excel de clientes listos (6:00 y 14:00 de España) ─────────────────────────

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HORAS_EXCEL = [6, 14];

/** Clientes con todos los datos del formulario, sin registrar, que aún no iban en ningún Excel. */
export async function leadsListos(db: Db, now: number): Promise<LeadResumen[]> {
  const convs = await db.all<ConvInfo>(
    `SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations
      WHERE last_message_at > ?
        AND json_extract(COALESCE(metadata, '{}'), '$.viventa_registrado') IS NULL
        AND json_extract(COALESCE(metadata, '{}'), '$.viventa_existente') IS NULL
        AND json_extract(COALESCE(metadata, '{}'), '$.viventa_excel') IS NULL`,
    [now - 7 * 24 * H],
  );
  if (convs.length === 0) return [];
  const ids = new Set(convs.map((c) => c.id));
  const rows = (
    await db.all<LeadRow>(
      "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE updated_at > ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
      [now - 7 * 24 * H],
    )
  ).filter((l) => l.conversation_id && ids.has(l.conversation_id));
  const orden = { caliente: 0, tibio: 1, frio: 2 } as const;
  return armarLeads(convs, rows, await llamadasAgendadas(db, now))
    .filter((l) => faltantes(l).length === 0)
    .sort((a, b) => orden[a.prioridad.nivel] - orden[b.prioridad.nivel] || b.prioridad.puntos - a.prioridad.puntos);
}

export function excelListos(leads: LeadResumen[], formUrl?: string): Uint8Array {
  const head = ["#", "Prioridad", "Canal", "Nombres", "Apellidos", "Correo", "Nota del correo", "Teléfono", "Ciudad de interés", "País de residencia", "Ciudad de residencia", "Ahorro", "Ingresos mensuales", "Llamada agendada", "Enlace del formulario"];
  const icono = { caliente: "🔥 Caliente", tibio: "🟡 Tibio", frio: "⚪ Frío" } as const;
  const rows: Celda[][] = [head];
  leads.forEach((l, i) => {
    const m = l.ficha.metadata;
    const partes = l.nombre.trim().split(/\s+/);
    const [pais, ...ciudad] = (m.ciudadResidencia ?? "").split(",").map((x) => x.trim());
    rows.push([
      i + 1, icono[l.prioridad.nivel], l.canal,
      partes.length > 1 ? partes[0] : partes[0] ?? "", partes.length > 1 ? partes.slice(1).join(" ") : "",
      correoParaFormulario(l).correo, correoParaFormulario(l).inventado ? "⚠️ Correo inventado: el cliente no lo dio" : "", l.telefono,
      opcion(m.ciudadCompra, CIUDADES_FORM) || m.ciudadCompra || "",
      opcion(pais, PAISES_FORM, { "estados unidos": "USA", eeuu: "USA", "ee.uu": "USA", usa: "USA" }) || pais || "",
      ciudad.join(", "), m.ahorroDisponible ?? "", m.ingresosMensuales ?? "", l.llamada,
      formUrl ? { text: "Abrir formulario", url: urlFormulario(formUrl, l) } : "",
    ]);
  });
  return buildXlsx([{ name: "Listos para registrar", rows, widths: [4, 13, 11, 18, 22, 36, 30, 17, 18, 18, 20, 24, 20, 22, 20] }]);
}

/**
 * A las 6:00 y 14:00 de España manda a Camila y Maricela el Excel con los clientes
 * que ya están listos para el formulario (los nuevos desde el último envío). Si no
 * hay nuevos, un aviso corto. Una vez por franja y día.
 */
export async function runExcelListos(env: Env, now = Date.now()): Promise<{ sent: boolean; leads: number }> {
  const { hora, dia } = madridParts(now);
  if (!HORAS_EXCEL.includes(hora) || !camilaConfigured(env)) return { sent: false, leads: 0 };

  const db = new Db(env.DB);
  const franja = `${dia}-${String(hora).padStart(2, "0")}h`;
  const res = await db.run("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)", [`viventa_excel_${franja}`, "1", now]);
  if ((res.meta?.changes ?? 0) === 0) return { sent: false, leads: 0 };

  const leads = await leadsListos(db, now);
  if (leads.length === 0) {
    await notifyCamila(env, { heading: `📎 Excel de las ${hora}:00`, body: "Sin clientes nuevos listos para registrar desde el último envío ✅" });
    return { sent: true, leads: 0 };
  }
  const formUrl = ((await new SettingsRepo(db).get(SETTING_FORM_URL)) ?? "").trim() || undefined;
  // Se marcan antes de enviar: si algo falla a medias, no se repiten en el siguiente.
  const enviados: LeadResumen[] = [];
  for (const l of leads) {
    const r = await db.run(
      `UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_excel', ?)
        WHERE id = ? AND json_extract(COALESCE(metadata, '{}'), '$.viventa_excel') IS NULL`,
      [franja, l.convId],
    );
    if ((r.meta?.changes ?? 0) > 0) enviados.push(l);
  }
  const ok = await notifyCamilaDocument(env, {
    filename: `clientes_listos_${franja}.xlsx`,
    content: excelListos(enviados, formUrl),
    mime: XLSX_MIME,
    caption: `📎 ${enviados.length} cliente(s) listo(s) para registrar (nuevos desde el último envío). Abre el enlace de cada fila, revisa, marca los términos y envía. Después escribe «registrado Nombre» a este bot.`,
  });
  if (!ok) console.error("[resumenDia] el Excel de las", hora, "no llegó a ningún destinatario");
  return { sent: ok, leads: enviados.length };
}
