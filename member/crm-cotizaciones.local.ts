// member/crm-cotizaciones.local.ts — CRM de Viventa: «Cotizaciones». Las cotizaciones que Maricela arma en ViveHome (COT-2398…) y manda por WhatsApp,
// por cliente: cuándo, cuál, si el cliente respondió después y si ya agendó videollamada. Sirve para retomar a los que recibieron cotización y se enfriaron.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";
import { asegurarTablaCotizaciones } from "../src/followup/cotizaciones";
import { filasDe, leerModo, type FilaCola, AJUSTE_PILOTO } from "../src/vivehome/cola";
import { SettingsRepo } from "../src/db/settings";

const DIA = 86_400_000;
export const URL_COTIZACION = "https://vivehome.viventa.co/quota-information?id=";

export interface FilaCotizacion {
  tel: string;
  conv: string;
  nombre: string;
  cotizaciones: Array<{ id: string; en: number }>;
  ultima: number;
  respondio: boolean;
  ultimoCliente: number | null;
  cita: boolean;
  etapa: string;
}

function fecha(ms: number): string {
  return new Date(ms).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Madrid" });
}

export async function cargarCotizaciones(env: Env, now = Date.now()): Promise<FilaCotizacion[]> {
  const db = new Db(env.DB);
  await asegurarTablaCotizaciones(db);
  const filas = await db.all<{ tel: string; cot_id: string; enviada_en: number }>("SELECT tel, cot_id, enviada_en FROM cotizaciones_enviadas ORDER BY enviada_en DESC");
  const porTel = new Map<string, FilaCotizacion>();
  for (const f of filas) {
    const r = porTel.get(f.tel) ?? { tel: f.tel, conv: "", nombre: "", cotizaciones: [], ultima: 0, respondio: false, ultimoCliente: null, cita: false, etapa: "" };
    if (!r.cotizaciones.some((c) => c.id === f.cot_id)) r.cotizaciones.push({ id: f.cot_id, en: f.enviada_en });
    r.ultima = Math.max(r.ultima, f.enviada_en);
    porTel.set(f.tel, r);
  }
  for (const r of porTel.values()) {
    const c = await db.first<{ id: string; display_name: string | null }>("SELECT id, display_name FROM conversations WHERE channel = 'ycloud' AND channel_user_id = ?", [r.tel]);
    if (!c) continue;
    r.conv = c.id;
    const lead = await db.first<{ name: string | null }>("SELECT name FROM leads WHERE conversation_id = ? AND name IS NOT NULL AND intent NOT LIKE 'Cita ·%' ORDER BY updated_at DESC LIMIT 1", [c.id]);
    r.nombre = lead?.name || c.display_name || "";
    const u = await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [c.id]);
    r.ultimoCliente = u?.t ?? null;
    r.respondio = !!u?.t && u.t > r.ultima;
    r.cita = ((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE conversation_id = ? AND intent LIKE 'Cita ·%'", [c.id]))?.n ?? 0) > 0;
  }
  return [...porTel.values()].sort((a, b) => b.ultima - a.ultima);
}

export const ESTADO_BOT: Record<FilaCola["estado"], { t: string; color: string }> = {
  propuesta: { t: "Preparada (esperando turno o aprobación)", color: "var(--info)" },
  pedida: { t: "El cliente pidió otra", color: "var(--info)" },
  creando: { t: "Creándose en ViveHome", color: "var(--info)" },
  creada: { t: "Creada, NO enviada", color: "var(--bad)" },
  enviada: { t: "Enviada", color: "var(--ok)" },
  pendiente_plantilla: { t: "Pendiente: fuera de la ventana de 24 h (plantilla)", color: "var(--accent)" },
  sin_proyectos: { t: "Sin proyectos en su ciudad (avisado)", color: "var(--dim)" },
  omitida: { t: "Omitida", color: "var(--dim)" },
  error: { t: "Falló 3 veces (ver Auditoría)", color: "var(--bad)" },
};

export const TIPO_BOT = { a_la_medida: "A la medida de su cuota", mas_economicas: "NO a la medida: las 2 más económicas" } as const;

/** Tabla de la cola de cotizaciones del bot (CRM → Cotizaciones). */
async function renderColaBot(env: Env, now: number): Promise<string> {
  const db = new Db(env.DB);
  const filas = await filasDe(env);
  const modo = await leerModo(db);
  const piloto = ((await new SettingsRepo(db).get(AJUSTE_PILOTO)) ?? "").split(/[\s,;]+/).filter(Boolean).length;
  const nombres = new Map<string, string>();
  for (const f of filas) {
    if (nombres.has(f.conv_id)) continue;
    const l = await db.first<{ name: string | null }>("SELECT name FROM leads WHERE conversation_id = ? AND name IS NOT NULL AND intent NOT LIKE 'Cita ·%' ORDER BY updated_at DESC LIMIT 1", [f.conv_id]);
    const c = await db.first<{ display_name: string | null }>("SELECT display_name FROM conversations WHERE id = ?", [f.conv_id]);
    nombres.set(f.conv_id, l?.name || c?.display_name || "(sin nombre)");
  }
  const pend = filas.filter((f) => f.estado === "pendiente_plantilla");
  const fila = (f: FilaCola) => {
    const e = ESTADO_BOT[f.estado] ?? { t: f.estado, color: "" };
    const items = (() => { try { return (JSON.parse(f.items ?? "[]") as Array<{ proyecto: string; ciudad: string }>).map((i) => `${i.proyecto} (${i.ciudad.replace(/ D\.C\.$/, "")})`).join(", "); } catch { return ""; } })();
    return `<tr class="cot-fila" data-q="${esc((nombres.get(f.conv_id) + " " + (f.cot_id ? "cot-" + f.cot_id : "")).toLowerCase())}" style="border-top:1px solid var(--line)">
      <td style="padding:9px 8px;font-size:12.5px"><a href="/crm/c/${esc(encodeURIComponent(f.conv_id))}" style="color:var(--cream);font-weight:700">${esc(nombres.get(f.conv_id) ?? "")}</a><br><span class="text-dim" style="font-size:11px">${esc(f.ciudad_texto ?? "")} · ${esc(f.capacidad_texto ?? "")}</span></td>
      <td style="padding:9px 8px;font-size:12px"><span style="color:${e.color}">${esc(e.t)}</span>${f.tipo ? `<br><span class="text-dim" style="font-size:11px">${esc(TIPO_BOT[f.tipo])}</span>` : ""}${f.error && f.estado !== "enviada" ? `<br><span class="text-dim" style="font-size:10.5px">${esc(f.error.slice(0, 140))}</span>` : ""}</td>
      <td style="padding:9px 8px;font-size:12px">${f.cot_id ? `<a href="${URL_COTIZACION}${esc(f.cot_id)}" target="_blank" style="color:var(--accent)">COT-${esc(f.cot_id)}</a><br>` : ""}<span class="text-dim" style="font-size:11px">${esc(items)}</span></td>
      <td style="padding:9px 8px;font-size:11px;white-space:nowrap" class="text-dim">${fecha(f.enviado_en ?? f.actualizado)}</td></tr>`;
  };
  const etiquetaModo = modo === "activo" ? "🟢 Activo" : modo === "piloto" ? `🟡 Piloto (${piloto} clientes)` : "⚪ Apagado";
  return `<div class="crm-sec" style="margin:22px 0 8px">🤖 Cotizaciones del bot · <span style="font-weight:400">${etiquetaModo}</span></div>
    <div class="text-dim" style="font-size:12px;margin-bottom:10px">El bot arma en ViveHome la cotización de quien ya dijo ciudad y cuota mensual (cuota inicial 20 %, sin reportar a la constructora) y le manda el enlace de 9 a 21 h de su hora. Interruptor: ajuste <code>viventa_cotizaciones_bot</code> (apagado / piloto / activo).${pend.length ? ` <b style="color:var(--accent)">${pend.length} pendiente(s) de plantilla</b>: el cliente lleva más de 24 h sin escribir y no se le puede mandar texto libre.` : ""}</div>
    <div class="crm-card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse">${filas.map(fila).join("") || `<tr><td style="padding:18px;color:var(--dim)">El bot todavía no ha preparado cotizaciones.</td></tr>`}</table></div>`;
}

export async function renderCotizaciones(env: Env, opts: { f?: string } = {}, now = Date.now()): Promise<string> {
  const todas = await cargarCotizaciones(env, now);
  const sinResp = todas.filter((x) => !x.respondio && !x.cita && now - x.ultima >= 3 * DIA);
  const filtro = opts.f === "sin_respuesta" ? sinResp : todas;
  const kpi = (t: string, n: number, color = "", href = "") => `<a ${href ? `href="${href}"` : ""} class="crm-card" style="padding:14px;text-decoration:none;display:block"><div class="text-dim" style="font-size:11px;text-transform:uppercase">${esc(t)}</div><div style="font-size:26px;font-weight:700;${color ? `color:${color}` : ""}">${n}</div></a>`;
  const cuerpo = filtro
    .map((x) => {
      const cots = x.cotizaciones
        .map((c) => `<a href="${URL_COTIZACION}${esc(c.id)}" target="_blank" style="color:var(--accent);font-size:12px">COT-${esc(c.id)}</a> <span class="text-dim" style="font-size:10.5px">${fecha(c.en)}</span>`)
        .join("<br>");
      const estado = x.cita
        ? `<span style="color:var(--ok)">📅 Videollamada agendada</span>`
        : x.respondio
          ? `<span style="color:var(--info)">💬 Respondió después</span>`
          : now - x.ultima >= 3 * DIA
            ? `<span style="color:var(--bad)">⏳ Sin respuesta · ${Math.round((now - x.ultima) / DIA)} d</span>`
            : `<span class="text-dim">Enviada hace ${Math.max(0, Math.round((now - x.ultima) / DIA))} d</span>`;
      const ventana = x.ultimoCliente && now - x.ultimoCliente < DIA ? "abierta" : "cerrada";
      return `<tr class="cot-fila" data-q="${esc((x.nombre + " " + x.tel + " " + x.cotizaciones.map((c) => "cot-" + c.id).join(" ")).toLowerCase())}" style="border-top:1px solid var(--line)">
        <td style="padding:9px 8px;font-size:12.5px"><b style="color:var(--cream)">${esc(x.nombre || "(sin nombre)")}</b><br><span class="text-dim" style="font-size:11px">+${esc(x.tel)}</span></td>
        <td style="padding:9px 8px">${cots}</td>
        <td style="padding:9px 8px;font-size:12px">${estado}<br><span class="text-dim" style="font-size:10.5px">Ventana de 24 h ${ventana}</span></td>
        <td style="padding:9px 8px;text-align:right;white-space:nowrap">${x.conv ? `<a href="/admin/conversations?c=${esc(encodeURIComponent(x.conv))}" target="_blank" style="color:var(--accent);font-size:12px">Abrir conversación</a>` : ""}</td></tr>`;
    })
    .join("");
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Las cotizaciones que se mandaron por WhatsApp (enlaces de ViveHome), por cliente. Se actualiza solo cada 15 minutos con lo que se envía desde la app de WhatsApp Business o desde el panel. «Sin respuesta» = pasaron 3 días o más desde la última cotización y el cliente no ha vuelto a escribir ni agendó.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px">
      ${kpi("Clientes con cotización", todas.length, "", "/crm/cotizaciones")}
      ${kpi("Cotizaciones enviadas", todas.reduce((n, x) => n + x.cotizaciones.length, 0))}
      ${kpi("Sin respuesta (3+ días)", sinResp.length, "var(--bad)", "/crm/cotizaciones?f=sin_respuesta")}
      ${kpi("Con videollamada", todas.filter((x) => x.cita).length, "var(--ok)")}</div>
    <div style="margin-bottom:10px"><input id="cot-q" class="crm-in" type="search" placeholder="Buscar por nombre, teléfono o COT-…" style="min-width:280px;padding:8px 10px;font-size:12.5px"> <span class="text-dim" style="font-size:11.5px">${opts.f === "sin_respuesta" ? "Mostrando solo los que no han respondido. " : ""}</span></div>
    <div class="crm-card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse">${cuerpo || `<tr><td style="padding:24px;color:var(--dim)">Todavía no hay cotizaciones registradas.</td></tr>`}</table></div>
    ${await renderColaBot(env, now)}
    <script>(function(){var q=document.getElementById('cot-q');if(!q)return;q.addEventListener('input',function(){var v=q.value.toLowerCase().trim();document.querySelectorAll('.cot-fila').forEach(function(r){r.style.display=(!v||r.dataset.q.indexOf(v)>=0)?'':'none'})})})();</script>`;
  return crmLayout({ title: "Cotizaciones", activa: "cotizaciones", body, env });
}
