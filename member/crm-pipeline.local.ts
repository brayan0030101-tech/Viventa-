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
  { id: "probable", nombre: "Más probables de comprar", icono: "⭐", ayuda: "Los que Maricela cree que van a comprar (los elige ella; los quita cuando negocia, cierra o descarta)" },
  { id: "cierre", nombre: "En cierre", icono: "🎯", ayuda: "Cliente caliente que ya habló con Maricela y ya tiene el formulario de viabilidad enviado (estado «Formulario CC» o posterior en Zoho)" },
  { id: "negociando", nombre: "Negociando", icono: "🤝", ayuda: "Hay avance concreto" },
  { id: "cerrado", nombre: "Cerrado", icono: "🏆", ayuda: "Compró / reservó" },
  { id: "perdido", nombre: "Perdido", icono: "✖️", ayuda: "Sin respuesta 21 días después de la llamada" },
  { id: "descartado", nombre: "Descartado", icono: "🚫", ayuda: "Maricela lo descartó (puede dejar una observación con el motivo, sin ser obligatoria)" },
] as const;
export type EtapaId = (typeof ETAPAS)[number]["id"];
export const etapaValida = (v: unknown): v is EtapaId => ETAPAS.some((e) => e.id === v);

/** Estados de Zoho que significan «ya se le envió el formulario de viabilidad» (Maricela: transición «Diligenciar Formulario CC» y lo que sigue). */
export const ESTADOS_FORMULARIO_ENVIADO = ["Formulario CC", "En Pre-calificación", "Resultado Pre-calificación", "Pre-calificado Incompleto", "Enviado a constructora", "Puente"];

interface Contexto {
  /** conversación → estado del candidato en Zoho (lo guarda la sincronización) */
  zoho?: Map<string, string>;
  /** conversación → resultado de la última llamada analizada */
  resultados: Map<string, string>;
  /** conversación → llamadas */
  llamadas: Map<string, { pasada: boolean; agendada: boolean }>;
  /** conversación → etapa fijada a mano */
  manual: Map<string, string>;
}

/** Etapa automática de un cliente según lo que ya sabemos de él. */
/** Días sin ningún mensaje, después de la llamada, para darlo por enfriado. */
const ENFRIA_DIAS = 21;
const DIA = 24 * 3600_000;

export function etapaAutomatica(f: FilaCrm, ctx: Pick<Contexto, "resultados" | "llamadas" | "zoho">, now = Date.now()): EtapaId {
  const id = f.lead.convId;
  const res = ctx.resultados.get(id);
  if (res === "concretado" || res === "parcial") return "negociando";
  const ll = ctx.llamadas.get(id);
  if (res || ll?.pasada) {
    if (now - f.ultimo > ENFRIA_DIAS * DIA) return "perdido";
    // En cierre (pedido de Brayan, 21 oct 2026): caliente + ya habló con Maricela + formulario de viabilidad enviado (estado «Formulario CC» o posterior en Zoho).
    return f.lead.prioridad.nivel === "caliente" && ESTADOS_FORMULARIO_ENVIADO.includes(ctx.zoho?.get(id) ?? "") ? "cierre" : "hecha";
  }
  if (ll?.agendada || f.lead.llamada) return "agendada";
  const campos = Object.entries(f.lead.ficha.metadata).filter(([k, v]) => v && !/^(cita|cal)/i.test(k)).length;
  return f.lead.prioridad.nivel !== "frio" || campos >= 3 ? "calificado" : "nuevo";
}

export interface TarjetaPipeline { fila: FilaCrm; etapa: EtapaId; manual: boolean; /** Cuándo la puso Maricela en «Más probables» (ms), si aplica. */ probableEn?: number }

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
  const zoho = new Map<string, string>();
  for (const z of await db.all<{ id: string; e: string | null }>("SELECT id, json_extract(metadata, '$.zoho_estado') AS e FROM conversations WHERE json_extract(metadata, '$.zoho_estado') IS NOT NULL")) if (z.e) zoho.set(z.id, z.e);
  const manual = new Map<string, string>();
  const ms = await db.all<{ id: string; e: string | null }>("SELECT id, json_extract(metadata, '$.crm_etapa') AS e FROM conversations WHERE json_extract(metadata, '$.crm_etapa') IS NOT NULL");
  for (const m of ms) if (m.e) manual.set(m.id, m.e);
  const probableEn = new Map<string, number>();
  for (const m of await db.all<{ id: string; t: string }>("SELECT id, json_extract(metadata, '$.crm_probable_en') AS t FROM conversations WHERE json_extract(metadata, '$.crm_etapa') = 'probable'")) {
    const t = Date.parse(m.t);
    if (Number.isFinite(t)) probableEn.set(m.id, t);
  }
  return filas.map((fila) => {
    const man = manual.get(fila.lead.convId);
    return man && etapaValida(man) ? { fila, etapa: man, manual: true, ...(man === "probable" && probableEn.has(fila.lead.convId) ? { probableEn: probableEn.get(fila.lead.convId) } : {}) } : { fila, etapa: etapaAutomatica(fila, { resultados, llamadas, zoho }, now), manual: false };
  });
}

/** Mueve un cliente a mano. «auto» devuelve el control al cálculo automático. */
export async function fijarEtapa(env: Env, convId: string, etapa: string): Promise<boolean> {
  const db = new Db(env.DB);
  // Lo descartado desde la lista de Leads también queda marcado `crm_descarte` (el bot, las cotizaciones y la subida a Zoho ya lo respetan); al moverlo a otra situación se quita.
  const quitarDescarte = () => db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.crm_descarte') WHERE id = ? AND json_extract(COALESCE(metadata, '{}'), '$.crm_descarte.por') = 'leads'", [convId]);
  if (etapa === "auto") {
    await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.crm_etapa', '$.crm_probable_en') WHERE id = ?", [convId]);
    await quitarDescarte();
    return true;
  }
  if (!etapaValida(etapa)) return false;
  if (etapa === "descartado") {
    await db.run("UPDATE conversations SET metadata = json_remove(json_set(COALESCE(metadata, '{}'), '$.crm_etapa', 'descartado', '$.crm_descarte', json(?)), '$.crm_probable_en') WHERE id = ?", [JSON.stringify({ por: "leads", en: new Date().toISOString() }), convId]);
    return true;
  }
  await quitarDescarte();
  if (etapa === "probable") {
    // Conserva la fecha original si ya estaba en la lista (no se reordena al volver a pulsar).
    await db.run(
      "UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_etapa', 'probable', '$.crm_probable_en', COALESCE(json_extract(metadata, '$.crm_probable_en'), ?)) WHERE id = ?",
      [new Date().toISOString(), convId],
    );
    return true;
  }
  await db.run("UPDATE conversations SET metadata = json_remove(json_set(COALESCE(metadata, '{}'), '$.crm_etapa', ?), '$.crm_probable_en') WHERE id = ?", [etapa, convId]);
  return true;
}

/** Tras interpretar una llamada: avanza al cliente, salvo que Maricela ya lo haya cerrado o perdido a mano. */
export async function avanzarPorResultado(env: Env, convId: string, resultado: string): Promise<void> {
  const db = new Db(env.DB);
  const r = await db.first<{ e: string | null }>("SELECT json_extract(metadata, '$.crm_etapa') AS e FROM conversations WHERE id = ?", [convId]);
  if (r?.e === "cerrado" || r?.e === "perdido") return;
  const destino = resultado === "cerrado" ? "cerrado" : resultado === "concretado" || resultado === "parcial" ? "negociando" : "hecha";
  // Maricela puso a este cliente entre los más probables: una llamada sin avance concreto no lo saca de ahí.
  if (r?.e === "probable" && destino === "hecha") return;
  await fijarEtapa(env, convId, destino);
}

// ─── Vista ───────────────────────────────────────────────────────────────────

const MAX_POR_COLUMNA = 40;

function tarjeta(t: TarjetaPipeline, now: number): string {
  const f = t.fila;
  const l = f.lead;
  const m = l.ficha.metadata;
  const dias = Math.floor((now - f.ultimo) / DIA);
  const quieto = dias >= 5 && (t.etapa === "hecha" || t.etapa === "cierre" || t.etapa === "negociando" || t.etapa === "agendada");
  const opciones = ETAPAS.map((e) => `<option value="${e.id}"${e.id === t.etapa ? " selected" : ""}>${e.icono} ${e.nombre}</option>`).join("")
    + (t.manual ? `<option value="auto">↺ Volver a automático</option>` : "");
  return `<div class="pl-card" draggable="true" data-conv="${esc(l.convId)}">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start">
      <a href="/crm/c/${encodeURIComponent(l.convId)}" style="font-weight:600;font-size:13px;color:var(--cream);line-height:1.3">${esc(l.nombre || "Sin nombre")}</a>
      <span style="display:flex;gap:6px;align-items:center">${badgeNivel(l.prioridad.nivel)}${t.etapa === "probable" || t.etapa === "cerrado" || t.etapa === "perdido" ? "" : `<button type="button" title="Agregar a «Más probables de comprar»" hx-post="/crm/etapa" hx-vals='{"conv":"${esc(l.convId)}","etapa":"probable"}' hx-swap="none" hx-on::after-request="location.reload()" style="background:none;border:0;cursor:pointer;font-size:17px;line-height:1;color:var(--muted);padding:0">☆</button>`}</span>
    </div>
    <div class="text-dim" style="font-size:11px;margin:4px 0">${esc(l.canal)}${m.ciudadCompra ? ` · ${esc(m.ciudadCompra)}` : ""}${m.ahorroDisponible ? ` · ${esc(m.ahorroDisponible)}` : ""}</div>
    ${l.llamada ? `<div style="font-size:11px;color:var(--info)">📅 ${esc(l.llamada)}</div>` : ""}
    ${t.etapa === "probable" && t.probableEn ? `<div style="font-size:10.5px;color:var(--accent);margin-top:4px">⭐ En esta lista ${esc(hace(t.probableEn, now))}</div>` : ""}
    <div style="font-size:10.5px;margin-top:4px;${quieto ? "color:var(--bad);font-weight:600" : "color:var(--dim)"}">${quieto ? "⚠ " : ""}Último mensaje ${esc(hace(f.ultimo, now))}</div>
    <select name="etapa" hx-post="/crm/etapa" hx-vals='{"conv":"${esc(l.convId)}"}' hx-trigger="change" hx-swap="none" hx-on::after-request="location.reload()" class="crm-in" style="width:100%;margin-top:8px;font-size:11px;padding:4px">${opciones}</select>
    ${t.etapa === "probable" ? `<button type="button" class="crm-in" style="width:100%;margin-top:6px;font-size:11px;padding:4px;cursor:pointer;color:var(--muted)" hx-post="/crm/etapa" hx-vals='{"conv":"${esc(l.convId)}","etapa":"auto"}' hx-swap="none" hx-on::after-request="location.reload()" hx-confirm="¿Quitar a este cliente de «Más probables de comprar»? Vuelve a su etapa automática.">✕ Quitar de esta lista</button>` : ""}
  </div>`;
}

export async function renderCrmPipeline(env: Env, now = Date.now()): Promise<string> {
  const todas = await cargarPipeline(env, now);
  const orden = { caliente: 0, tibio: 1, frio: 2 } as const;
  const col = (id: EtapaId) =>
    todas.filter((t) => t.etapa === id).sort((a, b) =>
      id === "probable"
        ? (b.probableEn ?? 0) - (a.probableEn ?? 0) // los últimos que puso Maricela, arriba
        : orden[a.fila.lead.prioridad.nivel] - orden[b.fila.lead.prioridad.nivel] || b.fila.ultimo - a.fila.ultimo);
  // Clientes de la base para el buscador de «Más probables»: se buscan en la propia página (sin consultar la base en cada letra).
  const etiqueta = (id: EtapaId) => ETAPAS.find((e) => e.id === id)!;
  const clientes = JSON.stringify(
    todas.map((t) => ({ id: t.fila.lead.convId, n: t.fila.lead.nombre || "Sin nombre", t: t.fila.lead.telefono, c: t.fila.lead.correo.split(",")[0] ?? "", k: t.fila.lead.canal, e: `${etiqueta(t.etapa).icono} ${etiqueta(t.etapa).nombre}`, p: t.etapa === "probable" ? 1 : 0 })),
  ).replace(/</g, "\\u003c");
  const buscador = `<div class="pl-add"><input id="pl-q" class="crm-in" type="search" autocomplete="off" placeholder="➕ Buscar cliente: nombre, teléfono o correo…" style="width:100%;font-size:12px;padding:7px">
      <div id="pl-res"></div><span id="pl-url" hx-post="/crm/etapa" hidden></span></div>`;
  const columnas = ETAPAS.map((e) => {
    const ts = col(e.id);
    return `<div class="pl-col" data-etapa="${e.id}">
      <div class="pl-head" title="${esc(e.ayuda)}"><span>${e.icono} ${e.nombre}</span><b>${ts.length}</b></div>
      ${e.id === "probable" ? buscador : ""}
      <div class="pl-body">${ts.slice(0, MAX_POR_COLUMNA).map((t) => tarjeta(t, now)).join("") || `<div class="text-dim" style="font-size:11.5px;padding:8px">Vacío</div>`}${ts.length > MAX_POR_COLUMNA ? `<div class="text-dim" style="font-size:11px;padding:6px">y ${ts.length - MAX_POR_COLUMNA} más (usa Leads para verlos)</div>` : ""}</div>
    </div>`;
  }).join("");
  const n = (id: EtapaId) => col(id).length;
  const conLlamada = n("hecha") + n("cierre") + n("negociando") + n("cerrado");
  const resumen = `<div class="text-dim" style="font-size:12.5px;margin-bottom:12px">${todas.length} clientes · ${n("agendada")} con llamada agendada · ${conLlamada} ya hablaron con Maricela · ${n("probable")} más probables de comprar · ${n("cierre")} en cierre · ${n("negociando")} negociando · ${n("cerrado")} cerrados. Arrastra una tarjeta a otra columna o usa el selector. Las etapas se mueven solas con la llamada y su resultado; lo que muevas tú manda. En <b>⭐ Más probables de comprar</b> pones tú a los clientes que crees que van a comprar (búscalos por nombre, teléfono o correo): se quedan ahí hasta que los muevas a Negociando, Cerrado o Perdido, o los quites.</div>`;
  const body = `${ESTILO_CRM}<style>
    .pl-board{display:grid;grid-template-columns:repeat(8,minmax(210px,1fr));gap:10px;overflow-x:auto;padding-bottom:12px}
    .pl-col{background:var(--panel2);border:1px solid var(--line);min-height:300px;display:flex;flex-direction:column}
    .pl-col.over{border-color:var(--accent);background:var(--accent-soft)}
    .pl-head{display:flex;justify-content:space-between;padding:10px 12px;font-size:12px;font-weight:700;border-bottom:1px solid var(--line);color:var(--cream)}
    .pl-head b{color:var(--accent)}
    .pl-body{padding:8px;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 260px);overflow-y:auto}
    .pl-card{background:var(--panel);border:1px solid var(--line);padding:10px;cursor:grab}
    .pl-card:hover{border-color:var(--linelit)} .pl-card.drag{opacity:.4}
    .pl-add{padding:8px 8px 0;position:relative}
    #pl-res{display:flex;flex-direction:column;gap:4px;margin-top:6px}
    .pl-hit{text-align:left;background:var(--panel);border:1px solid var(--line);color:var(--cream);padding:7px 9px;font-size:12px;cursor:pointer;font-family:inherit}
    .pl-hit:hover{border-color:var(--accent)} .pl-hit small{display:block;color:var(--dim);font-size:10.5px;margin-top:2px}
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
  })();
  (function(){var D=${clientes};var q=document.getElementById('pl-q'),res=document.getElementById('pl-res');if(!q)return;
    var url=document.getElementById('pl-url').getAttribute('hx-post');
    function norm(t){return String(t||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase()}
    function digs(t){return String(t||'').replace(/\\D/g,'')}
    function esc(t){return String(t||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
    function buscar(){var v=norm(q.value).trim();res.innerHTML='';if(v.length<2)return;
      var toks=v.split(/\\s+/),dv=digs(v),out=[];
      for(var i=0;i<D.length&&out.length<8;i++){var c=D[i];if(c.p)continue;
        var hay=norm(c.n+' '+c.c);var ok=toks.every(function(t){return hay.indexOf(t)>=0});
        if(!ok&&dv.length>=4&&digs(c.t).indexOf(dv)>=0)ok=true;if(ok)out.push(c)}
      if(!out.length){res.innerHTML='<div class="text-dim" style="font-size:11.5px;padding:4px">No encuentro a nadie con eso (o ya está en la lista).</div>';return}
      res.innerHTML=out.map(function(c){return '<button type="button" class="pl-hit" data-conv="'+esc(c.id)+'">'+esc(c.n)+'<small>'+esc(c.k)+(c.t?' · '+esc(c.t):'')+' · ahora: '+esc(c.e)+'</small></button>'}).join('')}
    q.addEventListener('input',buscar);
    res.addEventListener('click',function(e){var b=e.target.closest('.pl-hit');if(!b)return;b.disabled=true;b.textContent='Agregando…';
      var fd=new URLSearchParams();fd.set('conv',b.dataset.conv);fd.set('etapa','probable');
      fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fd.toString(),credentials:'same-origin'}).then(function(r){if(r.ok)location.reload();else{b.textContent='No se pudo agregar'}}).catch(function(){b.textContent='No se pudo agregar'})})
  })();</script>`;
  return crmLayout({ title: "Pipeline", activa: "pipeline", body, env });
}

/** Observación libre y OPCIONAL sobre un cliente (por qué se descartó, en qué va la negociación…). Vacía = se borra. */
export async function fijarObservacion(env: Env, convId: string, texto: string): Promise<void> {
  const db = new Db(env.DB);
  const t = texto.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!t) await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.crm_obs') WHERE id = ?", [convId]);
  else await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_obs', ?) WHERE id = ?", [t, convId]);
}
