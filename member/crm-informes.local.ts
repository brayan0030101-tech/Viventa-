// member/crm-informes.local.ts — CRM de Viventa, fase 3: informes y resumen general.
// Todo sale de la base de datos del bot (sin gastar IA): conversaciones, fichas, llamadas,
// tickets y el costo de la IA. El análisis con IA de las conversaciones es la fase 4.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { buildXlsx } from "../src/lib/xlsx";
import { esc, NIVEL, ESTILO_CRM, subnav, cargarCrm, type FilaCrm } from "./crm.local";
import { cargarLlamadas, type LlamadaCrm } from "./crm-calendario.local";

const H = 3600_000;
const DIA = 24 * H;
const INICIO_PROYECTO = Date.UTC(2026, 8, 28); // el bot de Viventa empezó el 28 de septiembre

export type Periodo = "hoy" | "7d" | "30d" | "todo";

export function inicioPeriodo(p: Periodo, now: number): number {
  const hoy0 = ymdMs(now);
  if (p === "hoy") return hoy0;
  if (p === "30d") return hoy0 - 29 * DIA;
  if (p === "todo") return INICIO_PROYECTO;
  return hoy0 - 6 * DIA;
}

/** Medianoche de España (en ms UTC) del día de `ms`. */
function ymdMs(ms: number): number {
  const [y, m, d] = ymd(ms).split("-").map(Number);
  // Madrid: se resuelve el desfase real del día con Intl
  const guess = Date.UTC(y, m - 1, d);
  const hh = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(new Date(guess)));
  return guess - hh * H;
}
const ymd = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const horaMadrid = (ms: number): number =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms)));

export function periodoValido(v: string | undefined): Periodo {
  return v === "hoy" || v === "30d" || v === "todo" ? v : "7d";
}

const TITULO_PERIODO: Record<Periodo, string> = { hoy: "hoy", "7d": "los últimos 7 días", "30d": "los últimos 30 días", todo: "todo el proyecto (desde el 28 de septiembre)" };

// ─── Cálculo ─────────────────────────────────────────────────────────────────

export interface Informe {
  periodo: Periodo;
  desde: number;
  hasta: number;
  conversaciones: number;
  conDatos: number;
  calificados: number;
  ofertaLlamada: number;
  agendaronBot: number;
  comodin: number;
  registrados: number;
  porNivel: Record<"caliente" | "tibio" | "frio", number>;
  porCanal: Array<{ canal: string; conversaciones: number; leads: number; calientes: number; llamadas: number }>;
  porDia: Array<{ dia: string; conversaciones: number; llamadas: number }>;
  porHora: number[];
  tickets: Array<{ tipo: string; n: number }>;
  costos: { total: number; porFuncion: Array<{ fn: string; costo: number; n: number }> };
  alertas: {
    sinLlamada: FilaCrm[];
    pendientesZoho: FilaCrm[];
    ticketsViejos: number;
    llamadasProximas: LlamadaCrm[];
  };
  generado: number;
}

const CANALES = ["WhatsApp", "Instagram"] as const;

export async function calcularInforme(env: Env, periodo: Periodo, now = Date.now()): Promise<Informe> {
  const db = new Db(env.DB);
  const desde = inicioPeriodo(periodo, now);

  const convs = (
    await db.all<{ id: string; channel: string; started_at: number; last_message_at: number; metadata: string | null }>(
      "SELECT id, channel, started_at, last_message_at, metadata FROM conversations WHERE last_message_at >= ? AND channel IN ('ycloud', 'zernio')",
      [desde],
    )
  );
  const nuevas = convs.filter((c) => c.started_at >= desde);
  const canalDe = (ch: string) => (ch === "zernio" ? "Instagram" : "WhatsApp");

  const crm = await cargarCrm(env, now);
  const activos = crm.filter((f) => f.ultimo >= desde);
  const porNivel = { caliente: 0, tibio: 0, frio: 0 } as Informe["porNivel"];
  for (const f of activos) porNivel[f.lead.prioridad.nivel]++;

  const llamadas = await cargarLlamadas(env, now);
  const agendadas = llamadas.filter((l) => l.creada >= desde && l.estado !== "cancelada");

  const tickets = await db.all<{ conversation_id: string | null; summary: string; status: string | null; created_at: number }>(
    "SELECT conversation_id, summary, status, created_at FROM tickets WHERE created_at >= ?",
    [desde],
  );
  const calificados = new Set<string>();
  const comodin = new Set<string>();
  const tiposMap = new Map<string, number>();
  for (const t of tickets) {
    const tipo = /^\[([^\]]{2,60})\]/.exec(t.summary)?.[1] ?? "Otro";
    const clave = tipo.replace(/:.*/, "").trim();
    tiposMap.set(clave, (tiposMap.get(clave) ?? 0) + 1);
    if (t.conversation_id && /lead calificado/i.test(tipo)) calificados.add(t.conversation_id);
    if (t.conversation_id && /otro horario|fuera del guion/i.test(tipo)) comodin.add(t.conversation_id);
  }

  const oferta = await db.all<{ conversation_id: string }>(
    "SELECT DISTINCT conversation_id FROM messages WHERE role = 'assistant' AND created_at >= ? AND content LIKE '%videollamada de 30 minutos%'",
    [desde],
  );

  const registrados = crm.filter((f) => f.registro && f.ultimo >= desde).length;

  const conDatos = new Set(activos.map((f) => f.lead.convId));
  const porCanal = CANALES.map((canal) => ({
    canal,
    conversaciones: nuevas.filter((c) => canalDe(c.channel) === canal).length,
    leads: activos.filter((f) => f.lead.canal === canal).length,
    calientes: activos.filter((f) => f.lead.canal === canal && f.lead.prioridad.nivel === "caliente").length,
    llamadas: agendadas.filter((l) => l.canal === canal).length,
  }));

  // Por día (España) para los últimos días del periodo (máx. 31 barras).
  const dias: string[] = [];
  const fin = ymdMs(now);
  const primero = Math.max(ymdMs(desde), fin - 30 * DIA);
  for (let t = primero; t <= fin; t += DIA) dias.push(ymd(t + 12 * H));
  const conv = new Map<string, number>();
  const llam = new Map<string, number>();
  const porHora = new Array(24).fill(0) as number[];
  for (const c of nuevas) {
    conv.set(ymd(c.started_at), (conv.get(ymd(c.started_at)) ?? 0) + 1);
    porHora[horaMadrid(c.started_at)]++;
  }
  for (const l of agendadas) llam.set(ymd(l.creada), (llam.get(ymd(l.creada)) ?? 0) + 1);
  const porDia = dias.map((d) => ({ dia: d, conversaciones: conv.get(d) ?? 0, llamadas: llam.get(d) ?? 0 }));

  const costosRows = await db.all<{ fn: string; c: number | null; n: number }>(
    "SELECT fn, SUM(cost_usd) AS c, COUNT(*) AS n FROM ia_usage WHERE created_at >= ? GROUP BY fn ORDER BY c DESC",
    [desde],
  );
  const porFuncion = costosRows.map((r) => ({ fn: r.fn, costo: r.c ?? 0, n: r.n }));

  const sinLlamada = crm
    .filter((f) => (f.lead.prioridad.nivel === "caliente" || f.lead.prioridad.nivel === "tibio") && !f.lead.llamada)
    .sort((a, b) => b.lead.prioridad.puntos - a.lead.prioridad.puntos);
  const pendientesZoho = crm.filter((f) => !f.registro && f.lead.prioridad.nivel !== "frio");
  const abiertos = await db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tickets WHERE status = 'open' AND created_at < ?",
    [now - DIA],
  );

  return {
    periodo,
    desde,
    hasta: now,
    conversaciones: nuevas.length,
    conDatos: conDatos.size,
    calificados: calificados.size,
    ofertaLlamada: new Set(oferta.map((o) => o.conversation_id)).size,
    agendaronBot: new Set(agendadas.map((l) => l.convId)).size,
    comodin: comodin.size,
    registrados,
    porNivel,
    porCanal,
    porDia,
    porHora,
    tickets: [...tiposMap.entries()].map(([tipo, n]) => ({ tipo, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    costos: { total: porFuncion.reduce((s, x) => s + x.costo, 0), porFuncion },
    alertas: {
      sinLlamada,
      pendientesZoho,
      ticketsViejos: abiertos[0]?.n ?? 0,
      llamadasProximas: llamadas.filter((l) => l.estado === "agendada" && l.inicio < now + 2 * DIA),
    },
    generado: now,
  };
}

// ─── Resumen general en palabras ─────────────────────────────────────────────

const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");
const usd = (n: number): string => `$${n.toFixed(2)}`;

export function resumenGeneral(i: Informe): string[] {
  const out: string[] = [];
  out.push(`En ${TITULO_PERIODO[i.periodo]} llegaron **${i.conversaciones}** conversaciones nuevas; **${i.conDatos}** clientes dejaron datos (${pct(i.conDatos, i.conversaciones)}).`);
  out.push(`De los clientes con datos, **${i.porNivel.caliente}** son calientes, **${i.porNivel.tibio}** tibios y **${i.porNivel.frio}** fríos.`);
  const calif = i.porNivel.caliente + i.porNivel.tibio;
  out.push(`El bot agendó **${i.agendaronBot}** videollamadas (${pct(i.agendaronBot, calif)} de los calientes y tibios)${i.comodin ? `; **${i.comodin}** clientes pasaron a Maricela por el comodín` : ""}.`);
  if (i.alertas.sinLlamada.length) out.push(`Hay **${i.alertas.sinLlamada.length}** clientes calientes o tibios todavía **sin llamada agendada**: conviene contactarlos.`);
  if (i.alertas.llamadasProximas.length) out.push(`En las próximas 48 horas hay **${i.alertas.llamadasProximas.length}** llamadas.`);
  if (i.alertas.pendientesZoho.length) out.push(`**${i.alertas.pendientesZoho.length}** clientes calientes o tibios aún no están registrados en Zoho.`);
  if (i.costos.total > 0) out.push(`La IA costó **${usd(i.costos.total)}**${i.calificados ? ` (${usd(i.costos.total / i.calificados)} por cliente que completó el guion)` : ""}${i.agendaronBot ? ` y ${usd(i.costos.total / i.agendaronBot)} por llamada agendada` : ""}.`);
  return out;
}

const negrita = (t: string): string => esc(t).replace(/\*\*(.+?)\*\*/g, "<b style=\"color:var(--cream)\">$1</b>");

// ─── Vista ───────────────────────────────────────────────────────────────────

const ESTILO_INF = `<style>
  @keyframes barra-in{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  @keyframes col-in{from{transform:scaleY(0)}to{transform:scaleY(1)}}
  .inf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .inf-kpi{padding:14px 16px;border:1px solid var(--line);background:var(--panel)}
  .inf-kpi b{display:block;font-size:26px;margin-top:2px}
  .inf-kpi small{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .inf-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}
  .inf-barra{height:22px;background:var(--accent);transform-origin:left;animation:barra-in .6s cubic-bezier(.16,1,.3,1) both}
  .inf-col{background:var(--accent);transform-origin:bottom;animation:col-in .5s cubic-bezier(.16,1,.3,1) both;min-width:6px}
  @media (max-width:1000px){.inf-2{grid-template-columns:1fr}}
</style>`;

function kpi(titulo: string, n: number | string, color?: string): string {
  return `<div class="inf-kpi"><small>${titulo}</small><b${color ? ` style="color:${color}"` : ""}>${n}</b></div>`;
}

function embudo(i: Informe): string {
  const pasos: Array<[string, number]> = [
    ["Conversaciones nuevas", i.conversaciones],
    ["Dejaron datos", i.conDatos],
    ["Completaron el guion", i.calificados],
    ["Recibieron la oferta de llamada", i.ofertaLlamada],
    ["Agendaron una llamada", i.agendaronBot],
  ];
  const base = Math.max(1, pasos[0][1], ...pasos.map((p) => p[1]));
  return pasos
    .map(([t, n], k) => `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:var(--cream)">${t}</span><span style="color:var(--muted)">${n}${k > 0 ? ` · ${pct(n, pasos[k - 1][1])} del paso anterior` : ""}</span></div>
      <div style="background:var(--line);height:22px"><div class="inf-barra" style="width:${Math.max(2, Math.round((n / base) * 100))}%;animation-delay:${k * 90}ms;opacity:${1 - k * 0.12}"></div></div></div>`)
    .join("");
}

function columnas(datos: Array<{ etiqueta: string; a: number; b?: number }>, altura = 110): string {
  const max = Math.max(1, ...datos.map((d) => Math.max(d.a, d.b ?? 0)));
  return `<div style="display:flex;align-items:flex-end;gap:3px;height:${altura}px">${datos
    .map(
      (d, k) => `<div title="${esc(d.etiqueta)}: ${d.a}${d.b != null ? ` · llamadas ${d.b}` : ""}" style="flex:1;display:flex;align-items:flex-end;gap:1px;height:100%">
        <div class="inf-col" style="height:${Math.round((d.a / max) * 100)}%;animation-delay:${k * 18}ms;opacity:.9"></div>
        ${d.b != null ? `<div class="inf-col" style="height:${Math.round((d.b / max) * 100)}%;background:var(--accent-2);animation-delay:${k * 18}ms"></div>` : ""}
      </div>`,
    )
    .join("")}</div>`;
}

export async function renderCrmInformes(env: Env, periodo: Periodo, now = Date.now()): Promise<string> {
  const i = await calcularInforme(env, periodo, now);
  const tab = (p: Periodo, t: string) =>
    `<a href="/crm/informes?p=${p}" style="padding:6px 14px;font-size:12px;border:1px solid ${p === periodo ? "var(--accent)" : "var(--line)"};background:${p === periodo ? "var(--accent-soft)" : "transparent"};color:${p === periodo ? "var(--cream)" : "var(--muted)"}">${t}</a>`;

  const resumen = resumenGeneral(i).map((t) => `<li style="margin-bottom:5px">${negrita(t)}</li>`).join("");
  const calif = i.porNivel.caliente + i.porNivel.tibio;

  const kpis = `<div class="inf-grid">
    ${kpi("Conversaciones nuevas", i.conversaciones)}
    ${kpi("Dejaron datos", i.conDatos)}
    ${kpi("🔥 Calientes", i.porNivel.caliente, NIVEL.caliente.color)}
    ${kpi("🟡 Tibios", i.porNivel.tibio, NIVEL.tibio.color)}
    ${kpi("⚪ Fríos", i.porNivel.frio, NIVEL.frio.color)}
    ${kpi("📞 Llamadas agendadas", i.agendaronBot)}
    ${kpi("Pasaron a Maricela (comodín)", i.comodin)}
    ${kpi("Conversión a llamada", pct(i.agendaronBot, calif))}
  </div>`;

  const canal = `<table style="width:100%;font-size:12.5px;border-collapse:collapse"><thead><tr style="color:var(--dim);font-size:10px;letter-spacing:.12em;text-transform:uppercase;text-align:left">
      <th style="padding:6px 0">Canal</th><th>Nuevas</th><th>Con datos</th><th>Calientes</th><th>Llamadas</th></tr></thead><tbody>
    ${i.porCanal.map((c) => `<tr style="border-top:1px solid var(--line)"><td style="padding:9px 0;color:var(--cream);font-weight:600">${c.canal}</td><td>${c.conversaciones}</td><td>${c.leads}</td><td style="color:${NIVEL.caliente.color}">${c.calientes}</td><td>${c.llamadas}</td></tr>`).join("")}
    </tbody></table>`;

  const porDia = columnas(i.porDia.map((d) => ({ etiqueta: d.dia, a: d.conversaciones, b: d.llamadas })));
  const rangoDias = i.porDia.length ? `${i.porDia[0].dia} → ${i.porDia[i.porDia.length - 1].dia}` : "";
  const porHora = columnas(i.porHora.map((n, h) => ({ etiqueta: `${h}:00`, a: n })), 90);

  const tickets = i.tickets.length
    ? i.tickets.map((t) => `<div style="display:flex;justify-content:space-between;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line)"><span style="color:var(--muted)">${esc(t.tipo)}</span><b style="color:var(--cream)">${t.n}</b></div>`).join("")
    : `<div class="text-dim" style="font-size:12px">Sin tickets en este periodo.</div>`;

  const costos = i.costos.porFuncion.length
    ? i.costos.porFuncion.slice(0, 6).map((c) => `<div style="display:flex;justify-content:space-between;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line)"><span style="color:var(--muted)">${esc(c.fn)} <span class="text-dim">(${c.n})</span></span><b style="color:var(--cream)">${usd(c.costo)}</b></div>`).join("")
    : `<div class="text-dim" style="font-size:12px">Sin gasto registrado.</div>`;

  const lista = (filas: FilaCrm[], max = 8) =>
    filas.slice(0, max).map((f) => `<a href="/crm/c/${encodeURIComponent(f.lead.convId)}" style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line);color:inherit"><span style="color:var(--cream)">${NIVEL[f.lead.prioridad.nivel].icono} ${esc(f.lead.nombre)}</span><span class="text-dim">${esc(f.lead.canal)}</span></a>`).join("") ||
    `<div class="text-dim" style="font-size:12px">Nada pendiente 🎉</div>`;

  const card = (t: string, c: string, sub = "") => `<div class="crm-card" style="padding:16px"><div class="crm-sec">${t}</div>${c}${sub}</div>`;

  const body = `${ESTILO_CRM}${ESTILO_INF}
    ${subnav("informes")}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      ${tab("hoy", "Hoy")}${tab("7d", "7 días")}${tab("30d", "30 días")}${tab("todo", "Todo el proyecto")}
      <a class="ghostbtn" href="/crm/informes.xlsx?p=${periodo}" style="margin-left:auto;border:1px solid var(--line);padding:6px 14px;font-size:12px;color:var(--muted)">⬇ Excel del informe</a>
    </div>
    <div class="crm-card" style="padding:16px 20px;margin-bottom:14px;border-left:4px solid var(--accent)">
      <div class="crm-sec">Resumen general · ${esc(TITULO_PERIODO[periodo])}</div>
      <ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.7;color:var(--muted)">${resumen}</ul>
    </div>
    ${kpis}
    <div class="inf-2">
      ${card("Embudo: de la conversación a la llamada", embudo(i))}
      ${card("Por canal", canal)}
    </div>
    <div class="inf-2">
      ${card("Conversaciones nuevas por día", porDia, `<div class="text-dim" style="font-size:10.5px;margin-top:6px">${esc(rangoDias)} · barras rosas: conversaciones · barras claras: llamadas agendadas</div>`)}
      ${card("A qué hora escriben (hora de España)", porHora, `<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--dim);margin-top:4px"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>23 h</span></div>`)}
    </div>
    <div class="inf-2">
      ${card("⚠️ Sin llamada agendada (calientes y tibios)", lista(i.alertas.sinLlamada), i.alertas.sinLlamada.length > 8 ? `<a href="/crm?estado=sin_llamada" style="font-size:12px;display:inline-block;margin-top:8px">Ver los ${i.alertas.sinLlamada.length} →</a>` : "")}
      ${card("📝 Pendientes de registrar en Zoho", lista(i.alertas.pendientesZoho), i.alertas.pendientesZoho.length > 8 ? `<a href="/crm?estado=sin_registrar" style="font-size:12px;display:inline-block;margin-top:8px">Ver los ${i.alertas.pendientesZoho.length} →</a>` : "")}
    </div>
    <div class="inf-2">
      ${card("🎫 Tickets por tipo", tickets, i.alertas.ticketsViejos ? `<div style="font-size:12px;color:var(--bad);margin-top:8px">${i.alertas.ticketsViejos} tickets abiertos hace más de 24 h</div>` : "")}
      ${card("💰 Costo de la IA", costos, `<div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px"><span style="color:var(--dim)">Total</span><b style="color:var(--accent)">${usd(i.costos.total)}</b></div>`)}
    </div>
    <p class="text-dim" style="font-size:11px">Calculado ${esc(new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" }).format(new Date(i.generado)))} (hora de España) con los datos del bot. El costo es solo lo que cobra la IA, sin Cloudflare, YCloud ni Zernio.</p>`;
  return crmLayout({ title: "Informes", activa: "informes", body, env });
}

// ─── Excel del informe ───────────────────────────────────────────────────────

export async function excelInforme(env: Env, periodo: Periodo, now = Date.now()): Promise<Uint8Array> {
  const i = await calcularInforme(env, periodo, now);
  const resumen: Array<Array<string | number>> = [
    ["Informe", `Viventa · ${TITULO_PERIODO[periodo]}`],
    ["Conversaciones nuevas", i.conversaciones],
    ["Dejaron datos", i.conDatos],
    ["Completaron el guion", i.calificados],
    ["Recibieron la oferta de llamada", i.ofertaLlamada],
    ["Agendaron una llamada", i.agendaronBot],
    ["Pasaron a Maricela (comodín)", i.comodin],
    ["Calientes", i.porNivel.caliente],
    ["Tibios", i.porNivel.tibio],
    ["Fríos", i.porNivel.frio],
    ["Costo de la IA (USD)", Number(i.costos.total.toFixed(2))],
    [],
    ...resumenGeneral(i).map((t) => [t.replace(/\*\*/g, "")]),
  ];
  const clientes: Array<Array<string | number>> = [["Prioridad", "Puntos", "Nombre", "Canal", "Teléfono", "Correo", "Ciudad de interés", "Ahorro", "Alerta"]];
  for (const f of i.alertas.sinLlamada) {
    const m = f.lead.ficha.metadata;
    clientes.push([NIVEL[f.lead.prioridad.nivel].nombre, f.lead.prioridad.puntos, f.lead.nombre, f.lead.canal, f.lead.telefono, f.lead.correo, m.ciudadCompra ?? "", m.ahorroDisponible ?? "", "Sin llamada agendada"]);
  }
  return buildXlsx([
    { name: "Resumen", rows: resumen, widths: [38, 70] },
    { name: "Por canal", rows: [["Canal", "Nuevas", "Con datos", "Calientes", "Llamadas"], ...i.porCanal.map((c) => [c.canal, c.conversaciones, c.leads, c.calientes, c.llamadas])], widths: [14, 10, 12, 12, 12] },
    { name: "Por día", rows: [["Día", "Conversaciones", "Llamadas agendadas"], ...i.porDia.map((d) => [d.dia, d.conversaciones, d.llamadas])], widths: [14, 16, 20] },
    { name: "Sin llamada", rows: clientes, widths: [12, 8, 26, 11, 17, 30, 18, 18, 22] },
  ]);
}
