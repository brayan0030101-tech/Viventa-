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
}

function canalDe(channel: string): string {
  return channel === "ycloud" ? "WhatsApp" : channel === "zernio" || channel === "instagram" ? "Instagram" : channel === "telegram" ? "Telegram" : channel;
}

/** Junta los leads de cada conversación (el dato más reciente de cada campo gana). */
export function armarLeads(convs: ConvInfo[], leads: LeadRow[]): LeadResumen[] {
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
    });
  }
  return out;
}

const ICONO = { caliente: "🔥", tibio: "🟡", frio: "⚪" } as const;

export function lineaLead(l: LeadResumen, formUrl?: string): string {
  const m = l.ficha.metadata;
  const partes = [
    `${ICONO[l.prioridad.nivel]} ${l.nombre} · ${l.canal}${l.telefono ? ` · ${l.telefono}` : " · SIN TELÉFONO"}`,
    l.horaLlamada ? `📞 ${l.horaLlamada}` : "",
    [m.ciudadResidencia && `Vive: ${m.ciudadResidencia}`, m.ciudadCompra && `Quiere: ${m.ciudadCompra}`].filter(Boolean).join(" · "),
    [m.ahorroDisponible && `Ahorro: ${m.ahorroDisponible}`, m.capacidadMensual && `Mensual: ${m.capacidadMensual}`, m.tipoEmpleo && `Trabajo: ${m.tipoEmpleo}`].filter(Boolean).join(" · "),
    formUrl ? (l.correo && l.telefono ? `📝 Registrar: ${urlFormulario(formUrl, l)}` : `📝 Falta ${!l.telefono ? "teléfono" : "correo"} para el formulario: ${urlFormulario(formUrl, l)}`) : "",
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
    ["Email", l.correo.split(",")[0].trim()],
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
      m.antiguedadLaboral && `Antigüedad: ${m.antiguedadLaboral}`,
      l.ficha.notas && `Notas: ${l.ficha.notas}`,
      `Prioridad: ${l.prioridad.nivel}`,
    ].filter(Boolean).join(" | ");
    return [first, last, l.correo.split(",")[0].trim(), l.telefono, l.canal, viveEn[0] ?? "", viveEn[1] ?? "", desc].map(csvCell).join(",");
  });
  return "﻿" + [CSV_COLS.join(","), ...filas].join("\r\n") + "\r\n";
}

// ─── Cron ──────────────────────────────────────────────────────────────────────

function madridParts(now: number): { hora: number; dia: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { hora: Number(p.hour) % 24, dia: `${p.year}-${p.month}-${p.day}` };
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
    "SELECT id, channel, channel_user_id, display_name, last_message_at FROM conversations WHERE last_message_at > ?",
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
  const leads = armarLeads(convs, leadsRows);
  if (leads.length === 0) return { sent: false, leads: 0 };

  const url = `${await selfOrigin(env)}/admin`;
  const settings = new SettingsRepo(db);
  const formUrl = ((await settings.get(SETTING_FORM_URL)) ?? "").trim() || undefined;
  const msgs = mensajesResumen(leads, url, formUrl);
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
