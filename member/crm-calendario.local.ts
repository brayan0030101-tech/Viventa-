// member/crm-calendario.local.ts — CRM de Viventa, fase 2: calendario de videollamadas.
// Las llamadas son las que el bot agenda en Cal.com (quedan guardadas en D1 con su hora y el
// enlace de Meet). Al tocar una llamada se abre la ficha del cliente con su contexto.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { layout } from "../src/admin/views/layout";
import { armarLeads, faltantes, formatoLlamada, type LeadResumen } from "../src/followup/resumenDia";
import { zonaDeResidencia, horaEn, esEspana } from "../src/lib/zonaCliente";
import { buildXlsx } from "../src/lib/xlsx";
import {
  esc, NIVEL, badgeNivel, fechaHora, ESTILO_CRM, metaConv, subnav, mensajeHtml, etiquetaCampo,
} from "./crm.local";

const H = 3600_000;
const DIA = 24 * H;

// ─── Datos ───────────────────────────────────────────────────────────────────

export type EstadoLlamada = "agendada" | "pasada" | "cancelada";

export interface LlamadaCrm {
  id: string;
  convId: string;
  /** Cuándo se reservó (para medir cuántas llamadas agendó el bot en un periodo). */
  creada: number;
  inicio: number;
  estado: EstadoLlamada;
  enlace: string;
  nombre: string;
  nivel: "caliente" | "tibio" | "frio" | null;
  canal: string;
  zonaEtiqueta: string;
  zonaTz: string;
}

const ymd = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const hm = (ms: number): string =>
  new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));

/** Todas las videollamadas de los últimos 150 días (y las futuras), con el nombre y la prioridad del cliente. */
export async function cargarLlamadas(env: Env, now = Date.now()): Promise<LlamadaCrm[]> {
  const db = new Db(env.DB);
  const rows = await db.all<{ id: string; conversation_id: string | null; name: string | null; metadata: string | null; created_at: number }>(
    "SELECT id, conversation_id, name, metadata, created_at FROM leads WHERE intent LIKE 'Cita · Videollamada%' AND created_at > ? ORDER BY created_at ASC",
    [now - 150 * DIA],
  );
  const ids = [...new Set(rows.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  const convs = new Map<string, { display_name: string | null; channel: string }>();
  for (let i = 0; i < ids.length; i += 80) {
    const trozo = ids.slice(i, i + 80);
    const cs = await db.all<{ id: string; display_name: string | null; channel: string }>(
      `SELECT id, display_name, channel FROM conversations WHERE id IN (${trozo.map(() => "?").join(",")})`,
      trozo,
    );
    for (const c of cs) convs.set(c.id, c);
  }
  // Nombre completo y prioridad desde la ficha del cliente (la misma que usa la lista).
  const { cargarCrm } = await import("./crm.local");
  const crm = new Map((await cargarCrm(env, now)).map((f) => [f.lead.convId, f.lead]));

  const out: LlamadaCrm[] = [];
  for (const r of rows) {
    if (!r.conversation_id || !r.metadata) continue;
    let m: Record<string, string> = {};
    try {
      m = JSON.parse(r.metadata);
    } catch {
      continue;
    }
    const inicio = m.calStart ? Date.parse(m.calStart) : NaN;
    if (!Number.isFinite(inicio)) continue;
    const lead = crm.get(r.conversation_id);
    const conv = convs.get(r.conversation_id);
    const cancelada = /cancel/i.test(m.estado ?? "");
    out.push({
      id: r.id,
      convId: r.conversation_id,
      creada: r.created_at,
      inicio,
      estado: cancelada ? "cancelada" : inicio < now ? "pasada" : "agendada",
      enlace: m.calMeetingUrl ?? "",
      nombre: lead?.nombre ?? r.name ?? conv?.display_name ?? "(sin nombre)",
      nivel: lead?.prioridad.nivel ?? null,
      canal: lead?.canal ?? (conv?.channel === "zernio" ? "Instagram" : "WhatsApp"),
      zonaEtiqueta: m.zonaEtiqueta ?? "",
      zonaTz: m.zonaCliente ?? "",
    });
  }
  return out.sort((a, b) => a.inicio - b.inicio);
}

// ─── Vista de calendario ─────────────────────────────────────────────────────

const NOMBRES_DIA = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const ESTILO_CAL = `<style>
  @keyframes cal-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  @keyframes chip-pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
  @keyframes hoy-pulso{0%,100%{box-shadow:0 0 0 0 rgba(230,13,111,.55)}50%{box-shadow:0 0 0 5px rgba(230,13,111,0)}}
  @keyframes proxima-brillo{0%,100%{border-color:var(--accent)}50%{border-color:var(--accent-2)}}
  .cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
  .cal-dow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);text-align:center;padding:4px 0}
  .cal-dia{min-height:112px;padding:6px 6px 8px;border:1px solid var(--line);background:var(--panel);animation:cal-in .35s cubic-bezier(.16,1,.3,1) both;transition:border-color .12s ease,transform .12s ease}
  .cal-dia:hover{border-color:var(--linelit);transform:translateY(-1px)}
  .cal-dia.fuera{opacity:.38}
  .cal-dia.hoy{border-color:var(--accent);animation:cal-in .35s cubic-bezier(.16,1,.3,1) both,hoy-pulso 2.4s ease-in-out infinite}
  .cal-num{font-size:12px;font-weight:700;color:var(--muted);margin-bottom:5px;display:flex;justify-content:space-between}
  .cal-dia.hoy .cal-num{color:var(--accent)}
  .cal-chip{display:block;width:100%;text-align:left;margin-bottom:4px;padding:3px 6px;font-size:11px;line-height:1.3;border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--raise);color:var(--cream);cursor:pointer;animation:chip-pop .3s ease both;transition:transform .12s ease,background .12s ease;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:inherit}
  .cal-chip:hover{transform:translateX(2px);background:var(--accent-soft)}
  .cal-chip.pasada{opacity:.55;border-left-color:var(--dim)}
  .cal-chip.cancelada{opacity:.45;text-decoration:line-through;border-left-color:var(--bad)}
  .cal-proxima{border:1px solid var(--accent);animation:proxima-brillo 2.6s ease-in-out infinite}
  .cal-agenda-item{display:flex;gap:12px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--line);cursor:pointer;background:none;border-left:0;border-right:0;border-top:0;color:inherit;width:100%;text-align:left;font-family:inherit}
  .cal-agenda-item:hover{background:var(--panel2)}
  .cal-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;align-items:start}
  @media (max-width:1100px){.cal-layout{grid-template-columns:1fr}.cal-dia{min-height:84px}}
</style>`;

function enTiempo(ms: number, now: number): string {
  const min = Math.max(0, Math.round((ms - now) / 60_000));
  if (min < 60) return `en ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `en ${h} h` : `en ${Math.round(h / 24)} días`;
}

function colorNivel(n: LlamadaCrm["nivel"]): string {
  return n ? NIVEL[n].color : "var(--accent)";
}

/** «Ana López Ruiz» → «Ana L.» (cabe en la casilla del calendario). */
function nombreCorto(n: string): string {
  const [a, b] = n.trim().split(/\s+/);
  return b ? `${a} ${b.charAt(0)}.` : a ?? n;
}

function chip(l: LlamadaCrm, i: number): string {
  return `<button class="cal-chip ${l.estado}" style="border-left-color:${l.estado === "agendada" ? colorNivel(l.nivel) : ""};animation-delay:${60 + i * 40}ms"
    hx-get="/admin/crm/llamada/${encodeURIComponent(l.id)}" hx-target="#modal-root" hx-swap="innerHTML" title="${esc(l.nombre)} · ${hm(l.inicio)}">
    <b>${hm(l.inicio)}</b> ${esc(nombreCorto(l.nombre))}</button>`;
}

function mesValido(v: string | undefined, now: number): { y: number; m: number } {
  const hoy = ymd(now).split("-").map(Number);
  const mm = /^(\d{4})-(\d{2})$/.exec(v ?? "");
  if (mm && Number(mm[2]) >= 1 && Number(mm[2]) <= 12) return { y: Number(mm[1]), m: Number(mm[2]) };
  return { y: hoy[0], m: hoy[1] };
}

export async function renderCrmCalendario(env: Env, mes: string | undefined, now = Date.now()): Promise<string> {
  const llamadas = await cargarLlamadas(env, now);
  const { y, m } = mesValido(mes, now);
  const primero = new Date(Date.UTC(y, m - 1, 1));
  const diasMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const desfase = (primero.getUTCDay() + 6) % 7; // lunes = 0
  const hoy = ymd(now);

  const porDia = new Map<string, LlamadaCrm[]>();
  for (const l of llamadas) {
    const k = ymd(l.inicio);
    porDia.set(k, [...(porDia.get(k) ?? []), l]);
  }

  const celdas: string[] = [];
  const total = Math.ceil((desfase + diasMes) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(y, m - 1, 1 - desfase + i));
    const clave = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const dentro = d.getUTCMonth() === m - 1;
    const ll = porDia.get(clave) ?? [];
    const visibles = ll.slice(0, 4);
    const extra = ll.length - visibles.length;
    celdas.push(`<div class="cal-dia${dentro ? "" : " fuera"}${clave === hoy ? " hoy" : ""}" style="animation-delay:${Math.min(i, 20) * 12}ms">
      <div class="cal-num"><span>${d.getUTCDate()}</span>${ll.length ? `<span style="font-size:10px;color:var(--accent)">${ll.length} 📞</span>` : ""}</div>
      ${visibles.map((l, j) => chip(l, j)).join("")}
      ${extra > 0 ? `<div class="text-dim" style="font-size:10.5px">+${extra} más</div>` : ""}
    </div>`);
  }

  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const sig = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const navMes = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
    <a class="ghostbtn" href="/admin/crm/calendario?mes=${prev}" style="border:1px solid var(--line);padding:6px 12px;color:var(--muted)">←</a>
    <h2 style="font-family:'Space Grotesk';font-weight:700;font-size:20px;margin:0;min-width:190px;text-align:center;text-transform:capitalize">${MESES[m - 1]} ${y}</h2>
    <a class="ghostbtn" href="/admin/crm/calendario?mes=${sig}" style="border:1px solid var(--line);padding:6px 12px;color:var(--muted)">→</a>
    <a class="ghostbtn" href="/admin/crm/calendario" style="border:1px solid var(--line);padding:6px 12px;color:var(--muted);margin-left:6px">Hoy</a>
    <span class="text-dim" style="margin-left:auto;font-size:11px">Horas en hora de España</span>
  </div>`;

  const proximas = llamadas.filter((l) => l.estado === "agendada").slice(0, 8);
  const siguiente = proximas[0];
  const cuando = (ms: number) => {
    const d = ymd(ms);
    if (d === hoy) return "Hoy";
    if (d === ymd(now + DIA)) return "Mañana";
    return new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
  };
  const agenda = proximas.length
    ? proximas
        .map(
          (l) => `<button class="cal-agenda-item" hx-get="/admin/crm/llamada/${encodeURIComponent(l.id)}" hx-target="#modal-root" hx-swap="innerHTML">
            <span style="width:4px;align-self:stretch;background:${colorNivel(l.nivel)}"></span>
            <span style="flex:1"><span style="display:block;color:var(--cream);font-weight:600;font-size:12.5px">${esc(l.nombre)}</span>
            <span class="text-dim" style="font-size:11px">${esc(cuando(l.inicio))} · ${hm(l.inicio)} · ${esc(l.canal)}</span></span></button>`,
        )
        .join("")
    : `<div class="text-dim" style="font-size:12px;padding:8px 0">No hay llamadas próximas.</div>`;

  const bannerSiguiente = siguiente
    ? `<div class="cal-proxima" style="padding:14px 16px;margin-bottom:14px;background:var(--accent-soft)">
        <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)">Próxima llamada</div>
        <div style="font-weight:700;font-size:15px;margin-top:3px">${esc(siguiente.nombre)}</div>
        <div style="font-size:12px;color:var(--muted)">${esc(cuando(siguiente.inicio))} a las ${hm(siguiente.inicio)} (España) · ${esc(enTiempo(siguiente.inicio, now))}</div>
        <button class="bigbtn" hx-get="/admin/crm/llamada/${encodeURIComponent(siguiente.id)}" hx-target="#modal-root" hx-swap="innerHTML" style="margin-top:10px;background:var(--accent);color:var(--bg);padding:7px 14px;font-size:12px;font-weight:700;border:0;cursor:pointer">Ver contexto del cliente</button>
      </div>`
    : "";

  const leyenda = `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:var(--dim)">
    <span><span style="display:inline-block;width:10px;height:10px;background:${NIVEL.caliente.color};margin-right:5px"></span>Caliente</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:${NIVEL.tibio.color};margin-right:5px"></span>Tibio</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:${NIVEL.frio.color};margin-right:5px"></span>Frío</span>
    <span style="opacity:.6">Gris: ya pasó</span><span style="text-decoration:line-through">Tachada: cancelada</span></div>`;

  const body = `${ESTILO_CRM}${ESTILO_CAL}
    ${subnav("calendario")}
    <div class="cal-layout">
      <div>
        ${navMes}
        <div class="cal-grid">${NOMBRES_DIA.map((d) => `<div class="cal-dow">${d}</div>`).join("")}${celdas.join("")}</div>
        ${leyenda}
        <p class="text-dim" style="font-size:11px;margin-top:10px">Aquí aparecen las videollamadas que agenda el bot (se guardan en Cal.com, en el calendario de Maricela, y en el CRM). Toca una para ver el contexto del cliente.</p>
      </div>
      <div>
        ${bannerSiguiente}
        <div class="crm-card" style="padding:14px 16px"><div class="crm-sec">Próximas llamadas</div>${agenda}</div>
      </div>
    </div>`;
  return layout({ title: "CRM · Calendario", activeTab: "crm", body, env });
}

// ─── Ficha de la llamada (ventana emergente) ─────────────────────────────────

/** Resumen de contexto para entrar a la llamada, armado con la ficha (sin gastar IA). */
export function resumenContexto(l: LeadResumen): string[] {
  const m = l.ficha.metadata;
  const out: string[] = [];
  out.push(`${l.nombre} escribió por ${l.canal}${l.telefono ? ` (${l.telefono})` : ""}.`);
  if (m.ciudadResidencia || m.ciudadCompra) {
    out.push(`${m.ciudadResidencia ? `Vive en ${m.ciudadResidencia}` : "Ciudad de residencia sin dato"}${m.ciudadCompra ? `; quiere comprar en ${m.ciudadCompra}` : ""}${m.motivoCompra ? ` (${m.motivoCompra})` : ""}.`);
  }
  const fin = [
    m.ahorroDisponible && `ahorro ${m.ahorroDisponible}`,
    m.capacidadMensual && `cuota ${m.capacidadMensual}`,
    m.ingresosMensuales && `ingresos ${m.ingresosMensuales}`,
    m.tipoEmpleo && `empleo: ${m.tipoEmpleo}`,
    m.antiguedadLaboral && `antigüedad ${m.antiguedadLaboral}`,
  ].filter(Boolean);
  if (fin.length) out.push(`Perfil financiero: ${fin.join(" · ")}.`);
  if (m.entregaInmediataOFutura) out.push(`Entrega: ${m.entregaInmediataOFutura}.`);
  const mig = m.situacionMigratoria ?? m.estatusMigratorio;
  if (mig) out.push(`Situación de residencia: ${mig}.`);
  if (m.compraSoloOAcompanado) out.push(`Compra: ${m.compraSoloOAcompanado}.`);
  out.push(`Prioridad: ${NIVEL[l.prioridad.nivel].nombre} (${l.prioridad.puntos} puntos).`);
  if (l.horaLlamada) out.push(`Pidió: ${l.horaLlamada}.`);
  const f = faltantes(l);
  if (f.length) out.push(`Para el registro todavía falta: ${f.join(", ")}.`);
  return out;
}

export async function renderLlamadaDetalle(env: Env, leadId: string, now = Date.now()): Promise<string | null> {
  const llamadas = await cargarLlamadas(env, now);
  const ll = llamadas.find((x) => x.id === leadId);
  if (!ll) return null;
  const db = new Db(env.DB);
  const conv = await db.first<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number; metadata: string | null }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at, metadata FROM conversations WHERE id = ?",
    [ll.convId],
  );
  const leadsRows = conv
    ? await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
        "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
        [ll.convId],
      )
    : [];
  const [lead] = conv ? armarLeads([{ ...conv, open_ticket_id: null } as never], leadsRows) : [];
  const msgs = await db.all<{ role: string; content: string; created_at: number }>(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 8",
    [ll.convId],
  );
  msgs.reverse();
  const zona = lead ? zonaDeResidencia(lead.ficha.metadata.ciudadResidencia) : null;
  const local = ll.zonaTz ? horaEn(new Date(ll.inicio).toISOString(), ll.zonaTz) : zona && !esEspana(zona) ? horaEn(new Date(ll.inicio).toISOString(), zona.tz) : "";
  const etq = ll.zonaEtiqueta || (zona && !esEspana(zona) ? zona.etiqueta : "");
  const estadoTxt = ll.estado === "agendada" ? "Agendada" : ll.estado === "pasada" ? "Ya pasó" : "Cancelada";

  const resumen = lead
    ? `<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--cream)">${resumenContexto(lead).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : `<div class="text-dim" style="font-size:12.5px">Este cliente todavía no dejó datos en su ficha.</div>`;
  const meta = lead?.ficha.metadata ?? {};
  const datos = Object.keys(meta)
    .filter((k) => meta[k] && !/^(cita|cal)/i.test(k))
    .map((k) => `<div class="crm-dato"><span>${esc(etiquetaCampo(k))}</span><span>${esc(meta[k])}</span></div>`)
    .join("");
  const ultimos = msgs
    .map((x) => {
      const quien = x.role === "user" ? "Cliente" : x.role === "owner" ? "Equipo" : "Bot";
      const col = x.role === "user" ? "var(--cream)" : x.role === "owner" ? "var(--info)" : "var(--accent)";
      return `<div style="padding:5px 0;font-size:12px;border-bottom:1px dashed var(--line)"><span style="color:${col};font-weight:700">${quien}</span> <span class="text-dim" style="font-size:10.5px">${esc(fechaHora(x.created_at))}</span><div style="color:var(--muted);white-space:pre-wrap">${mensajeHtml(x.content).slice(0, 360)}</div></div>`;
    })
    .join("");

  const cid = encodeURIComponent(ll.convId);
  return `<div class="modal-backdrop" onclick="if(event.target===this)this.remove()">
    <div class="modal-card" style="width:min(720px,94vw);max-height:90vh;overflow-y:auto;padding:22px 24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)">Videollamada · ${esc(estadoTxt)}</div>
          <h3 style="font-family:'Space Grotesk';font-weight:700;font-size:21px;margin:3px 0 6px">${esc(ll.nombre)}</h3>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${ll.nivel ? badgeNivel(ll.nivel, lead?.prioridad.puntos) : ""}<span style="font-size:12.5px;color:var(--cream)">📅 ${esc(formatoLlamada(ll.inicio))} (hora de España)</span>${local ? `<span style="font-size:12px;color:var(--muted)">· ${esc(local)} en ${esc(etq)}</span>` : ""}</div>
        </div>
        <button onclick="this.closest('.modal-backdrop').remove()" style="background:none;border:1px solid var(--line);color:var(--muted);padding:4px 10px;cursor:pointer;font-family:inherit">✕</button>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:16px 0">
        ${ll.enlace && ll.estado === "agendada" ? `<a class="bigbtn" href="${esc(ll.enlace)}" target="_blank" rel="noopener" style="background:var(--accent);color:var(--bg);padding:9px 16px;font-size:12.5px;font-weight:700">▶ Entrar a Google Meet</a>` : ""}
        <a class="ghostbtn" href="/admin/crm/c/${cid}" style="border:1px solid var(--line);padding:9px 14px;font-size:12.5px;color:var(--muted)">Ver ficha completa</a>
        <a class="ghostbtn" href="/admin/crm/c/${cid}/ficha.xlsx" style="border:1px solid var(--line);padding:9px 14px;font-size:12.5px;color:var(--muted)">⬇ Ficha + conversación (Excel)</a>
        <a class="ghostbtn" href="/admin/conversations?c=${cid}" style="border:1px solid var(--line);padding:9px 14px;font-size:12.5px;color:var(--muted)">💬 Conversación</a>
      </div>
      <div class="crm-sec">Resumen para la llamada</div>
      <div style="margin-bottom:16px">${resumen}</div>
      ${datos ? `<div class="crm-sec">Datos de la ficha</div><div style="margin-bottom:16px">${datos}</div>` : ""}
      <div class="crm-sec">Últimos mensajes</div>
      <div>${ultimos || `<div class="text-dim" style="font-size:12px">Sin mensajes.</div>`}</div>
    </div>
  </div>`;
}

// ─── Excel de la ficha de un cliente (datos + conversación completa) ─────────

export async function excelFicha(env: Env, convId: string, now = Date.now()): Promise<Uint8Array | null> {
  const db = new Db(env.DB);
  const conv = await db.first<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number; metadata: string | null }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at, metadata FROM conversations WHERE id = ?",
    [convId],
  );
  if (!conv) return null;
  const leadsRows = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
    "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
    [convId],
  );
  const [lead] = armarLeads([{ ...conv, open_ticket_id: null } as never], leadsRows);
  const llamadas = (await cargarLlamadas(env, now)).filter((x) => x.convId === convId);
  const m = lead?.ficha.metadata ?? {};
  const cm = metaConv({ ...conv, open_ticket_id: null } as never);
  const filas: Array<[string, string]> = [
    ["Nombre", lead?.nombre ?? conv.display_name ?? ""],
    ["Canal", lead?.canal ?? conv.channel],
    ["Perfil de Instagram", conv.channel === "zernio" ? conv.display_name ?? "" : ""],
    ["Teléfono", lead?.telefono ?? ""],
    ["Correo", lead?.correo ?? ""],
    ["Prioridad", lead ? `${NIVEL[lead.prioridad.nivel].nombre} (${lead.prioridad.puntos} puntos)` : ""],
    ...(lead?.prioridad.razones ?? []).map((r) => ["  · motivo", r] as [string, string]),
    ...Object.keys(m).filter((k) => m[k] && !/^(cita|cal)/i.test(k)).map((k) => [etiquetaCampo(k), m[k]] as [string, string]),
    ["Notas del bot", lead?.ficha.notas ?? ""],
    ["Videollamadas", llamadas.map((x) => `${formatoLlamada(x.inicio)} (${x.estado})${x.enlace ? ` ${x.enlace}` : ""}`).join("\n")],
    ["Zoho", cm.viventa_registrado ? "Registrado" : cm.viventa_existente ? "Ya existía" : "Sin registrar"],
    ["Nota interna", cm.crm_nota ?? ""],
  ];
  const msgs = await db.all<{ role: string; content: string; created_at: number }>(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 2000",
    [convId],
  );
  const quien = (r: string) => (r === "user" ? "Cliente" : r === "owner" ? "Equipo (persona)" : r === "assistant" ? "Bot" : r);
  const limpio = (t: string) => t.replace(/\[\[\s*botones?\s*:\s*([^\]]*)\]\]/gi, "(botones: $1)").replace(/\[\[[^\]]*\]\]/g, "").trim();
  return buildXlsx([
    { name: "Ficha", rows: [["Campo", "Dato"], ...filas], widths: [26, 80] },
    { name: "Conversación", rows: [["Fecha", "Quién", "Mensaje"], ...msgs.map((x) => [fechaHora(x.created_at), quien(x.role), limpio(x.content)])], widths: [16, 18, 110] },
  ]);
}
