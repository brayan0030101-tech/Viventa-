// member/crm.local.ts — CRM de Viventa para Maricela (fase 1: leads, ficha y conversaciones).
// Vive en member/ para que `forjabot update` no lo pise. Se monta dentro del panel del
// bot (/admin/crm), con su mismo acceso por usuario y contraseña y su misma base de datos.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { layout } from "../src/admin/views/layout";
import {
  armarLeads, llamadasAgendadas, urlFormulario, faltantes, correoParaFormulario, formatoLlamada,
  SETTING_FORM_URL, type LeadResumen,
} from "../src/followup/resumenDia";
import { zonaDeResidencia, horaEn, esEspana } from "../src/lib/zonaCliente";
import { buildXlsx } from "../src/lib/xlsx";

const H = 3600_000;
const DIAS_VISIBLES = 90;
const MAX_CONVERSACIONES = 800;

export const esc = (v: string | null | undefined): string =>
  (v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ─── Datos ───────────────────────────────────────────────────────────────────

export interface FilaCrm {
  lead: LeadResumen;
  canalUsuario: string;
  perfil: string;
  ultimo: number;
  ticketAbierto: boolean;
  registro: "registrado" | "existente" | "";
  nota: string;
}

interface ConvRow {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  last_message_at: number;
  open_ticket_id: string | null;
  metadata: string | null;
}

export function metaConv(c: ConvRow): Record<string, string> {
  try {
    return c.metadata ? (JSON.parse(c.metadata) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Todos los leads (conversaciones con ficha) de los últimos 90 días, con su prioridad. */
export async function cargarCrm(env: Env, now = Date.now()): Promise<FilaCrm[]> {
  const db = new Db(env.DB);
  const convs = await db.all<ConvRow>(
    `SELECT id, channel, channel_user_id, display_name, last_message_at, open_ticket_id, metadata
       FROM conversations
      WHERE last_message_at > ? AND channel IN ('ycloud', 'zernio')
      ORDER BY last_message_at DESC LIMIT ${MAX_CONVERSACIONES}`,
    [now - DIAS_VISIBLES * 24 * H],
  );
  if (convs.length === 0) return [];
  const ids = new Set(convs.map((c) => c.id));
  const leads = (
    await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
      "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE updated_at > ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
      [now - DIAS_VISIBLES * 24 * H],
    )
  ).filter((l) => l.conversation_id && ids.has(l.conversation_id));
  const resumenes = armarLeads(convs, leads, await llamadasAgendadas(db, now));
  const porId = new Map(convs.map((c) => [c.id, c]));
  return resumenes.map((lead) => {
    const c = porId.get(lead.convId)!;
    const m = metaConv(c);
    return {
      lead,
      canalUsuario: c.channel_user_id,
      perfil: c.channel === "zernio" ? c.display_name ?? "" : "",
      ultimo: c.last_message_at,
      ticketAbierto: !!c.open_ticket_id,
      registro: m.viventa_registrado ? "registrado" : m.viventa_existente ? "existente" : "",
      nota: m.crm_nota ?? "",
    };
  });
}

// ─── Utilidades de presentación ──────────────────────────────────────────────

export const NIVEL = {
  caliente: { icono: "🔥", nombre: "Caliente", color: "#E60D6F", orden: 0 },
  tibio: { icono: "🟡", nombre: "Tibio", color: "#F5A623", orden: 1 },
  frio: { icono: "⚪", nombre: "Frío", color: "#8FA3D9", orden: 2 },
} as const;

export function badgeNivel(n: LeadResumen["prioridad"]["nivel"], puntos?: number): string {
  const v = NIVEL[n];
  return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid ${v.color};color:${v.color};font-size:11px;font-weight:600;letter-spacing:.04em;white-space:nowrap">${v.icono} ${v.nombre}${puntos != null ? ` · ${puntos}` : ""}</span>`;
}

export function hace(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

export function fechaHora(ms: number): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

const ETIQUETAS: Record<string, string> = {
  ciudadResidencia: "Dónde vive",
  ciudadCompra: "Ciudad de interés",
  motivoCompra: "Para quién / motivo",
  entregaInmediataOFutura: "Entrega",
  ahorroDisponible: "Ahorro disponible",
  capacidadMensual: "Cuota mensual",
  ingresosMensuales: "Ingresos mensuales",
  tipoEmpleo: "Tipo de empleo",
  antiguedadLaboral: "Antigüedad laboral",
  compraSoloOAcompanado: "Compra solo / acompañado",
  situacionMigratoria: "Situación de residencia",
  estatusMigratorio: "Situación de residencia",
  autorizacion: "Autorización de datos",
};

export function etiquetaCampo(k: string): string {
  return etiqueta(k);
}

function etiqueta(k: string): string {
  if (ETIQUETAS[k]) return ETIQUETAS[k];
  return k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Pestañas del CRM: Leads | Calendario. */
export function subnav(activo: "leads" | "calendario" | "informes" | "recomendaciones"): string {
  const tab = (id: string, href: string, texto: string) =>
    `<a href="${href}" style="padding:9px 16px;font-size:12.5px;font-weight:600;letter-spacing:.04em;border-bottom:2px solid ${activo === id ? "var(--accent)" : "transparent"};color:${activo === id ? "var(--cream)" : "var(--muted)"}">${texto}</a>`;
  return `<div style="display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--line)">${tab("leads", "/admin/crm", "👥 Leads")}${tab("calendario", "/admin/crm/calendario", "📅 Calendario de llamadas")}${tab("informes", "/admin/crm/informes", "📊 Informes")}${tab("recomendaciones", "/admin/crm/recomendaciones", "🧠 Recomendaciones")}</div>`;
}

// ─── Lista de leads ──────────────────────────────────────────────────────────

export interface FiltrosCrm {
  nivel?: string;
  canal?: string;
  estado?: string;
  q?: string;
}

const sinTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function filtrarCrm(filas: FilaCrm[], f: FiltrosCrm): FilaCrm[] {
  const q = sinTildes((f.q ?? "").trim());
  return filas.filter((r) => {
    if (f.nivel && f.nivel in NIVEL && r.lead.prioridad.nivel !== f.nivel) return false;
    if (f.canal === "whatsapp" && r.lead.canal !== "WhatsApp") return false;
    if (f.canal === "instagram" && r.lead.canal !== "Instagram") return false;
    if (f.estado === "con_llamada" && !r.lead.llamada) return false;
    if (f.estado === "sin_llamada" && r.lead.llamada) return false;
    if (f.estado === "registrado" && !r.registro) return false;
    if (f.estado === "sin_registrar" && r.registro) return false;
    if (q) {
      const hay = sinTildes([r.lead.nombre, r.lead.telefono, r.lead.correo, r.perfil, r.lead.ficha.metadata.ciudadCompra, r.lead.ficha.metadata.ciudadResidencia].join(" "));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function ordenarCrm(filas: FilaCrm[]): FilaCrm[] {
  return [...filas].sort(
    (a, b) =>
      NIVEL[a.lead.prioridad.nivel].orden - NIVEL[b.lead.prioridad.nivel].orden ||
      b.lead.prioridad.puntos - a.lead.prioridad.puntos ||
      b.ultimo - a.ultimo,
  );
}

export const ESTILO_CRM = `<style>
  main ul,#modal-root ul{list-style:disc}
  .crm-card{background:var(--panel);border:1px solid var(--line)}
  .crm-kpi{display:block;padding:14px 16px;border:1px solid var(--line);background:var(--panel);transition:all .12s ease;color:inherit}
  .crm-kpi:hover{border-color:var(--accent);transform:translateY(-1px)}
  .crm-kpi.on{border-color:var(--accent);background:var(--accent-soft)}
  .crm-row{display:grid;grid-template-columns:130px minmax(170px,1.3fr) minmax(150px,1fr) minmax(150px,1fr) 110px 130px 110px;gap:12px;padding:12px 16px;font-size:12.5px;align-items:center;border-top:1px solid var(--line);color:inherit}
  .crm-row:hover{background:var(--panel2)}
  .crm-head{border-top:0;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .crm-head:hover{background:transparent}
  .crm-in{background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:8px 10px;font-size:12.5px;outline:none}
  .crm-in:focus{border-color:var(--accent)}
  .crm-sec{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 0 8px}
  .crm-dato{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--line);font-size:12.5px}
  .crm-dato span:first-child{color:var(--dim);flex:none}
  .crm-dato span:last-child{color:var(--cream);text-align:right;word-break:break-word}
  .crm-grid{display:grid;grid-template-columns:minmax(300px,390px) minmax(0,1fr);gap:18px;align-items:start}
  .burbuja{max-width:78%;padding:9px 12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  @media (max-width:1100px){.crm-grid{grid-template-columns:1fr}.crm-row{grid-template-columns:1fr 1fr}.crm-head{display:none}}
</style>`;

function kpiLink(href: string, titulo: string, n: number, activo: boolean, color?: string): string {
  return `<a class="crm-kpi${activo ? " on" : ""}" href="${href}">
    <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${titulo}</div>
    <div style="font-family:'Space Grotesk';font-weight:700;font-size:26px;${color ? `color:${color}` : ""}">${n}</div>
  </a>`;
}

function qs(f: FiltrosCrm, cambio: Partial<FiltrosCrm>): string {
  const x = { ...f, ...cambio };
  const p = Object.entries(x).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return `/admin/crm${p.length ? `?${p.join("&")}` : ""}`;
}

export async function renderCrmLista(env: Env, f: FiltrosCrm = {}, now = Date.now()): Promise<string> {
  const todas = await cargarCrm(env, now);
  const filtradas = ordenarCrm(filtrarCrm(todas, f));
  const cuenta = (n: string) => todas.filter((r) => r.lead.prioridad.nivel === n).length;
  const conLlamada = todas.filter((r) => r.lead.llamada).length;

  const kpis = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
    ${kpiLink(qs({ ...f, nivel: "", estado: "" }, {}), "Todos los leads", todas.length, !f.nivel && !f.estado)}
    ${kpiLink(qs(f, { nivel: "caliente", estado: "" }), "🔥 Calientes", cuenta("caliente"), f.nivel === "caliente", NIVEL.caliente.color)}
    ${kpiLink(qs(f, { nivel: "tibio", estado: "" }), "🟡 Tibios", cuenta("tibio"), f.nivel === "tibio", NIVEL.tibio.color)}
    ${kpiLink(qs(f, { nivel: "frio", estado: "" }), "⚪ Fríos", cuenta("frio"), f.nivel === "frio", NIVEL.frio.color)}
    ${kpiLink(qs({ ...f, nivel: "" }, { estado: "con_llamada" }), "📞 Con llamada", conLlamada, f.estado === "con_llamada")}
  </div>`;

  const sel = (name: string, valor: string | undefined, opciones: Array<[string, string]>) =>
    `<select name="${name}" class="crm-in" onchange="this.form.submit()">${opciones
      .map(([v, t]) => `<option value="${v}"${(valor ?? "") === v ? " selected" : ""}>${t}</option>`)
      .join("")}</select>`;
  const filtros = `<form method="GET" action="/admin/crm" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
    <input class="crm-in" type="search" name="q" value="${esc(f.q)}" placeholder="Buscar por nombre, teléfono, correo o ciudad…" style="min-width:280px;flex:1">
    ${f.nivel ? `<input type="hidden" name="nivel" value="${esc(f.nivel)}">` : ""}
    ${sel("canal", f.canal, [["", "Todos los canales"], ["whatsapp", "WhatsApp"], ["instagram", "Instagram"]])}
    ${sel("estado", f.estado, [["", "Cualquier estado"], ["con_llamada", "Con llamada agendada"], ["sin_llamada", "Sin llamada"], ["registrado", "Ya registrado en Zoho"], ["sin_registrar", "Sin registrar en Zoho"]])}
    <button class="crm-in" style="cursor:pointer">Buscar</button>
    <a class="ghostbtn" href="${qs(f, {}).replace("/admin/crm", "/admin/crm/export.xlsx")}" style="margin-left:auto;display:inline-flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);color:var(--muted);padding:8px 14px;font-size:12.5px">⬇ Excel (${filtradas.length})</a>
  </form>`;

  const filas = filtradas
    .map((r) => {
      const l = r.lead;
      const m = l.ficha.metadata;
      const contacto = [l.telefono, l.correo.split(",")[0]].filter(Boolean).map(esc).join("<br>") || `<span class="text-dim">—</span>`;
      const interes = [m.ciudadCompra, m.ahorroDisponible].filter(Boolean).map(esc).join(" · ") || "—";
      const reg = r.registro === "registrado" ? `<span style="color:var(--ok)">✔ Registrado</span>` : r.registro === "existente" ? `<span style="color:var(--info)">ya existía</span>` : `<span class="text-dim">sin registrar</span>`;
      return `<a class="crm-row" href="/admin/crm/c/${encodeURIComponent(l.convId)}">
        <span>${badgeNivel(l.prioridad.nivel, l.prioridad.puntos)}</span>
        <span><span style="color:var(--cream);font-weight:600">${esc(l.nombre)}</span><br><span class="text-dim" style="font-size:11px">${esc(l.canal)}${r.perfil ? ` · @${esc(r.perfil)}` : ""}${r.ticketAbierto ? " · 🔔 ticket" : ""}</span></span>
        <span class="text-muted">${contacto}</span>
        <span class="text-muted">${interes}</span>
        <span class="text-dim" title="${esc(fechaHora(r.ultimo))}">${hace(r.ultimo, now)}</span>
        <span>${l.llamada ? `📞 ${esc(l.llamada)}` : `<span class="text-dim">—</span>`}</span>
        <span>${reg}</span>
      </a>`;
    })
    .join("");

  const vacio = `<div style="padding:44px 18px;text-align:center;color:var(--dim)">No hay leads con estos filtros.</div>`;
  const body = `${ESTILO_CRM}
    ${subnav("leads")}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:14px 18px;border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--panel)">
      <div><div style="font-weight:700;font-size:16px;color:var(--cream)">Clientes de Maricela Naranjo</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">Viventa · compra de vivienda en Colombia desde el exterior</div></div>
      <div style="font-size:11px;color:var(--dim)">${new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long" }).format(new Date(now))}</div>
    </div>
    ${kpis}
    ${filtros}
    <div class="crm-card" style="overflow-x:auto">
      <div style="min-width:900px">
        <div class="crm-row crm-head"><span>Prioridad</span><span>Cliente</span><span>Contacto</span><span>Interés</span><span>Último mensaje</span><span>Llamada</span><span>Zoho</span></div>
        ${filtradas.length ? filas : vacio}
      </div>
    </div>
    <p class="text-dim" style="font-size:11px;margin-top:10px">Se muestran los clientes que dejaron datos en los últimos ${DIAS_VISIBLES} días, de WhatsApp e Instagram. Ordenados: calientes primero, luego por puntaje.</p>`;
  return layout({ title: "CRM", activeTab: "crm", body, env });
}

// ─── Ficha del cliente ───────────────────────────────────────────────────────

interface LlamadaFicha {
  inicio: number;
  estado: string;
  enlace: string;
  zona: string;
  local: string;
}

async function llamadasDe(db: Db, convId: string): Promise<LlamadaFicha[]> {
  const rows = await db.all<{ metadata: string | null }>(
    "SELECT metadata FROM leads WHERE conversation_id = ? AND intent LIKE 'Cita ·%' ORDER BY created_at DESC LIMIT 10",
    [convId],
  );
  const out: LlamadaFicha[] = [];
  for (const r of rows) {
    try {
      const m = JSON.parse(r.metadata ?? "{}") as Record<string, string>;
      const t = m.calStart ? Date.parse(m.calStart) : NaN;
      if (!Number.isFinite(t)) continue;
      out.push({
        inicio: t,
        estado: m.estado ?? "",
        enlace: m.calMeetingUrl ?? "",
        zona: m.zonaEtiqueta ?? "",
        local: m.zonaCliente ? horaEn(new Date(t).toISOString(), m.zonaCliente) : "",
      });
    } catch { /* fila rota */ }
  }
  return out;
}

const RE_MARCADOR = /\[\[\s*([a-zñáéíóú]+)\s*:?\s*([^\]]*)\]\]/gi;

/** Texto de un mensaje listo para HTML: escapa y convierte los marcadores [[botones: …]] en chips. */
export function mensajeHtml(texto: string): string {
  const botones: string[] = [];
  let limpio = texto.replace(RE_MARCADOR, (_m, tipo: string, resto: string) => {
    const t = tipo.toLowerCase();
    if (t === "botones" || t === "buttons") botones.push(...resto.split("|").map((x) => x.trim()).filter(Boolean));
    else botones.push(`${t}${resto.trim() ? `: ${resto.trim()}` : ""}`);
    return "";
  });
  limpio = limpio.trim() || (botones.length ? "" : "(mensaje vacío)");
  const chips = botones.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:${limpio ? "8px" : "0"}">${botones
        .map((b) => `<span style="border:1px solid var(--linelit);padding:2px 9px;font-size:11px;color:var(--accent);background:var(--accent-soft)">${esc(b)}</span>`)
        .join("")}</div>`
    : "";
  return `${esc(limpio)}${chips}`;
}

export function burbujas(msgs: Array<{ role: string; content: string; created_at: number }>): string {
  if (msgs.length === 0) return `<div class="text-dim" style="padding:30px;text-align:center">Sin mensajes.</div>`;
  let diaPrevio = "";
  return msgs
    .map((m) => {
      const dia = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long" }).format(new Date(m.created_at));
      const sep = dia !== diaPrevio ? `<div style="text-align:center;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:14px 0 6px">${esc(dia)}</div>` : "";
      diaPrevio = dia;
      const hora = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(m.created_at));
      const esCliente = m.role === "user";
      const esEquipo = m.role === "owner";
      const quien = esCliente ? "Cliente" : esEquipo ? "Equipo (persona)" : m.role === "assistant" ? "Bot" : m.role;
      const estilo = esCliente
        ? "background:var(--raise);border:1px solid var(--line);margin-right:auto"
        : esEquipo
          ? "background:rgba(122,162,214,.14);border:1px solid var(--info);margin-left:auto"
          : "background:var(--accent-soft);border:1px solid var(--accent);margin-left:auto";
      return `${sep}<div style="display:flex;flex-direction:column;margin:6px 0"><div class="burbuja" style="${estilo}">${mensajeHtml(m.content)}<div style="font-size:10px;color:var(--dim);margin-top:5px">${esc(quien)} · ${hora}</div></div></div>`;
    })
    .join("");
}

export async function renderCrmFicha(env: Env, convId: string, opts: { guardado?: boolean; errorIA?: string } = {}, now = Date.now()): Promise<string | null> {
  const db = new Db(env.DB);
  const conv = await db.first<ConvRow>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at, open_ticket_id, metadata FROM conversations WHERE id = ?",
    [convId],
  );
  if (!conv) return null;
  const leadsRows = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }>(
    "SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC",
    [convId],
  );
  const llamadas = await llamadasDe(db, convId);
  const proxima = llamadas.find((x) => x.estado === "Reservada (Cal.com)" && x.inicio > now);
  const mapa = new Map<string, number>();
  if (proxima) mapa.set(convId, proxima.inicio);
  const [lead] = armarLeads([conv], leadsRows, mapa);
  const msgs = await db.all<{ role: string; content: string; created_at: number }>(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 600",
    [convId],
  );
  const tickets = await db.all<{ id: string; summary: string; status: string | null; created_at: number }>(
    "SELECT id, summary, status, created_at FROM tickets WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 12",
    [convId],
  );
  const m = metaConv(conv);
  const formUrl = ((await new SettingsRepo(db).get(SETTING_FORM_URL)) ?? "").trim();

  const nombre = lead?.nombre ?? conv.display_name ?? "(sin nombre)";
  const canal = lead?.canal ?? (conv.channel === "zernio" ? "Instagram" : "WhatsApp");
  const meta = lead?.ficha.metadata ?? {};
  const prioridad = lead?.prioridad;

  const dato = (k: string, v: string | undefined | null) => (v ? `<div class="crm-dato"><span>${esc(k)}</span><span>${esc(v)}</span></div>` : "");
  const contacto = [
    dato("Canal", canal),
    conv.channel === "zernio" ? dato("Perfil de Instagram", conv.display_name ? `@${conv.display_name}` : "") : "",
    dato("Teléfono", lead?.telefono),
    dato("Correo", lead?.correo),
  ].join("");

  const clavesFicha = Object.keys(meta).filter((k) => meta[k] && !/^(cita|cal)/i.test(k));
  const ficha = clavesFicha.map((k) => dato(etiqueta(k), meta[k])).join("") || `<div class="text-dim" style="font-size:12px">Aún no dejó datos.</div>`;

  const razones = prioridad?.razones?.length
    ? `<ul style="margin:8px 0 0;padding-left:18px;font-size:12px;color:var(--muted);line-height:1.6">${prioridad.razones.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
    : "";

  const zona = zonaDeResidencia(meta.ciudadResidencia);
  const llamadasHtml = llamadas.length
    ? llamadas
        .map((x) => {
          const activa = x.estado === "Reservada (Cal.com)" && x.inicio > now;
          const local = !esEspana(zona) && zona ? ` · ${horaEn(new Date(x.inicio).toISOString(), zona.tz)} en ${zona.etiqueta}` : x.local ? ` · ${x.local} en ${x.zona}` : "";
          return `<div style="padding:8px 0;border-bottom:1px dashed var(--line);font-size:12.5px">
            <div style="color:var(--cream);font-weight:600">${activa ? "📞" : "🗓"} ${esc(formatoLlamada(x.inicio))} <span class="text-dim" style="font-weight:400">(hora de España${esc(local)})</span></div>
            <div class="text-dim" style="font-size:11.5px">${esc(activa ? "Agendada" : x.estado || "Pasada")}</div>
            ${x.enlace && activa ? `<a href="${esc(x.enlace)}" target="_blank" rel="noopener" style="font-size:12px">▶ Entrar a Google Meet</a>` : ""}
          </div>`;
        })
        .join("")
    : `<div class="text-dim" style="font-size:12px">Sin llamadas agendadas.</div>`;

  const falta = lead ? faltantes(lead) : [];
  const registro = m.viventa_registrado
    ? `<span style="color:var(--ok)">✔ Registrado en Zoho</span>`
    : m.viventa_existente
      ? `<span style="color:var(--info)">Ya existía en el sistema</span>`
      : falta.length
        ? `<span style="color:var(--bad)">Falta: ${esc(falta.join(", "))}</span>`
        : `<span style="color:var(--accent)">Listo para registrar${lead && correoParaFormulario(lead).inventado ? " (correo inventado)" : ""}</span>`;
  const botonRegistro = lead && formUrl && !m.viventa_registrado && !m.viventa_existente && !falta.length
    ? `<a class="bigbtn" href="${esc(urlFormulario(formUrl, lead))}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;background:var(--accent);color:var(--bg);padding:8px 14px;font-size:12px;font-weight:700">Abrir formulario de Zoho</a>`
    : "";

  const ticketsHtml = tickets.length
    ? tickets
        .map((t) => `<div style="padding:8px 0;border-bottom:1px dashed var(--line);font-size:12px"><div class="text-dim" style="font-size:10.5px">${esc(fechaHora(t.created_at))} · ${esc(t.status ?? "")}</div><div class="text-muted">${esc(t.summary.slice(0, 420))}</div></div>`)
        .join("")
    : `<div class="text-dim" style="font-size:12px">Sin tickets.</div>`;

  const card = (titulo: string, contenido: string) =>
    `<div class="crm-card" style="padding:16px;margin-bottom:14px"><div class="crm-sec">${titulo}</div>${contenido}</div>`;

  const izquierda = `
    ${card("Prioridad", `<div>${prioridad ? badgeNivel(prioridad.nivel, prioridad.puntos) : badgeNivel("frio")}</div>${razones}`)}
    ${card("Contacto", contacto)}
    ${card("Ficha del cliente", ficha)}
    ${lead?.ficha.notas ? card("Notas del bot", `<div class="text-muted" style="font-size:12.5px;white-space:pre-wrap;line-height:1.5">${esc(lead.ficha.notas)}</div>`) : ""}
    ${card("Videollamada", llamadasHtml)}
    ${card("Registro en Zoho", `<div style="font-size:12.5px">${registro}</div>${botonRegistro}`)}
    ${card("Tickets", ticketsHtml)}
    ${card("Nota interna (solo equipo)", `<form method="POST" action="/admin/crm/c/${encodeURIComponent(convId)}/nota">
        <textarea name="nota" rows="4" class="crm-in" style="width:100%;resize:vertical" placeholder="Ej.: la llamé el lunes, prefiere por la tarde…">${esc(m.crm_nota ?? "")}</textarea>
        <button class="bigbtn" style="margin-top:8px;background:var(--accent);color:var(--bg);padding:7px 14px;font-size:12px;font-weight:700;border:0;cursor:pointer">Guardar nota</button>
        ${opts.guardado ? `<span style="color:var(--ok);font-size:12px;margin-left:10px">✔ Guardada</span>` : ""}
      </form>`)}`;

  const { tarjetaAnalisisConv } = await import("./crm-ia.local");
  const tarjetaIA = await tarjetaAnalisisConv(env, convId, conv.last_message_at, { error: opts.errorIA });

  const derecha = `${tarjetaIA}<div class="crm-card" style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap">
        <div class="crm-sec" style="margin:0">Conversación completa (${msgs.length} mensajes)</div>
        <a class="ghostbtn" href="/admin/conversations?c=${encodeURIComponent(convId)}" style="font-size:12px;border:1px solid var(--line);padding:6px 12px;color:var(--muted)">💬 Responder desde Conversaciones</a>
      </div>
      <div style="max-height:calc(100vh - 220px);overflow-y:auto;padding-right:6px">${burbujas(msgs)}</div>
    </div>`;

  const body = `${ESTILO_CRM}
    <div style="margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <a href="/admin/crm" style="font-size:12px">← Volver a los leads</a>
      <h2 style="font-family:'Space Grotesk';font-weight:700;font-size:20px;margin:0">${esc(nombre)}</h2>
      ${prioridad ? badgeNivel(prioridad.nivel, prioridad.puntos) : ""}
      <span class="text-dim" style="font-size:12px">Último mensaje ${esc(hace(conv.last_message_at, now))}</span>
    </div>
    <div class="crm-grid"><div>${izquierda}</div><div>${derecha}</div></div>`;
  return layout({ title: `CRM · ${nombre}`, activeTab: "crm", body, env });
}

export async function guardarNota(env: Env, convId: string, nota: string): Promise<void> {
  await new Db(env.DB).run(
    "UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_nota', ?) WHERE id = ?",
    [nota.trim().slice(0, 2000), convId],
  );
}

// ─── Excel de la lista ───────────────────────────────────────────────────────

export async function excelCrm(env: Env, f: FiltrosCrm, now = Date.now()): Promise<Uint8Array> {
  const filas = ordenarCrm(filtrarCrm(await cargarCrm(env, now), f));
  const head = ["#", "Prioridad", "Puntos", "Canal", "Nombre", "Perfil de Instagram", "Teléfono", "Correo", "Ciudad de interés", "Dónde vive", "Ahorro", "Cuota mensual", "Ingresos", "Empleo", "Entrega", "Llamada agendada", "Zoho", "Último mensaje", "Nota interna"];
  const rows: Array<Array<string | number>> = [head];
  filas.forEach((r, i) => {
    const m = r.lead.ficha.metadata;
    rows.push([
      i + 1, NIVEL[r.lead.prioridad.nivel].nombre, r.lead.prioridad.puntos, r.lead.canal, r.lead.nombre, r.perfil, r.lead.telefono, r.lead.correo,
      m.ciudadCompra ?? "", m.ciudadResidencia ?? "", m.ahorroDisponible ?? "", m.capacidadMensual ?? "", m.ingresosMensuales ?? "", m.tipoEmpleo ?? "", m.entregaInmediataOFutura ?? "",
      r.lead.llamada, r.registro || "sin registrar", fechaHora(r.ultimo), r.nota,
    ]);
  });
  return buildXlsx([{ name: "Leads", rows, widths: [4, 11, 8, 11, 26, 20, 17, 30, 18, 24, 20, 16, 16, 20, 18, 20, 14, 16, 30] }]);
}
