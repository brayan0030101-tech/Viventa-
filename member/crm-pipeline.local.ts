// member/crm-pipeline.local.ts — CRM de Viventa: tablero por etapas de la venta.
// La etapa se calcula sola (datos del cliente, llamada agendada/hecha, resultado de la llamada)
// y Maricela puede moverla a mano; lo manual manda (se guarda en conversations.metadata.crm_etapa).
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, badgeNivel, cargarCrm, hace, type FilaCrm } from "./crm.local";

export const ETAPAS = [
  { id: "nuevo", nombre: "Nuevo", icono: "🆕", ayuda: "Escribió, el bot aún tiene pocos datos" },
  { id: "calificado", nombre: "Calificado", icono: "📝", ayuda: "Cliente tibio o caliente, o con varios datos" },
  { id: "agendada", nombre: "Llamada agendada", icono: "📅", ayuda: "Tiene videollamada pendiente" },
  { id: "hecha", nombre: "Llamada hecha", icono: "📞", ayuda: "Ya habló con Maricela" },
  { id: "negociando", nombre: "Negociando", icono: "🤝", ayuda: "Hay avance concreto" },
  { id: "cerrado", nombre: "Cerrado", icono: "🏆", ayuda: "Compró / reservó" },
  { id: "perdido", nombre: "Perdido", icono: "✖️", ayuda: "No sigue" },
] as const;
export type EtapaId = (typeof ETAPAS)[number]["id"];
export const etapaValida = (v: unknown): v is EtapaId => ETAPAS.some((e) => e.id === v);

interface Contexto {
  /** conversación → resultado de la última llamada analizada */
  resultados: Map<string, string>;
  /** conversación → llamadas */
  llamadas: Map<string, { pasada: boolean; agendada: boolean }>;
  /** conversación → etapa fijada a mano */
  manual: Map<string, string>;
}

/** Etapa automática de un cliente según lo que ya sabemos de él. */
export function etapaAutomatica(f: FilaCrm, ctx: Pick<Contexto, "resultados" | "llamadas">): EtapaId {
  const id = f.lead.convId;
  const res = ctx.resultados.get(id);
  if (res === "concretado" || res === "parcial") return "negociando";
  const ll = ctx.llamadas.get(id);
  if (res || ll?.pasada) return "hecha";
  if (ll?.agendada || f.lead.llamada) return "agendada";
  const campos = Object.entries(f.lead.ficha.metadata).filter(([k, v]) => v && !/^(cita|cal)/i.test(k)).length;
  return f.lead.prioridad.nivel !== "frio" || campos >= 3 ? "calificado" : "nuevo";
}

export interface TarjetaPipeline { fila: FilaCrm; etapa: EtapaId; manual: boolean }

export async function cargarPipeline(env: Env, now = Date.now()): Promise<TarjetaPipeline[]> {
  const db = new Db(env.DB);
  const filas = await cargarCrm(env, now);
  const { asegurarTablas } = await import("./crm-resultados.local");
  await asegurarTablas(db);
  const resultados = new Map<string, string>();
  const rs = await db.all<{ conversation_id: string; analisis: string }>("SELECT conversation_id, analisis FROM crm_llamada_resultado ORDER BY creado ASC");
  for (const r of rs) {
    try { resultados.set(r.conversation_id, String((JSON.parse(r.analisis) as { resultado?: string }).resultado ?? "")); } catch { /* ignorar */ }
  }
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const llamadas = new Map<string, { pasada: boolean; agendada: boolean }>();
  for (const l of await cargarLlamadas(env, now)) {
    const prev = llamadas.get(l.convId) ?? { pasada: false, agendada: false };
    if (l.estado === "pasada") prev.pasada = true;
    if (l.estado === "agendada") prev.agendada = true;
    llamadas.set(l.convId, prev);
  }
  const manual = new Map<string, string>();
  const ms = await db.all<{ id: string; e: string | null }>("SELECT id, json_extract(metadata, '$.crm_etapa') AS e FROM conversations WHERE json_extract(metadata, '$.crm_etapa') IS NOT NULL");
  for (const m of ms) if (m.e) manual.set(m.id, m.e);
  return filas.map((fila) => {
    const man = manual.get(fila.lead.convId);
    return man && etapaValida(man) ? { fila, etapa: man, manual: true } : { fila, etapa: etapaAutomatica(fila, { resultados, llamadas }), manual: false };
  });
}

/** Mueve un cliente a mano. «auto» devuelve el control al cálculo automático. */
export async function fijarEtapa(env: Env, convId: string, etapa: string): Promise<boolean> {
  const db = new Db(env.DB);
  if (etapa === "auto") {
    await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.crm_etapa') WHERE id = ?", [convId]);
    return true;
  }
  if (!etapaValida(etapa)) return false;
  await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_etapa', ?) WHERE id = ?", [etapa, convId]);
  return true;
}

/** Tras interpretar una llamada: avanza al cliente, salvo que Maricela ya lo haya cerrado o perdido a mano. */
export async function avanzarPorResultado(env: Env, convId: string, resultado: string): Promise<void> {
  const db = new Db(env.DB);
  const r = await db.first<{ e: string | null }>("SELECT json_extract(metadata, '$.crm_etapa') AS e FROM conversations WHERE id = ?", [convId]);
  if (r?.e === "cerrado" || r?.e === "perdido") return;
  await fijarEtapa(env, convId, resultado === "concretado" || resultado === "parcial" ? "negociando" : "hecha");
}

// ─── Vista ───────────────────────────────────────────────────────────────────

const MAX_POR_COLUMNA = 40;
const DIA = 24 * 3600_000;

function tarjeta(t: TarjetaPipeline, now: number): string {
  const f = t.fila;
  const l = f.lead;
  const m = l.ficha.metadata;
  const dias = Math.floor((now - f.ultimo) / DIA);
  const quieto = dias >= 5 && (t.etapa === "hecha" || t.etapa === "negociando" || t.etapa === "agendada");
  const opciones = ETAPAS.map((e) => `<option value="${e.id}"${e.id === t.etapa ? " selected" : ""}>${e.icono} ${e.nombre}</option>`).join("")
    + (t.manual ? `<option value="auto">↺ Volver a automático</option>` : "");
  return `<div class="pl-card" draggable="true" data-conv="${esc(l.convId)}">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start">
      <a href="/crm/c/${encodeURIComponent(l.convId)}" style="font-weight:600;font-size:13px;color:var(--cream);line-height:1.3">${esc(l.nombre || "Sin nombre")}</a>
      ${badgeNivel(l.prioridad.nivel)}
    </div>
    <div class="text-dim" style="font-size:11px;margin:4px 0">${esc(l.canal)}${m.ciudadCompra ? ` · ${esc(m.ciudadCompra)}` : ""}${m.ahorroDisponible ? ` · ${esc(m.ahorroDisponible)}` : ""}</div>
    ${l.llamada ? `<div style="font-size:11px;color:var(--info)">📅 ${esc(l.llamada)}</div>` : ""}
    <div style="font-size:10.5px;margin-top:4px;${quieto ? "color:var(--bad);font-weight:600" : "color:var(--dim)"}">${quieto ? "⚠ " : ""}Último mensaje ${esc(hace(f.ultimo, now))}</div>
    <select name="etapa" hx-post="/crm/etapa" hx-vals='{"conv":"${esc(l.convId)}"}' hx-trigger="change" hx-swap="none" hx-on::after-request="location.reload()" class="crm-in" style="width:100%;margin-top:8px;font-size:11px;padding:4px">${opciones}</select>
  </div>`;
}

export async function renderCrmPipeline(env: Env, now = Date.now()): Promise<string> {
  const todas = await cargarPipeline(env, now);
  const orden = { caliente: 0, tibio: 1, frio: 2 } as const;
  const col = (id: EtapaId) => todas.filter((t) => t.etapa === id).sort((a, b) => orden[a.fila.lead.prioridad.nivel] - orden[b.fila.lead.prioridad.nivel] || b.fila.ultimo - a.fila.ultimo);
  const columnas = ETAPAS.map((e) => {
    const ts = col(e.id);
    return `<div class="pl-col" data-etapa="${e.id}">
      <div class="pl-head" title="${esc(e.ayuda)}"><span>${e.icono} ${e.nombre}</span><b>${ts.length}</b></div>
      <div class="pl-body">${ts.slice(0, MAX_POR_COLUMNA).map((t) => tarjeta(t, now)).join("") || `<div class="text-dim" style="font-size:11.5px;padding:8px">Vacío</div>`}${ts.length > MAX_POR_COLUMNA ? `<div class="text-dim" style="font-size:11px;padding:6px">y ${ts.length - MAX_POR_COLUMNA} más (usa Leads para verlos)</div>` : ""}</div>
    </div>`;
  }).join("");
  const n = (id: EtapaId) => col(id).length;
  const conLlamada = n("hecha") + n("negociando") + n("cerrado");
  const resumen = `<div class="text-dim" style="font-size:12.5px;margin-bottom:12px">${todas.length} clientes · ${n("agendada")} con llamada agendada · ${conLlamada} ya hablaron con Maricela · ${n("negociando")} negociando · ${n("cerrado")} cerrados. Arrastra una tarjeta a otra columna o usa el selector. Las etapas se mueven solas con la llamada y su resultado; lo que muevas tú manda.</div>`;
  const body = `${ESTILO_CRM}<style>
    .pl-board{display:grid;grid-template-columns:repeat(7,minmax(210px,1fr));gap:10px;overflow-x:auto;padding-bottom:12px}
    .pl-col{background:var(--panel2);border:1px solid var(--line);min-height:300px;display:flex;flex-direction:column}
    .pl-col.over{border-color:var(--accent);background:var(--accent-soft)}
    .pl-head{display:flex;justify-content:space-between;padding:10px 12px;font-size:12px;font-weight:700;border-bottom:1px solid var(--line);color:var(--cream)}
    .pl-head b{color:var(--accent)}
    .pl-body{padding:8px;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 260px);overflow-y:auto}
    .pl-card{background:var(--panel);border:1px solid var(--line);padding:10px;cursor:grab}
    .pl-card:hover{border-color:var(--linelit)} .pl-card.drag{opacity:.4}
  </style>
  ${resumen}<div class="pl-board">${columnas}</div>
  <script>(function(){var arr=null;
    document.querySelectorAll('.pl-card').forEach(function(c){
      c.addEventListener('dragstart',function(e){arr=c;c.classList.add('drag');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',c.dataset.conv)});
      c.addEventListener('dragend',function(){c.classList.remove('drag')})});
    document.querySelectorAll('.pl-col').forEach(function(col){
      col.addEventListener('dragover',function(e){e.preventDefault();col.classList.add('over')});
      col.addEventListener('dragleave',function(){col.classList.remove('over')});
      col.addEventListener('drop',function(e){e.preventDefault();col.classList.remove('over');if(!arr)return;
        var s=arr.querySelector('select');if(!s||s.value===col.dataset.etapa)return;s.value=col.dataset.etapa;s.dispatchEvent(new Event('change',{bubbles:true}))})});
  })();</script>`;
  return crmLayout({ title: "Pipeline", activa: "pipeline", body, env });
}
