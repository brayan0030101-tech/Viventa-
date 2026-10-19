// member/crm-oportunidades.local.ts — CRM de Viventa: «Oportunidades» (Zoho: módulo Deals).
// Recorrido del cliente en Zoho: Candidato (Leads) → Contacto (Contacts, cuando llena el formulario de viabilidad) → Oportunidad (Deals),
// que tiene dos ramas: SV = Servicio Viventa y VC = Vivecasa (pipeline «Standard (Vivecasa)»). Un solo tablero con la rama como etiqueta.
// También aporta las tareas pendientes de oportunidades y contactos a «Seguimientos» (antes solo se veían las de candidatos).
import type { Env } from "../src/env";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";
import { ZohoError, coql, duenoZoho, tareaPorId, completarTarea, ESTADOS_HECHOS, zohoGet, zohoListo, type FetchFn } from "./crm-zohoapi.local";
import { escrituraActiva, hoyMadrid } from "./crm-seguimientos.local";

const DIA = 86_400_000;
export type Rama = "SV" | "VC";
export const PIPELINE_VC = "Standard (Vivecasa)";
/** Días sin actividad a partir de los cuales una oportunidad se marca en rojo. */
export const DIAS_SIN_ACTIVIDAD = 15;

/** Orden del recorrido (SV y VC mezclados); las etapas que no estén aquí van al final. */
export const ORDEN_ETAPAS = [
  "Nuevo", "SV por iniciar", "En Prospección", "En gestión comercial", "Consulta Centrales por Iniciar", "Resultado Consulta Centrales",
  "En Precalificación", "Selección de proceso de análisis de crédito", "Resultado de Precalificación", "Pre-Venta Ganada",
  "Pre-Venta ganada no facturada", "Facturado", "Verificación", "Seguimiento Post-Venta",
];

export interface TareaOp {
  id: string;
  asunto: string;
  vence: string;
  estado: string;
}
export interface Oportunidad {
  id: string;
  nombre: string;
  rama: Rama;
  etapa: string;
  contactoId: string;
  contacto: string;
  telefono: string;
  /** Última actividad (ms) o, si no hay, la última modificación. */
  actividad: number;
  tareas: TareaOp[];
  tambienEn: Rama | null;
}

const refId = (v: unknown): string => (v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id ?? "") : "");
export const ramaDe = (pipeline: string, tipo = ""): Rama => (pipeline === PIPELINE_VC || /vivecasa/i.test(pipeline) || /preventa/i.test(tipo) ? "VC" : "SV");

async function todos(env: Env, consulta: (off: number) => string, f?: FetchFn, now = Date.now(), tope = 1000): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; off < tope; off += 200) {
    const r = await coql(env, consulta(off), f, now);
    out.push(...r);
    if (r.length < 200) break;
  }
  return out;
}

async function porIds(env: Env, modulo: "Contacts" | "Deals", ids: string[], campos: string, f?: FetchFn, now = Date.now()): Promise<Map<string, Record<string, unknown>>> {
  const mapa = new Map<string, Record<string, unknown>>();
  const unicos = [...new Set(ids.filter((i) => /^\d{6,30}$/.test(i)))];
  for (let i = 0; i < unicos.length; i += 100) {
    const lote = unicos.slice(i, i + 100);
    const j = (await zohoGet(env, `/${modulo}?ids=${lote.join(",")}&fields=${campos}`, f ?? fetch, now)) as { data?: Array<Record<string, unknown>> };
    for (const r of j.data ?? []) mapa.set(String(r["id"]), r);
  }
  return mapa;
}

/** Oportunidades de Maricela con su contacto y sus tareas pendientes. */
export async function cargarOportunidades(env: Env, now = Date.now(), f?: FetchFn): Promise<{ ops: Oportunidad[]; contactos: number }> {
  const dueno = await duenoZoho(env, f, now);
  const deals = await todos(
    env,
    (off) => `select id, Deal_Name, Stage, Type, Pipeline, Modified_Time, Last_Activity_Time, Contact_Name, Link_Oportunidad_SV, Link_Oportunidad_Vivecasa from Deals where Owner = '${dueno.id}' order by Modified_Time desc limit ${off}, 200`,
    f,
    now,
  );
  const tareasRaw = await todos(
    env,
    (off) => `select id, Subject, Due_Date, Status, What_Id, $se_module from Tasks where ((Owner = '${dueno.id}' and $se_module = 'Deals') and Status not in ('Completa','Completed')) order by Due_Date asc limit ${off}, 200`,
    f,
    now,
  ).catch(() => []);
  const tareasDe = new Map<string, TareaOp[]>();
  for (const t of tareasRaw) {
    const dealId = refId(t["What_Id"]);
    if (!dealId) continue;
    const a = tareasDe.get(dealId) ?? [];
    a.push({ id: String(t["id"]), asunto: String(t["Subject"] ?? ""), vence: String(t["Due_Date"] ?? ""), estado: String(t["Status"] ?? "") });
    tareasDe.set(dealId, a);
  }
  const contactosIds = deals.map((d) => refId(d["Contact_Name"]));
  const contactos = await porIds(env, "Contacts", contactosIds, "Full_Name,First_Name,Last_Name,Mobile,Phone", f, now).catch(() => new Map<string, Record<string, unknown>>());
  const ops: Oportunidad[] = deals.map((d) => {
    const cid = refId(d["Contact_Name"]);
    const c = contactos.get(cid);
    const nombreC = c ? String(c["Full_Name"] ?? ([c["First_Name"], c["Last_Name"]].filter(Boolean).join(" ") || "")) : "";
    const act = Date.parse(String(d["Last_Activity_Time"] ?? "")) || Date.parse(String(d["Modified_Time"] ?? "")) || 0;
    const rama = ramaDe(String(d["Pipeline"] ?? ""), String(d["Type"] ?? ""));
    const link = rama === "VC" ? d["Link_Oportunidad_SV"] : d["Link_Oportunidad_Vivecasa"];
    return {
      id: String(d["id"]),
      nombre: nombreC || String(d["Deal_Name"] ?? "Sin nombre"),
      rama,
      etapa: String(d["Stage"] ?? "(sin etapa)"),
      contactoId: cid,
      contacto: nombreC,
      telefono: c ? String(c["Mobile"] ?? c["Phone"] ?? "") : "",
      actividad: act,
      tareas: (tareasDe.get(String(d["id"])) ?? []).sort((a, b) => (a.vence < b.vence ? -1 : 1)),
      tambienEn: refId(link) ? (rama === "VC" ? "SV" : "VC") : null,
    };
  });
  const nContactos = (await todos(env, (off) => `select id from Contacts where Owner = '${dueno.id}' limit ${off}, 200`, f, now, 2000).catch(() => [])).length;
  void now;
  return { ops, contactos: nContactos };
}

export function columnasEtapas(ops: Oportunidad[]): string[] {
  const hay = new Set(ops.map((o) => o.etapa));
  const conocidas = ORDEN_ETAPAS.filter((e) => hay.has(e));
  const otras = [...hay].filter((e) => !ORDEN_ETAPAS.includes(e)).sort();
  return [...conocidas, ...otras];
}

// ─── Vista: tablero ──────────────────────────────────────────────────────────

const chipRama = (r: Rama): string =>
  `<span style="display:inline-block;padding:1px 7px;font-size:10.5px;font-weight:700;letter-spacing:.06em;border:1px solid ${r === "SV" ? "var(--info)" : "var(--accent-2)"};color:${r === "SV" ? "var(--info)" : "var(--accent-2)"}" title="${r === "SV" ? "Servicio Viventa" : "Vivecasa"}">${r}</span>`;

function tarjeta(o: Oportunidad, hoy: string, now: number): string {
  const dias = o.actividad ? Math.floor((now - o.actividad) / DIA) : null;
  const quieto = dias != null && dias >= DIAS_SIN_ACTIVIDAD;
  const vencidas = o.tareas.filter((t) => t.vence && t.vence <= hoy).length;
  const prox = o.tareas[0];
  return `<div class="pl-card op-card" data-rama="${o.rama}" data-q="${esc((o.nombre + " " + o.telefono).toLowerCase())}">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start"><b style="font-size:13px;color:var(--cream);line-height:1.3">${esc(o.nombre)}</b>${chipRama(o.rama)}</div>
    ${o.telefono ? `<div class="text-dim" style="font-size:11px;margin-top:3px">${esc(o.telefono)}</div>` : ""}
    ${o.tambienEn ? `<div style="font-size:10.5px;color:var(--dim);margin-top:3px">↔ también tiene oportunidad ${o.tambienEn}</div>` : ""}
    <div style="font-size:11px;margin-top:5px;color:${quieto ? "var(--bad)" : "var(--dim)"};${quieto ? "font-weight:600" : ""}">${quieto ? "⚠ " : ""}${dias == null ? "Sin actividad registrada" : dias === 0 ? "Actividad hoy" : `Actividad hace ${dias} día${dias === 1 ? "" : "s"}`}</div>
    ${prox ? `<div style="font-size:11px;margin-top:3px;color:${vencidas ? "var(--bad)" : "var(--muted)"}">${vencidas ? "🔴" : "☑"} ${o.tareas.length} tarea${o.tareas.length === 1 ? "" : "s"} · próxima ${esc(prox.vence || "sin fecha")}${vencidas ? ` · ${vencidas} vencida${vencidas === 1 ? "" : "s"}` : ""}</div><div class="text-dim" style="font-size:10.5px;margin-top:2px">${esc(prox.asunto.slice(0, 70))}</div>` : `<div class="text-dim" style="font-size:11px;margin-top:3px">Sin tareas pendientes</div>`}
  </div>`;
}

export async function renderOportunidades(env: Env, opts: { rama?: string } = {}, now = Date.now(), f?: FetchFn): Promise<string> {
  let cuerpo: string;
  if (!zohoListo(env)) {
    cuerpo = `<div class="crm-card" style="padding:28px;text-align:center;color:var(--dim)">Zoho todavía no está conectado.</div>`;
  } else {
    try {
      const { ops, contactos } = await cargarOportunidades(env, now, f);
      const hoy = hoyMadrid(now);
      const sv = ops.filter((o) => o.rama === "SV").length;
      const vc = ops.length - sv;
      const conVencidas = ops.filter((o) => o.tareas.some((t) => t.vence && t.vence <= hoy)).length;
      const quietas = ops.filter((o) => o.actividad && (now - o.actividad) / DIA >= DIAS_SIN_ACTIVIDAD).length;
      const sinTarea = ops.filter((o) => o.tareas.length === 0).length;
      const ver = opts.rama === "SV" || opts.rama === "VC" ? opts.rama : "";
      const lista = ver ? ops.filter((o) => o.rama === ver) : ops;
      const cols = columnasEtapas(lista);
      const columnas = cols
        .map((e) => {
          const ts = lista.filter((o) => o.etapa === e).sort((a, b) => (b.tareas.some((t) => t.vence <= hoy) ? 1 : 0) - (a.tareas.some((t) => t.vence <= hoy) ? 1 : 0) || a.actividad - b.actividad);
          return `<div class="pl-col"><div class="pl-head"><span>${esc(e)}</span><b>${ts.length}</b></div><div class="pl-body">${ts.map((o) => tarjeta(o, hoy, now)).join("")}</div></div>`;
        })
        .join("");
      const kpi = (t: string, v: number, color = "", href = "") =>
        `<${href ? `a href="${href}"` : "div"} class="crm-kpi${href && ver === (href.split("=")[1] ?? "x") ? " on" : ""}"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${t}</div><div style="font-weight:700;font-size:24px;${color ? `color:${color}` : ""}">${v}</div></${href ? "a" : "div"}>`;
      const flujo = `<div class="crm-card" style="padding:12px 16px;margin-bottom:14px;font-size:12.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <b style="color:var(--cream)">Recorrido en Zoho:</b> <span>Candidato</span> <span class="text-dim">→ llena la viabilidad →</span> <span><b>Contacto</b> (${contactos})</span> <span class="text-dim">→</span> <span>Oportunidad: ${chipRama("SV")} Servicio Viventa <b>${sv}</b> · ${chipRama("VC")} Vivecasa <b>${vc}</b></span></div>`;
      cuerpo = `${flujo}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px">
          ${kpi("Oportunidades", ops.length, "", "/crm/oportunidades")}
          ${kpi("SV · Servicio Viventa", sv, "var(--info)", "/crm/oportunidades?rama=SV")}
          ${kpi("VC · Vivecasa", vc, "var(--accent-2)", "/crm/oportunidades?rama=VC")}
          ${kpi("Con tareas vencidas", conVencidas, "var(--bad)")}
          ${kpi(`Sin actividad ${DIAS_SIN_ACTIVIDAD}+ días`, quietas, "var(--accent-2)")}
          ${kpi("Sin tarea pendiente", sinTarea)}</div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap"><input id="op-q" class="crm-in" type="search" placeholder="Buscar por nombre o teléfono…" style="min-width:260px;padding:8px 10px;font-size:12.5px"><span class="text-dim" style="font-size:11.5px">${ver ? `Mostrando solo ${ver}. ` : ""}Las columnas siguen el recorrido de la oportunidad.</span></div>
        <style>.op-board{display:flex;gap:10px;overflow-x:auto;padding-bottom:12px;align-items:flex-start}.op-board .pl-col{min-width:230px;max-width:230px;flex:0 0 230px;min-height:120px}.op-card{cursor:default}</style>
        <div class="op-board">${columnas || `<div class="crm-card" style="padding:30px;color:var(--dim)">No hay oportunidades.</div>`}</div>
        <script>(function(){var q=document.getElementById('op-q');if(!q)return;q.addEventListener('input',function(){var v=q.value.toLowerCase().trim();document.querySelectorAll('.op-card').forEach(function(c){c.style.display=(!v||c.dataset.q.indexOf(v)>=0)?'':'none'})})})();</script>`;
    } catch (e) {
      console.error("[crm-oportunidades] cargar:", e);
      cuerpo = `<div class="crm-card" style="padding:24px;color:var(--bad)">${e instanceof ZohoError ? esc(e.message) : "No pude leer Zoho ahora. Inténtalo en unos minutos."}</div>`;
    }
  }
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Las oportunidades de Maricela en Zoho, en un solo tablero. La etiqueta indica la rama: <b style="color:var(--cream)">SV</b> (Servicio Viventa) o <b style="color:var(--cream)">VC</b> (Vivecasa). Una oportunidad nace cuando el candidato llena la viabilidad y pasa a contacto.</div>
    ${cuerpo}`;
  return crmLayout({ title: "Oportunidades", activa: "oportunidades", body, env });
}

// ─── Para «Seguimientos»: tareas vencidas y de hoy de oportunidades ──────────

export interface FilaTareaOp {
  tarea: TareaOp;
  op: Oportunidad;
  atraso: number;
}

/** Tareas pendientes (vencidas o de hoy) de las oportunidades de Maricela, de la más atrasada a la de hoy. */
export async function tareasDeOportunidades(env: Env, now = Date.now(), f?: FetchFn): Promise<FilaTareaOp[]> {
  const hoy = hoyMadrid(now);
  const { ops } = await cargarOportunidades(env, now, f);
  const out: FilaTareaOp[] = [];
  for (const op of ops) for (const t of op.tareas) if (t.vence && t.vence <= hoy) out.push({ tarea: t, op, atraso: Math.round((Date.parse(`${hoy}T12:00:00Z`) - Date.parse(`${t.vence}T12:00:00Z`)) / DIA) });
  return out.sort((a, b) => b.atraso - a.atraso);
}

/** Marca como «Completa» una tarea de oportunidad (solo si sigue pendiente). */
export async function completarTareaOp(env: Env, tareaId: string, now = Date.now(), f?: FetchFn): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await escrituraActiva(env))) return { ok: false, error: "Zoho está en modo solo lectura. Avísale a Brayan para activar la escritura." };
  try {
    const t = await tareaPorId(env, tareaId, f, now);
    if (!t) return { ok: false, error: "No encontré esa tarea en Zoho." };
    if (ESTADOS_HECHOS.includes(t.estado)) return { ok: true };
    await completarTarea(env, tareaId, f, now);
    return { ok: true };
  } catch (e) {
    console.error("[crm-oportunidades] completar:", e);
    return { ok: false, error: e instanceof ZohoError ? e.message : "No pude actualizar Zoho." };
  }
}

export function htmlTareasOportunidades(filas: FilaTareaOp[], hoy: string, escritura: boolean): string {
  if (filas.length === 0) return `<div style="padding:24px 18px;text-align:center;color:var(--dim)">No hay tareas vencidas ni para hoy en tus oportunidades 🎉</div>`;
  const COLS = "130px minmax(160px,1fr) 80px minmax(150px,1fr) 260px";
  return `<div class="crm-row crm-head" style="grid-template-columns:${COLS}"><span>Vence</span><span>Cliente</span><span>Rama</span><span>Tarea · etapa</span><span></span></div>
    ${filas
      .map((x) => {
        const id = "fo-" + x.tarea.id;
        const atr = x.atraso > 0 ? `<b style="color:var(--bad)">Vencida hace ${x.atraso} día${x.atraso === 1 ? "" : "s"}</b>` : `<b style="color:var(--ok)">Hoy</b>`;
        return `<div class="crm-row" style="grid-template-columns:${COLS};align-items:start">
          <span style="font-size:12px">${atr}<br><span class="text-dim" style="font-size:10.5px">${esc(x.tarea.vence)}</span></span>
          <span><b style="color:var(--cream)">${esc(x.op.nombre)}</b>${x.op.telefono ? `<br><span class="text-dim" style="font-size:11px">${esc(x.op.telefono)}</span>` : ""}</span>
          <span>${chipRama(x.op.rama)}</span>
          <span class="text-muted" style="font-size:12px">${esc(x.tarea.asunto || "Tarea")}<br><span class="text-dim" style="font-size:10.5px">${esc(x.op.etapa)}</span></span>
          <span><form hx-post="/crm/seguimientos/fecha" hx-target="#${id}" hx-swap="innerHTML" hx-disabled-elt="find button" style="margin:0 0 4px;display:flex;gap:4px;flex-wrap:wrap"><input type="hidden" name="tarea" value="${esc(x.tarea.id)}"><input type="date" name="fecha" min="${esc(hoy)}" required class="crm-in" style="font-size:11px;padding:3px 4px;width:118px"><button class="bigbtn" style="cursor:pointer;padding:3px 8px;font-size:11px">Cambiar fecha</button></form>
            ${escritura ? `<button class="bigbtn" style="cursor:pointer;padding:4px 10px;font-size:11px" hx-post="/crm/oportunidades/completar" hx-vals='{"tarea":"${esc(x.tarea.id)}"}' hx-target="#${id}" hx-swap="innerHTML" hx-disabled-elt="this" hx-confirm="¿Marcar esta tarea como completa en Zoho?">✔ Marcar completa</button>` : ""}
            <span id="${id}" style="display:block;margin-top:3px"></span></span></div>`;
      })
      .join("")}`;
}
