// member/crm-cotizaciones.local.ts — CRM de Viventa: «Cotizaciones». Las cotizaciones que Maricela arma en ViveHome (COT-2398…) y manda por WhatsApp,
// por cliente: cuándo, cuál, si el cliente respondió después y si ya agendó videollamada. Sirve para retomar a los que recibieron cotización y se enfriaron.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";
import { asegurarTablaCotizaciones } from "../src/followup/cotizaciones";

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
    <script>(function(){var q=document.getElementById('cot-q');if(!q)return;q.addEventListener('input',function(){var v=q.value.toLowerCase().trim();document.querySelectorAll('.cot-fila').forEach(function(r){r.style.display=(!v||r.dataset.q.indexOf(v)>=0)?'':'none'})})})();</script>`;
  return crmLayout({ title: "Cotizaciones", activa: "cotizaciones", body, env });
}
