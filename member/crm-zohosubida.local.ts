// member/crm-zohosubida.local.ts — Subida automática de clientes a Zoho (pedido de Maricela y Brayan, 21 oct 2026).
// El bot hace lo que Maricela hacía a mano (≈ 5 min por cliente): buscar si ya está en Zoho (por teléfono y por correo),
// crearlo si no existe, dejar la nota de la conversación, crear la tarea de seguimiento y dejarlo en «En Prospección» (si queda en «Nuevo»
// más de 24 h lo reasignan). Solo sube a quien respondió todas las preguntas y cumple las condiciones (tibio o caliente); a quien no responde se
// le hace seguimiento antes y a los fríos no se les sube. Si ya está en Zoho a nombre de otra asesora, no crea nada y avisa para pedir la reasignación.
// Interruptor: ajuste `viventa_zoho_subida` = apagado | piloto | activo (sin valor = apagado). En piloto solo las conversaciones de
// `viventa_zoho_subida_ids` (ids separados por coma). Cada pasada sube como máximo 3.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { armarLeads, evaluarCalificacion, type LeadResumen } from "../src/followup/resumenDia";
import { esNumeroColombiano } from "../src/channels/ycloud";
import { dijoQueNo } from "../src/vivehome/cola";
import { notifyCamila } from "../src/lib/camila";
import { buscarCandidato, crearCandidato, crearNota, crearTarea, cambiarEstadoCandidato, duenoDeCandidato, duenoZoho, zohoGet, zohoListo, type FetchFn } from "./crm-zohoapi.local";
import { fechaDisponibleZoho, masDiasAgenda } from "./crm-agenda.local";
import { escrituraActiva, hoyMadrid } from "./crm-seguimientos.local";

export const AJUSTE_SUBIDA = "viventa_zoho_subida";
export const AJUSTE_SUBIDA_IDS = "viventa_zoho_subida_ids";
const MAX_POR_PASADA = 3;
const ESTADO_PROSPECCION = "En Prospección";
const BASE_PREGUNTAS = ["ciudadResidencia", "ciudadCompra", "entregaInmediataOFutura", "ahorroDisponible", "capacidadMensual", "tipoEmpleo", "ingresosMensuales"];

const sinTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ─── Listas de opciones de Zoho (para no mandar un valor que Zoho no acepta) ──────────────────────────────

type Listas = Record<string, string[]>;
let cacheListas: { t: number; v: Listas } | null = null;

async function listasLeads(env: Env, f: FetchFn, now: number): Promise<Listas> {
  if (cacheListas && now - cacheListas.t < 3_600_000) return cacheListas.v;
  const j = (await zohoGet(env, "/settings/fields?module=Leads", f, now)) as { fields?: Array<{ api_name?: string; pick_list_values?: Array<{ display_value?: string }> }> };
  const v: Listas = {};
  for (const x of j.fields ?? []) if (x.api_name && Array.isArray(x.pick_list_values)) v[x.api_name] = x.pick_list_values.map((o) => String(o.display_value ?? "")).filter((o) => o && o !== "-None-");
  cacheListas = { t: now, v };
  return v;
}

/** Valor de la lista que corresponde al texto del cliente («Neiva, Huila» → «Neiva»), o "" si no hay. */
export function elegirOpcion(texto: string | undefined, opciones: string[] | undefined, alias: Record<string, string> = {}): string {
  const t = sinTildes(texto ?? "");
  if (!t || !opciones?.length) return "";
  for (const [k, v] of Object.entries(alias)) if (t.includes(k) && opciones.includes(v)) return v;
  return opciones.find((o) => sinTildes(o) === t) ?? opciones.find((o) => o.length > 2 && t.includes(sinTildes(o))) ?? "";
}

// ─── Qué se manda ─────────────────────────────────────────────────────────────────────────────────

export interface PlanSubida {
  convId: string;
  nombre: string;
  telefono: string;
  correo: string;
  nivel: "caliente" | "tibio" | "frio";
  datos: Record<string, unknown>;
  nota: string;
  tarea: { asunto: string; deseada: string };
}

function partirNombre(nombre: string): { first: string; last: string } {
  const p = nombre.trim().split(/\s+/).filter(Boolean);
  if (p.length <= 1) return { first: "", last: p[0] ?? "Sin apellido" };
  const mitad = p.length >= 4 ? 2 : 1;
  return { first: p.slice(0, mitad).join(" "), last: p.slice(mitad).join(" ") };
}

const hoy = (n: number): string => hoyMadrid(n);

export function armarNota(l: LeadResumen, cotizada: boolean, ultimoMensaje: string, canal: string, now: number): string {
  const m = l.ficha.metadata;
  const linea = (k: string, v?: string) => (v ? `${k}: ${v}` : "");
  return [
    `Cliente registrado por el bot de Viventa el ${hoy(now)} (llegó por ${canal}).`,
    linea("Quiere comprar en", m.ciudadCompra), linea("Vive en", m.ciudadResidencia), linea("Para", m.motivoCompra), linea("Entrega", m.entregaInmediataOFutura),
    linea("Ahorro", m.ahorroDisponible), linea("Puede destinar al mes", m.capacidadMensual), linea("Trabajo", m.tipoEmpleo), linea("Ingresos", m.ingresosMensuales),
    linea("Reportado en Datacrédito", m.reportadoDatacredito), linea("¿Puede quitar el reporte?", m.puedeQuitarReporte),
    linea("Compra", m.compraSoloOAcompanado), linea("Datos de quien compra con él/ella", m.datosCoComprador), linea("Ingresos de la otra persona", m.ingresosCoComprador),
    linea("Notas del bot", l.ficha.notas),
    cotizada ? "Ya se le envió una cotización." : "Todavía no se le ha enviado cotización.",
    ultimoMensaje ? `Su último mensaje: «${ultimoMensaje.replace(/\s+/g, " ").slice(0, 160)}»` : "",
    "Siguiente paso: escribirle por WhatsApp y, si le interesa, agendar la videollamada.",
  ].filter(Boolean).join("\n");
}

export async function armarPlan(env: Env, convId: string, f: FetchFn, now: number): Promise<{ plan?: PlanSubida; motivoNo?: string }> {
  const db = new Db(env.DB);
  const conv = await db.first<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number; metadata: string | null }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at, metadata FROM conversations WHERE id = ?", [convId]);
  if (!conv) return { motivoNo: "la conversación no existe" };
  if (conv.channel === "ycloud" && esNumeroColombiano(conv.channel_user_id)) return { motivoNo: "número colombiano (regla fija)" };
  let meta: Record<string, unknown> = {};
  try { meta = conv.metadata ? JSON.parse(conv.metadata) : {}; } catch { /* sin metadatos */ }
  if (meta.viventa_registrado || meta.viventa_existente) return { motivoNo: "ya está registrado" };
  if (["perdido", "cerrado"].includes(String(meta.crm_etapa ?? "")) || meta.crm_descarte) return { motivoNo: "perdido o descartado" };
  if (await dijoQueNo(db, convId)) return { motivoNo: "dijo que no le interesa" };
  const rows = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null; intent: string | null }>(
    "SELECT conversation_id, name, contact, notes, metadata, intent FROM leads WHERE conversation_id = ? ORDER BY created_at ASC", [convId]);
  if (rows.some((r) => (r.intent ?? "").startsWith("Cita ·"))) { /* con cita también se sube: Maricela la va a atender */ }
  const [lead] = armarLeads([conv], rows.filter((r) => !(r.intent ?? "").startsWith("Cita ·")));
  if (!lead) return { motivoNo: "todavía no hay ficha del cliente" };
  const cal = evaluarCalificacion(lead.ficha.metadata);
  const faltan = cal.faltan.filter((k) => BASE_PREGUNTAS.includes(k));
  if (faltan.length) return { motivoNo: `faltan preguntas (${faltan.join(", ")}): primero se completa la prospección` };
  if (lead.prioridad.nivel === "frio") return { motivoNo: "cliente frío: no se sube" };
  if (cal.reportado && cal.puedeQuitarReporte !== true) return { motivoNo: "reportado sin plan de ponerse al día" };
  if (!lead.telefono && !lead.correo) return { motivoNo: "no hay teléfono ni correo" };

  const listas = await listasLeads(env, f, now);
  const m = lead.ficha.metadata;
  const [paisTxt, ...ciudadRes] = (m.ciudadResidencia ?? "").split(",").map((x) => x.trim());
  const nom = partirNombre(lead.nombre);
  const pais = elegirOpcion(paisTxt, listas["Pais"], { eeuu: "Estados Unidos", "ee.uu": "Estados Unidos", usa: "Estados Unidos" });
  const ciudadInt = elegirOpcion(m.ciudadCompra, listas["Ciudad_de_Interes"]) || (m.ciudadCompra ? "Otra" : "");
  const actividad = /independiente|aut[oó]nomo|por (su|mi) cuenta/i.test(m.tipoEmpleo ?? "") ? "Independiente" : /pension/i.test(m.tipoEmpleo ?? "") ? "Pensionado" : /emplead|contrato|n[oó]mina/i.test(m.tipoEmpleo ?? "") ? "Empleado" : "";
  const datos: Record<string, unknown> = {
    First_Name: nom.first || undefined,
    Last_Name: nom.last,
    Email: lead.correo ? lead.correo.split(",")[0].trim() : undefined,
    Mobile: lead.telefono || undefined,
    Lead_Source: "Referidores",
    Se_entero_por_medio_de: "Ref Pro Exterior",
    Lead_Status: ESTADO_PROSPECCION,
    Canal_de_contacto: conv.channel === "ycloud" ? "Whatsapp" : undefined,
    Pais: pais || undefined,
    En_qu_ciudad_est_ubicada: ciudadRes.join(", ") || undefined,
    Ciudad_de_Interes: ciudadInt || undefined,
    C_mo_describir_as_tu_actividad_econ_mica: actividad && listas["C_mo_describir_as_tu_actividad_econ_mica"]?.includes(actividad) ? actividad : undefined,
  };
  for (const k of Object.keys(datos)) if (datos[k] === undefined) delete datos[k];

  const ult = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1", [convId]);
  const cot = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM cotizaciones_bot WHERE conv_id = ? AND estado = 'enviada'", [convId]).catch(() => null);
  const caliente = lead.prioridad.nivel === "caliente";
  const canal = conv.channel === "ycloud" ? "WhatsApp" : "Instagram";
  const primer = nom.first || nom.last;
  return {
    plan: {
      convId, nombre: lead.nombre, telefono: lead.telefono, correo: lead.correo, nivel: lead.prioridad.nivel, datos,
      nota: armarNota(lead, (cot?.n ?? 0) > 0, ult?.content ?? "", canal, now),
      tarea: { asunto: caliente ? `Cliente caliente: escribirle hoy a ${primer} y proponerle videollamada` : `Seguimiento a ${primer}: ver si le interesó la cotización y proponer videollamada`, deseada: masDiasAgenda(hoy(now), caliente ? 1 : 3) },
    },
  };
}

// ─── Ejecutar ─────────────────────────────────────────────────────────────────────────────────────

export type ResultadoSubida =
  | { estado: "creado"; leadId: string; tarea: string }
  | { estado: "ya_existe"; leadId: string; dueno: string; propio: boolean }
  | { estado: "no_corresponde"; motivo: string }
  | { estado: "error"; motivo: string };

async function marcar(db: Db, convId: string, clave: string, valor: string): Promise<void> {
  await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), ?, ?) WHERE id = ?", [`$.${clave}`, valor, convId]);
}

export async function subirCliente(env: Env, convId: string, opts: { soloVer?: boolean; f?: FetchFn; now?: number } = {}): Promise<ResultadoSubida & { plan?: PlanSubida }> {
  const f = opts.f ?? fetch;
  const now = opts.now ?? Date.now();
  const db = new Db(env.DB);
  const { plan, motivoNo } = await armarPlan(env, convId, f, now);
  if (!plan) return { estado: "no_corresponde", motivo: motivoNo ?? "no corresponde" };
  if (opts.soloVer) return { estado: "no_corresponde", motivo: "vista previa: no se escribió nada", plan };
  try {
    const existente = await buscarCandidato(env, { correos: plan.correo ? plan.correo.split(",") : [], telefono: plan.telefono }, f, now);
    const dueno = await duenoZoho(env, f, now);
    if (existente) {
      const de = await duenoDeCandidato(env, existente.id, f, now).catch(() => null);
      const propio = !de || de.id === dueno.id;
      await marcar(db, convId, "viventa_existente", `${hoy(now)}-bot${propio ? "" : "-otra-asesora"}`);
      await marcar(db, convId, "zoho_lead_id", existente.id);
      if (!propio) {
        await notifyCamila(env, { heading: "⚠️ Cliente ya está en Zoho con otra asesora", body: `${plan.nombre} (${plan.telefono || plan.correo}) ya existe en Zoho a nombre de ${de?.nombre || "otra persona"} (estado «${existente.estado}»). No se creó nada. Si es un cliente caliente, conviene pedir a Rafa que te lo reasigne.` }).catch(() => false);
      }
      return { estado: "ya_existe", leadId: existente.id, dueno: de?.nombre ?? dueno.nombre, propio, plan };
    }
    const datos: Record<string, unknown> = { ...plan.datos, Owner: { id: dueno.id } };
    let leadId: string;
    try {
      leadId = await crearCandidato(env, datos, f, now);
    } catch (e) {
      // Algunos estados solo se alcanzan con transición (Plan de acción): se crea sin estado y después se intenta cambiar.
      const { Lead_Status: _omitido, ...sinEstado } = datos;
      if (!/status|estado/i.test(e instanceof Error ? e.message : "")) throw e;
      leadId = await crearCandidato(env, sinEstado, f, now);
      await cambiarEstadoCandidato(env, leadId, ESTADO_PROSPECCION, f, now).catch((e2) => console.error("[subidaZoho] estado:", e2));
    }
    await crearNota(env, leadId, plan.nota, f, now);
    const hoyStr = hoy(now);
    const disp = await fechaDisponibleZoho(env, plan.tarea.deseada, hoyStr, f, now, plan.nivel === "caliente").catch(() => ({ fecha: plan.tarea.deseada, motivo: "" }));
    const tarea = await crearTarea(env, { leadId, asunto: plan.tarea.asunto, fecha: disp.fecha, ownerId: dueno.id }, f, now);
    await marcar(db, convId, "viventa_registrado", new Date(now).toISOString());
    await marcar(db, convId, "viventa_registrado_por", "bot");
    await marcar(db, convId, "zoho_lead_id", leadId);
    return { estado: "creado", leadId, tarea: disp.fecha, plan };
  } catch (e) {
    return { estado: "error", motivo: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

export async function runSubidaZoho(env: Env, now = Date.now(), f: FetchFn = fetch): Promise<{ creados: number; existentes: number; errores: number }> {
  const out = { creados: 0, existentes: 0, errores: 0 };
  if (!zohoListo(env) || !(await escrituraActiva(env))) return out;
  const st = new SettingsRepo(new Db(env.DB));
  const modo = ((await st.get(AJUSTE_SUBIDA)) ?? "").trim().toLowerCase();
  if (modo !== "piloto" && modo !== "activo") return out;
  const db = new Db(env.DB);
  let ids: string[];
  if (modo === "piloto") ids = ((await st.get(AJUSTE_SUBIDA_IDS)) ?? "").split(/[,;\s]+/).filter(Boolean).slice(0, 10);
  else ids = (await db.all<{ id: string }>("SELECT id FROM conversations WHERE channel IN ('ycloud','zernio') AND last_message_at > ? AND COALESCE(json_extract(metadata,'$.viventa_registrado'),'') = '' AND COALESCE(json_extract(metadata,'$.viventa_existente'),'') = '' ORDER BY last_message_at DESC LIMIT 200", [now - 20 * 86_400_000])).map((r) => r.id);
  let intentos = 0;
  const resumen: string[] = [];
  for (const id of ids) {
    if (intentos >= MAX_POR_PASADA) break;
    const r = await subirCliente(env, id, { f, now });
    if (r.estado === "no_corresponde") continue;
    intentos++;
    if (r.estado === "creado") { out.creados++; resumen.push(`✅ ${r.plan?.nombre}: creado en «${ESTADO_PROSPECCION}», tarea para el ${r.tarea}`); }
    else if (r.estado === "ya_existe") { out.existentes++; resumen.push(`↪️ ${r.plan?.nombre}: ya estaba en Zoho${r.propio ? "" : ` (de ${r.dueno})`}`); }
    else { out.errores++; resumen.push(`❌ ${id}: ${r.motivo}`); }
  }
  if (resumen.length) await notifyCamila(env, { heading: "📤 El bot subió clientes a Zoho", body: resumen.join("\n") }).catch(() => false);
  return out;
}
