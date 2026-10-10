// member/crm-zoho.local.ts — CRM de Viventa: sección «Subir a Zoho».
// Maricela sube cada cliente al formulario de Zoho y aquí los marca como «ya subido»: así no se
// duplican, ve hasta dónde va y lleva todo en orden. La marca vive en la conversación
// (viventa_registrado / viventa_existente), la misma que usan el resumen de las 8:00, el Excel
// de las 6:00 y 14:00 y los comandos de Telegram: todo queda sincronizado.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import {
  armarLeads, llamadasAgendadas, faltantes, urlFormulario, correoParaFormulario, excelListos,
  SETTING_FORM_URL, type LeadResumen,
} from "../src/followup/resumenDia";
import { crmLayout } from "./crm-shell.local";
import { esc, NIVEL, badgeNivel, hace, fechaHora, ESTILO_CRM } from "./crm.local";

const H = 3600_000;
const DIAS_VISIBLES = 90;

export type EstadoZoho = "pendiente" | "incompleto" | "subido" | "existia";

export interface FilaZoho {
  lead: LeadResumen;
  /** Desde cuándo tiene la ficha lista (la última vez que el bot guardó datos): ordena la cola. */
  listoDesde: number;
  estado: EstadoZoho;
  por: string;
  cuando: number | null;
  faltan: string[];
  correoInventado: boolean;
}

interface ConvZ {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  last_message_at: number;
  metadata: string | null;
}

function metaDe(c: ConvZ): Record<string, string> {
  try {
    return c.metadata ? (JSON.parse(c.metadata) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Fecha de una marca: las nuevas son ISO; las viejas («2026-10-09-maricela») traen solo el día. */
function fechaMarca(v: string | undefined): number | null {
  if (!v) return null;
  const iso = Date.parse(v);
  if (Number.isFinite(iso)) return iso;
  const dia = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return dia ? Date.UTC(Number(dia[1]), Number(dia[2]) - 1, Number(dia[3]), 12) : null;
}

export async function cargarZoho(env: Env, now = Date.now()): Promise<FilaZoho[]> {
  const db = new Db(env.DB);
  const convs = await db.all<ConvZ>(
    `SELECT id, channel, channel_user_id, display_name, last_message_at, metadata FROM conversations
      WHERE last_message_at > ? AND channel IN ('ycloud', 'zernio') ORDER BY last_message_at DESC LIMIT 800`,
    [now - DIAS_VISIBLES * 24 * H],
  );
  if (convs.length === 0) return [];
  const ids = new Set(convs.map((c) => c.id));
  const leadsRows = (
    await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null; updated_at: number }>(
      "SELECT conversation_id, name, contact, notes, metadata, updated_at FROM leads WHERE updated_at > ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
      [now - DIAS_VISIBLES * 24 * H],
    )
  ).filter((l) => l.conversation_id && ids.has(l.conversation_id));
  const listo = new Map<string, number>();
  for (const l of leadsRows) listo.set(l.conversation_id!, Math.max(listo.get(l.conversation_id!) ?? 0, l.updated_at));
  const porId = new Map(convs.map((c) => [c.id, c]));
  return armarLeads(convs, leadsRows, await llamadasAgendadas(db, now)).map((lead) => {
    const m = metaDe(porId.get(lead.convId)!);
    const faltan = faltantes(lead);
    const estado: EstadoZoho = m.viventa_registrado ? "subido" : m.viventa_existente ? "existia" : faltan.length ? "incompleto" : "pendiente";
    const marca = m.viventa_registrado ?? m.viventa_existente;
    return {
      lead,
      listoDesde: listo.get(lead.convId) ?? 0,
      estado,
      por: m.viventa_registrado_por ?? m.viventa_existente_por ?? (marca && /-([a-záéíóú]+)$/i.test(marca) ? marca.replace(/^.*-/, "") : ""),
      cuando: fechaMarca(marca),
      faltan,
      correoInventado: correoParaFormulario(lead).inventado,
    };
  });
}

// ─── Marcar ──────────────────────────────────────────────────────────────────

export type AccionZoho = "registrado" | "existente" | "deshacer";

async function asegurarLog(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS crm_zoho_log (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, accion TEXT NOT NULL, usuario TEXT NOT NULL, at INTEGER NOT NULL)");
}

/** Marca (o desmarca) clientes. «registrado»/«existente» no pisan una marca previa: nunca se cuenta dos veces. */
export async function marcarZoho(env: Env, convIds: string[], accion: AccionZoho, por: string, now = Date.now()): Promise<{ cambiados: number }> {
  const db = new Db(env.DB);
  await asegurarLog(db);
  const ids = [...new Set(convIds.filter((x) => /^[\w:.+-]{3,120}$/.test(x)))].slice(0, 300);
  const iso = new Date(now).toISOString();
  const quien = por.trim().slice(0, 60) || "CRM";
  let cambiados = 0;
  for (const id of ids) {
    let r;
    if (accion === "deshacer") {
      r = await db.run(
        `UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.viventa_registrado', '$.viventa_registrado_por', '$.viventa_existente', '$.viventa_existente_por')
          WHERE id = ? AND (json_extract(COALESCE(metadata, '{}'), '$.viventa_registrado') IS NOT NULL OR json_extract(COALESCE(metadata, '{}'), '$.viventa_existente') IS NOT NULL)`,
        [id],
      );
    } else {
      const clave = accion === "registrado" ? "viventa_registrado" : "viventa_existente";
      r = await db.run(
        `UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.${clave}', ?, '$.${clave}_por', ?)
          WHERE id = ? AND json_extract(COALESCE(metadata, '{}'), '$.viventa_registrado') IS NULL AND json_extract(COALESCE(metadata, '{}'), '$.viventa_existente') IS NULL`,
        [iso, quien, id],
      );
    }
    if ((r.meta?.changes ?? 0) > 0) {
      cambiados++;
      await db.run("INSERT INTO crm_zoho_log (id, conversation_id, accion, usuario, at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), id, accion, quien, now]);
    }
  }
  return { cambiados };
}

// ─── Vista ───────────────────────────────────────────────────────────────────

export type PestanaZoho = "pendientes" | "incompletos" | "subidos" | "existian";
export function pestanaValida(v: string | undefined): PestanaZoho {
  return v === "incompletos" || v === "subidos" || v === "existian" ? v : "pendientes";
}

const ESTADO_DE: Record<PestanaZoho, EstadoZoho> = { pendientes: "pendiente", incompletos: "incompleto", subidos: "subido", existian: "existia" };

function inicioDia(ms: number): number {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const [y, m, d] = f.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const hh = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(new Date(guess)));
  return guess - hh * H;
}

export function resumenZoho(filas: FilaZoho[], now: number) {
  const por = (e: EstadoZoho) => filas.filter((f) => f.estado === e);
  const subidos = por("subido");
  const hoy0 = inicioDia(now);
  const ultimo = [...subidos].filter((f) => f.cuando).sort((a, b) => (b.cuando ?? 0) - (a.cuando ?? 0))[0];
  const completos = por("pendiente").length + subidos.length + por("existia").length;
  return {
    pendientes: por("pendiente").length,
    incompletos: por("incompleto").length,
    subidos: subidos.length,
    subidosHoy: subidos.filter((f) => (f.cuando ?? 0) >= hoy0).length,
    existian: por("existia").length,
    completos,
    hechos: subidos.length + por("existia").length,
    ultimo,
  };
}

const ESTILO_ZOHO = `<style>
  .zh-row{display:grid;grid-template-columns:34px 38px minmax(170px,1.3fr) 120px minmax(130px,1fr) minmax(170px,1.1fr) minmax(130px,1fr) 150px 190px;gap:10px;padding:11px 14px;font-size:12.5px;align-items:center;border-top:1px solid var(--line)}
  .zh-row:hover{background:var(--panel2)}
  .zh-head{border-top:0;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .zh-head:hover{background:transparent}
  .zh-btn{border:1px solid var(--line);background:none;color:var(--muted);padding:5px 10px;font-size:11.5px;cursor:pointer;display:inline-block}
  .zh-btn:hover{border-color:var(--accent);color:var(--cream)}
  .zh-ok{background:var(--accent);color:#fff !important;border-color:var(--accent);font-weight:700}
  @media (max-width:1100px){.zh-row{grid-template-columns:1fr 1fr}.zh-head{display:none}}
</style>`;

export async function renderCrmZoho(env: Env, pestana: PestanaZoho, opts: { mensaje?: string; orden?: string; nivel?: string } = {}, now = Date.now()): Promise<string> {
  const todas = await cargarZoho(env, now);
  const r = resumenZoho(todas, now);
  const db = new Db(env.DB);
  const formUrl = ((await new SettingsRepo(db).get(SETTING_FORM_URL)) ?? "").trim();
  const nivel = opts.nivel === "caliente" || opts.nivel === "tibio" || opts.nivel === "frio" ? opts.nivel : "";
  let filas = todas.filter((f) => f.estado === ESTADO_DE[pestana] && (!nivel || f.lead.prioridad.nivel === nivel));
  if (pestana === "pendientes") {
    filas = opts.orden === "prioridad"
      ? filas.sort((a, b) => NIVEL[a.lead.prioridad.nivel].orden - NIVEL[b.lead.prioridad.nivel].orden || b.lead.prioridad.puntos - a.lead.prioridad.puntos)
      : filas.sort((a, b) => a.listoDesde - b.listoDesde); // en orden de llegada: primero los más antiguos
  } else if (pestana === "subidos" || pestana === "existian") {
    filas = filas.sort((a, b) => (b.cuando ?? 0) - (a.cuando ?? 0));
  } else {
    filas = filas.sort((a, b) => b.lead.prioridad.puntos - a.lead.prioridad.puntos);
  }

  const pct = r.completos ? Math.round((r.hechos / r.completos) * 100) : 0;
  const progreso = `<div class="crm-card" style="padding:16px 20px;margin-bottom:14px;border-left:4px solid var(--accent)">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline">
        <div><b style="font-size:16px;color:var(--cream)">Llevas ${r.hechos} de ${r.completos} clientes completos</b>
          <span class="text-dim" style="font-size:12px"> · ${pct} %</span></div>
        <div class="text-dim" style="font-size:12px">${r.ultimo ? `Último subido: <b style="color:var(--cream)">${esc(r.ultimo.lead.nombre)}</b> · ${esc(fechaHora(r.ultimo.cuando!))}${r.ultimo.por ? ` · por ${esc(r.ultimo.por)}` : ""}` : "Todavía no has marcado ninguno desde el CRM"}</div>
      </div>
      <div style="background:var(--line);height:10px;margin-top:10px"><div style="width:${pct}%;height:100%;background:var(--accent);transition:width .5s ease"></div></div>
    </div>`;
  const kpi = (t: string, n: number, p: PestanaZoho, color?: string) =>
    `<a class="crm-kpi${pestana === p ? " on" : ""}" href="/crm/zoho?tab=${p}"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${t}</div><div style="font-weight:700;font-size:26px;${color ? `color:${color}` : ""}">${n}</div></a>`;
  const kpis = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px">
    ${kpi("⏳ Por subir", r.pendientes, "pendientes", "var(--accent)")}
    ${kpi("⚠️ Incompletos", r.incompletos, "incompletos", "var(--accent-2)")}
    ${kpi("✔ Subidos", r.subidos, "subidos", "var(--ok)")}
    ${kpi("Ya existían", r.existian, "existian", "var(--info)")}
    <div class="crm-kpi"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">Subidos hoy</div><div style="font-weight:700;font-size:26px">${r.subidosHoy}</div></div>
  </div>`;

  const fila = (f: FilaZoho, i: number) => {
    const l = f.lead;
    const m = l.ficha.metadata;
    const cid = encodeURIComponent(l.convId);
    const abrir = formUrl && f.estado === "pendiente" ? `<a class="zh-btn" href="${esc(urlFormulario(formUrl, l))}" target="_blank" rel="noopener">Abrir formulario</a>` : "";
    const unico = (accion: string, texto: string, clase = "") =>
      `<form method="POST" action="/crm/zoho/marcar" style="display:inline"><input type="hidden" name="ids" value="${esc(l.convId)}"><input type="hidden" name="accion" value="${accion}"><input type="hidden" name="tab" value="${pestana}"><button class="zh-btn ${clase}">${texto}</button></form>`;
    const acciones =
      f.estado === "pendiente" ? `${abrir} ${unico("registrado", "✔ Ya subido", "zh-ok")}`
      : f.estado === "incompleto" ? `<a class="zh-btn" href="/crm/c/${cid}">Ver ficha</a>`
      : unico("deshacer", "↩ Deshacer");
    return `<div class="zh-row">
      <span>${f.estado === "pendiente" ? `<input type="checkbox" name="ids" value="${esc(l.convId)}" form="zh-lote" class="zh-chk">` : ""}</span>
      <span class="text-dim">${i + 1}</span>
      <span><a href="/crm/c/${cid}" style="color:var(--cream);font-weight:600">${esc(l.nombre)}</a><br><span class="text-dim" style="font-size:11px">${esc(l.canal)}${l.llamada ? ` · 📞 ${esc(l.llamada)}` : ""}</span></span>
      <span>${badgeNivel(l.prioridad.nivel, l.prioridad.puntos)}</span>
      <span class="text-muted">${esc(l.telefono) || "—"}</span>
      <span class="text-muted" style="word-break:break-all">${esc(l.correo.split(",")[0]) || "—"}${f.correoInventado ? '<br><span style="color:var(--accent-2);font-size:11px">⚠ correo inventado</span>' : ""}</span>
      <span class="text-muted crm-clamp">${esc([m.ciudadCompra, m.ciudadResidencia].filter(Boolean).join(" · ")) || "—"}${f.faltan.length ? `<br><span style="color:var(--bad);font-size:11px">Falta: ${esc(f.faltan.join(", "))}</span>` : ""}</span>
      <span class="text-dim" style="font-size:11.5px">${f.estado === "subido" || f.estado === "existia" ? `${f.cuando ? esc(fechaHora(f.cuando)) : "—"}${f.por ? `<br>por ${esc(f.por)}` : ""}` : `lista ${esc(hace(f.listoDesde, now))}`}</span>
      <span>${acciones}</span>
    </div>`;
  };

  const barraLote = pestana === "pendientes"
    ? `<form id="zh-lote" method="POST" action="/crm/zoho/marcar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px" onsubmit="var n=document.querySelectorAll('.zh-chk:checked').length;if(!n){alert('Marca primero a los clientes que ya subiste.');return false}return confirm('¿Marcar '+n+' cliente(s) como ya subidos a Zoho?')">
        <input type="hidden" name="tab" value="${pestana}">
        <label style="font-size:12px;color:var(--muted);cursor:pointer"><input type="checkbox" onclick="document.querySelectorAll('.zh-chk').forEach(function(c){c.checked=this.checked}.bind(this))"> Seleccionar todos</label>
        <button class="zh-btn zh-ok" name="accion" value="registrado">✔ Marcar seleccionados como subidos</button>
        <button class="zh-btn" name="accion" value="existente">Ya existían en Zoho</button>
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
          <a class="zh-btn" href="/crm/zoho?tab=pendientes&orden=${opts.orden === "prioridad" ? "llegada" : "prioridad"}">${opts.orden === "prioridad" ? "Ordenar por llegada" : "Ordenar por prioridad"}</a>
          <a class="zh-btn" href="/crm/zoho.xlsx">⬇ Excel de pendientes</a>
        </span>
      </form>`
    : "";

  const ayuda: Record<PestanaZoho, string> = {
    pendientes: "Clientes con todos los datos del formulario que todavía no has subido. Van en orden de llegada: empieza por arriba. Abre el formulario (ya viene con los datos escritos), súbelo y marca «Ya subido».",
    incompletos: "Todavía les falta algún dato que el formulario exige (apellido, teléfono o ciudades). El bot se los pide solo; cuando los completen pasan a «Por subir».",
    subidos: "Los que ya marcaste como subidos. Si te equivocaste, usa «Deshacer» y vuelven a la cola.",
    existian: "Clientes que ya estaban en el sistema de Zoho (no hace falta subirlos).",
  };
  const tabla = filas.length
    ? `<div class="crm-card" style="overflow-x:auto"><div style="min-width:1050px">
        <div class="zh-row zh-head"><span></span><span>#</span><span>Cliente</span><span>Prioridad</span><span>Teléfono</span><span>Correo</span><span>Ciudades</span><span>${pestana === "subidos" || pestana === "existian" ? "Cuándo" : "Estado"}</span><span></span></div>
        ${filas.map(fila).join("")}</div></div>`
    : `<div class="crm-card" style="padding:40px;text-align:center;color:var(--dim)">${pestana === "pendientes" ? "🎉 No hay clientes por subir. ¡Estás al día!" : "No hay clientes en esta lista."}</div>`;

  const body = `${ESTILO_CRM}${ESTILO_ZOHO}
    ${opts.mensaje ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:12px;color:var(--ok);font-size:12.5px">${esc(opts.mensaje)}</div>` : ""}
    ${progreso}${kpis}
    <p class="text-dim" style="font-size:12px;margin:0 0 10px">${esc(ayuda[pestana])}</p>
    ${!formUrl && pestana === "pendientes" ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:10px;color:var(--accent-2);font-size:12.5px">Falta configurar el enlace del formulario de Zoho (ajuste «viventa_form_url»); sin él no aparece el botón «Abrir formulario».</div>` : ""}
    <form method="GET" action="/crm/zoho" style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <input type="hidden" name="tab" value="${pestana}">${opts.orden ? `<input type="hidden" name="orden" value="${esc(opts.orden)}">` : ""}
      <label style="font-size:12px;color:var(--muted)">Prioridad:</label>
      <select name="nivel" class="crm-in" onchange="this.form.submit()">${[["", "Toda"], ["caliente", "🔥 Calientes"], ["tibio", "🟡 Tibios"], ["frio", "⚪ Fríos"]].map(([v, t]) => `<option value="${v}"${nivel === v ? " selected" : ""}>${t}</option>`).join("")}</select>
      <span class="text-dim" style="font-size:11.5px">${filas.length} cliente(s)</span>
    </form>
    ${barraLote}${tabla}`;
  return crmLayout({ title: "Subir a Zoho", activa: "zoho", body, env });
}

// ─── Excel de pendientes ─────────────────────────────────────────────────────

export async function excelPendientesZoho(env: Env, now = Date.now()): Promise<Uint8Array> {
  const db = new Db(env.DB);
  const formUrl = ((await new SettingsRepo(db).get(SETTING_FORM_URL)) ?? "").trim() || undefined;
  const filas = (await cargarZoho(env, now)).filter((f) => f.estado === "pendiente").sort((a, b) => a.listoDesde - b.listoDesde);
  return excelListos(filas.map((f) => f.lead), formUrl);
}
