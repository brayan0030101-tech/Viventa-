// member/crm-embudo.local.ts — CRM de Viventa: «Recorrido del cliente» (embudo).
// Cuenta, de las personas que escribieron por primera vez en el periodo, cuántas llegan a cada paso y dónde se pierden:
// escribe → conversa (3+ mensajes) → termina las preguntas → califica (tibio/caliente) → recibe cotización → agenda videollamada → se conecta →
// formulario enviado (Zoho) → cerrado. Sin IA y sin costo: sale de las tablas de siempre. Los números colombianos no cuentan.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { armarLeads, evaluarCalificacion } from "../src/followup/resumenDia";
import { esNumeroColombiano } from "../src/channels/ycloud";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";

const DIA = 24 * 3_600_000;
const BASE_PREGUNTAS = ["ciudadResidencia", "ciudadCompra", "entregaInmediataOFutura", "ahorroDisponible", "capacidadMensual", "tipoEmpleo", "ingresosMensuales"];
const FORMULARIO = ["Formulario CC", "En Pre-calificación", "Resultado Pre-calificación", "Pre-calificado Incompleto", "Enviado a constructora", "Puente"];

export const PASOS = [
  { id: "escribe", nombre: "Escribieron", ayuda: "Primer mensaje del cliente" },
  { id: "conversa", nombre: "Conversaron", ayuda: "Mandaron 3 mensajes o más: pasaron del primer saludo" },
  { id: "preguntas", nombre: "Terminaron las preguntas", ayuda: "El bot reunió los 7 datos base" },
  { id: "califica", nombre: "Califican (tibio o caliente)", ayuda: "Cumplen las condiciones de ingresos y cuota" },
  { id: "cotizacion", nombre: "Recibieron cotización", ayuda: "Se les envió una cotización de ViveHome" },
  { id: "agenda", nombre: "Agendaron videollamada", ayuda: "Tienen o tuvieron una cita con Maricela" },
  { id: "conecta", nombre: "Se conectaron", ayuda: "La videollamada ya pasó y se analizó" },
  { id: "formulario", nombre: "Formulario enviado", ayuda: "En Zoho están en «Formulario CC» o posterior" },
  { id: "cerrado", nombre: "Cerrados", ayuda: "Marcados como cerrados (compró o reservó)" },
] as const;
export type PasoId = (typeof PASOS)[number]["id"];

export interface Embudo {
  dias: number;
  total: Record<PasoId, number>;
  porCanal: Record<"WhatsApp" | "Instagram", Record<PasoId, number>>;
}

const vacio = (): Record<PasoId, number> => Object.fromEntries(PASOS.map((p) => [p.id, 0])) as Record<PasoId, number>;

export async function calcularEmbudo(env: Env, dias: number, now = Date.now()): Promise<Embudo> {
  const db = new Db(env.DB);
  const desde = now - dias * DIA;
  const convs = await db.all<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number; metadata: string | null; primero: number; n: number }>(
    `SELECT c.id, c.channel, c.channel_user_id, c.display_name, c.last_message_at, c.metadata, MIN(m.created_at) AS primero, COUNT(*) AS n
       FROM conversations c JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
      WHERE c.channel IN ('ycloud', 'zernio') GROUP BY c.id HAVING primero > ? ORDER BY primero DESC LIMIT 2000`,
    [desde],
  );
  const lista = convs.filter((c) => !(c.channel === "ycloud" && esNumeroColombiano(c.channel_user_id)));
  const total = vacio();
  const porCanal = { WhatsApp: vacio(), Instagram: vacio() };
  if (!lista.length) return { dias, total, porCanal };
  const ids = lista.map((c) => c.id);
  const leadsPor = new Map<string, Array<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null; intent: string | null }>>();
  const citas = new Set<string>();
  for (let i = 0; i < ids.length; i += 80) {
    const lote = ids.slice(i, i + 80);
    for (const l of await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null; intent: string | null }>(
      `SELECT conversation_id, name, contact, notes, metadata, intent FROM leads WHERE conversation_id IN (${lote.map(() => "?").join(",")})`, lote)) {
      if (!l.conversation_id) continue;
      if ((l.intent ?? "").startsWith("Cita ·")) { citas.add(l.conversation_id); continue; }
      const a = leadsPor.get(l.conversation_id) ?? [];
      a.push(l);
      leadsPor.set(l.conversation_id, a);
    }
  }
  const cotizadas = new Set<string>();
  for (const r of await db.all<{ conv_id: string }>("SELECT DISTINCT conv_id FROM cotizaciones_bot WHERE estado = 'enviada'").catch(() => [])) cotizadas.add(r.conv_id);
  const tels = new Set((await db.all<{ tel: string }>("SELECT DISTINCT substr(tel, -9) AS tel FROM cotizaciones_enviadas").catch(() => [])).map((r) => r.tel));
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const conectadas = new Set((await cargarLlamadas(env, now)).filter((l) => l.estado === "pasada").map((l) => l.convId));
  const analizadas = new Set((await db.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM crm_llamada_resultado").catch(() => [])).map((r) => r.conversation_id));

  for (const c of lista) {
    let meta: Record<string, unknown> = {};
    try { meta = c.metadata ? JSON.parse(c.metadata) : {}; } catch { /* sin metadatos */ }
    const canal = c.channel === "ycloud" ? "WhatsApp" : "Instagram";
    const [lead] = armarLeads([{ id: c.id, channel: c.channel, channel_user_id: c.channel_user_id, display_name: c.display_name, last_message_at: c.last_message_at }], leadsPor.get(c.id) ?? []);
    const cal = lead ? evaluarCalificacion(lead.ficha.metadata) : null;
    const preguntas = !!cal && cal.faltan.filter((k) => BASE_PREGUNTAS.includes(k)).length === 0;
    const hechos: Record<PasoId, boolean> = {
      escribe: true,
      conversa: c.n >= 3,
      preguntas,
      califica: preguntas && !!lead && lead.prioridad.nivel !== "frio",
      cotizacion: cotizadas.has(c.id) || (!!lead && tels.has(lead.telefono.replace(/\D/g, "").slice(-9))),
      agenda: citas.has(c.id) || !!lead?.llamada,
      conecta: conectadas.has(c.id) || analizadas.has(c.id),
      formulario: FORMULARIO.includes(String(meta.zoho_estado ?? "")),
      cerrado: meta.crm_etapa === "cerrado",
    };
    for (const p of PASOS) if (hechos[p.id]) { total[p.id]++; porCanal[canal][p.id]++; }
  }
  return { dias, total, porCanal };
}

export async function renderCrmEmbudo(env: Env, dias: number, now = Date.now()): Promise<string> {
  const periodo = [7, 30, 90].includes(dias) ? dias : 30;
  const e = await calcularEmbudo(env, periodo, now);
  const max = Math.max(1, e.total.escribe);
  const filas = PASOS.map((p, i) => {
    const n = e.total[p.id];
    const ant = i === 0 ? n : e.total[PASOS[i - 1].id];
    const pasa = i === 0 || ant === 0 ? "" : `${Math.round((n / ant) * 100)}% del paso anterior`;
    const pierde = i === 0 ? 0 : ant - n;
    const wa = e.porCanal.WhatsApp[p.id], ig = e.porCanal.Instagram[p.id];
    return `<div style="display:grid;grid-template-columns:220px 1fr 150px;gap:14px;align-items:center;padding:8px 0;border-bottom:1px dashed var(--line)">
      <div><b style="color:var(--cream);font-size:13px">${esc(p.nombre)}</b><div class="text-dim" style="font-size:10.5px">${esc(p.ayuda)}</div></div>
      <div><div style="background:var(--accent);height:20px;border-radius:5px;width:${Math.max(2, Math.round((n / max) * 100))}%;display:flex;align-items:center;padding-left:8px;font-weight:700;font-size:12px;color:var(--bg)">${n}</div>
        <div class="text-dim" style="font-size:10.5px;margin-top:3px">WhatsApp ${wa} · Instagram ${ig}</div></div>
      <div style="font-size:11.5px">${pasa ? `<span class="text-muted">${pasa}</span>` : ""}${pierde > 0 ? `<br><span style="color:var(--bad)">−${pierde} se pierden aquí</span>` : ""}</div></div>`;
  }).join("");
  const tab = (d: number) => `<a class="crm-in" href="/crm/embudo?dias=${d}" style="text-decoration:none;font-size:12px;padding:6px 12px;${d === periodo ? "background:var(--accent);color:var(--bg);font-weight:700" : ""}">Últimos ${d} días</a>`;
  const { estadisticaPuente } = await import("./puente-whatsapp.local");
  const pu = await estadisticaPuente(env, now - periodo * DIA).catch(() => ({ enviados: 0, pasaron: 0 }));
  const puente = pu.enviados ? `<div class="crm-card" style="padding:12px 18px;margin-bottom:12px;font-size:13px">📲 <b>Instagram → WhatsApp:</b> se mandaron ${pu.enviados} enlaces y <b>${pu.pasaron}</b> clientes pasaron a WhatsApp (${Math.round((pu.pasaron / pu.enviados) * 100)}%).</div>` : "";
  const body = `${ESTILO_CRM}
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">${[7, 30, 90].map(tab).join("")}</div>
    ${puente}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:12px;line-height:1.55">De las personas que <b>escribieron por primera vez</b> en el periodo, cuántas llegan a cada paso. Los que escribieron hace pocos días todavía pueden avanzar. Los números colombianos no cuentan.</div>
    <div class="crm-card" style="padding:14px 18px">${filas}</div>`;
  return crmLayout({ title: "Recorrido del cliente", activa: "embudo", body, env });
}
