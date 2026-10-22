// member/crm-auditoria.local.ts — CRM de Viventa: «Auditoría». Lo que el auditor (src/followup/auditor.ts) encontró trabado o fallando:
// buenos perfiles sin videollamada, clientes sin respuesta, mensajes que no llegaron, fallos de la IA. Se cierra solo al resolverse.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";
import { ETIQUETA_TIPO, asegurarTablaAuditoria, type Hallazgo } from "../src/followup/auditor";
import { SettingsRepo } from "../src/db/settings";
import type { MejoraSugerida } from "../src/followup/auditorIA";

const H = 3_600_000;

function hace(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `hace ${m} min`;
  if (m < 24 * 60) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
}

export interface ContactoAud {
  nombre: string;
  telefono: string;
  canal: "WhatsApp" | "Instagram" | "Otro";
  usuario: string;
  sinTelefono: boolean;
}

/** Quién es el cliente de cada hallazgo: nombre, teléfono (para buscarlo en el WhatsApp normal) y canal. Una sola tanda de consultas. */
export async function contactosDe(db: Db, convIds: string[]): Promise<Map<string, ContactoAud>> {
  const out = new Map<string, ContactoAud>();
  const ids = [...new Set(convIds)];
  for (let i = 0; i < ids.length; i += 80) {
    const lote = ids.slice(i, i + 80);
    const q = lote.map(() => "?").join(",");
    const convs = await db.all<{ id: string; channel: string; channel_user_id: string; display_name: string | null }>(`SELECT id, channel, channel_user_id, display_name FROM conversations WHERE id IN (${q})`, lote);
    const leads = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null }>(`SELECT conversation_id, name, contact FROM leads WHERE conversation_id IN (${q}) AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC`, lote);
    for (const c of convs) {
      const ls = leads.filter((l) => l.conversation_id === c.id);
      const nombre = [...ls].reverse().find((l) => (l.name ?? "").trim())?.name?.trim() || c.display_name || "";
      const telLead = ls.flatMap((l) => String(l.contact ?? "").split(/[;,\s]+/)).filter((k) => k && !k.includes("@") && k.replace(/\D/g, "").length >= 8).pop() ?? "";
      const esBsuid = c.channel === "ycloud" && !/^\d{8,}$/.test(c.channel_user_id);
      const telefono = c.channel === "ycloud" && !esBsuid ? `+${c.channel_user_id}` : telLead;
      out.set(c.id, { nombre, telefono, canal: c.channel === "ycloud" ? "WhatsApp" : c.channel === "zernio" ? "Instagram" : "Otro", usuario: c.channel === "zernio" ? c.display_name ?? "" : esBsuid ? c.display_name ?? "" : "", sinTelefono: !telefono });
    }
  }
  return out;
}

const fila = (h: Hallazgo, now: number, resuelto: boolean, c: ContactoAud | undefined, volver: string): string => {
  const e = ETIQUETA_TIPO[h.tipo] ?? { icono: "•", texto: h.tipo, grave: false };
  const digitos = (c?.telefono ?? "").replace(/\D/g, "");
  const wa = digitos.length >= 9 ? `https://wa.me/${digitos}` : "";
  const cliente = c
    ? `<div style="font-weight:600;color:var(--cream);font-size:13px">${esc(c.nombre || c.usuario || "(sin nombre)")}</div>
       <div style="font-size:12px;margin-top:2px">${c.telefono ? `<b>${esc(c.telefono)}</b>` : `<span style="color:var(--bad)">sin teléfono visible</span>`}</div>
       <div class="text-dim" style="font-size:11px">${esc(c.canal)}${c.usuario && c.canal === "Instagram" ? ` · @${esc(c.usuario)}` : ""}</div>`
    : `<span class="text-dim">${esc(h.conv_id)}</span>`;
  const acciones = resuelto
    ? `<form method="POST" action="/crm/auditoria/reabrir" style="margin:0"><input type="hidden" name="id" value="${h.id}"><input type="hidden" name="volver" value="${esc(volver)}"><button class="crm-in" style="font-size:11px;padding:4px 8px;cursor:pointer">↩ Reabrir</button></form>`
    : `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        ${wa ? `<a class="crm-in" href="${esc(wa)}" target="_blank" rel="noopener" style="font-size:11px;padding:5px 9px;text-decoration:none" title="Abre su WhatsApp directamente">💬 WhatsApp</a>` : ""}
        <a class="crm-in" href="/crm/c/${esc(encodeURIComponent(h.conv_id))}" target="_blank" style="font-size:11px;padding:5px 9px;text-decoration:none" title="Ficha del cliente con su teléfono, datos y conversación">🗂 Ficha</a>
        <a class="crm-in" href="/crm/zoho/abrir?conv=${esc(encodeURIComponent(h.conv_id))}" target="_blank" rel="noopener" style="font-size:11px;padding:5px 9px;text-decoration:none" title="Abre la ficha de este cliente en Zoho CRM">🔗 Zoho</a>
        <a href="/admin/conversations?c=${esc(encodeURIComponent(h.conv_id))}" target="_blank" style="font-size:11px;padding:5px 6px;color:var(--dim)" title="La conversación tal como la ve el bot (panel de Forja)">🤖</a>
        <form method="POST" action="/crm/auditoria/resolver" style="margin:0"><input type="hidden" name="id" value="${h.id}"><input type="hidden" name="volver" value="${esc(volver)}"><button class="crm-in" style="font-size:11px;padding:5px 9px;cursor:pointer;color:var(--ok)" title="Ya lo vimos o ya está resuelto">✔ Resuelto</button></form></div>`;
  return `<tr style="border-top:1px solid var(--line);vertical-align:top">
    <td style="padding:10px 8px;font-size:12px;max-width:190px">${e.icono} <b style="color:var(--cream)">${esc(e.texto)}</b><div class="text-dim" style="font-size:11px;margin-top:3px">${hace(now - h.creado)}${resuelto && h.resuelto_en ? ` · resuelto ${hace(now - h.resuelto_en)}${h.resuelto_por ? ` por ${esc(h.resuelto_por)}` : " solo"}` : ""}</div></td>
    <td style="padding:10px 8px;min-width:150px">${cliente}</td>
    <td style="padding:10px 8px;font-size:12.5px;line-height:1.45">${esc(h.detalle)}</td>
    <td style="padding:10px 8px;text-align:right">${acciones}</td></tr>`;
};

export async function renderAuditoria(env: Env, now = Date.now(), opts: { esAdmin?: boolean; aviso?: string; orden?: string; tipo?: string } = {}): Promise<string> {
  const db = new Db(env.DB);
  await asegurarTablaAuditoria(db);
  const orden = opts.orden === "nuevos" ? "nuevos" : "viejos";
  const todos = await db.all<Hallazgo>(`SELECT * FROM auditoria_hallazgos WHERE resuelto_en IS NULL ORDER BY creado ${orden === "nuevos" ? "DESC" : "ASC"} LIMIT 400`);
  const porTipo = new Map<string, number>();
  for (const h of todos) porTipo.set(h.tipo, (porTipo.get(h.tipo) ?? 0) + 1);
  const tipo = opts.tipo && porTipo.has(opts.tipo) ? opts.tipo : "";
  const abiertos = tipo ? todos.filter((h) => h.tipo === tipo) : todos;
  const viejos3 = todos.filter((h) => now - h.creado > 3 * 24 * H).length;
  const cerrados = await db.all<Hallazgo>("SELECT * FROM auditoria_hallazgos WHERE resuelto_en IS NOT NULL AND resuelto_en > ? ORDER BY resuelto_en DESC LIMIT 60", [now - 3 * 24 * H]);
  let mejoras: { fecha: string; reglas: MejoraSugerida[] } | null = null;
  try {
    mejoras = JSON.parse((await new SettingsRepo(db).get("auditoria_ia_mejoras")) ?? "null");
  } catch {
    mejoras = null;
  }
  const bloqueMejoras = mejoras?.reglas?.length
    ? `<h3 style="font-size:14px;margin:22px 0 8px">💡 Mejoras sugeridas para el bot <span class="text-dim" style="font-size:11.5px;font-weight:400">(${esc(mejoras.fecha)})</span></h3>
       <div class="text-dim" style="font-size:12px;margin-bottom:8px">El auditor revisó las conversaciones del día y propone estas reglas nuevas. No se aplican solas: ${opts.esAdmin ? "tú decides" : "las aprueba el administrador"}. Al aplicarse se guarda una copia de seguridad de las instrucciones.</div>
       ${mejoras.reglas.map((r, i) => `<div class="crm-card" style="padding:14px;margin-bottom:10px"><b style="color:var(--cream);font-size:13px">${esc(r.titulo)}</b>
         <div style="font-size:12.5px;line-height:1.5;margin:8px 0;white-space:pre-wrap">${esc(r.texto)}</div>
         ${r.aplicada ? `<span style="color:var(--ok);font-size:12px">✔ Aplicada ${hace(now - Date.parse(r.aplicada))}</span>` : opts.esAdmin ? `<form method="POST" action="/crm/auditoria/aplicar" onsubmit="return confirm('Se añadirá esta regla a las instrucciones del bot (con copia de seguridad). ¿Aplicar?')" style="margin:0"><input type="hidden" name="i" value="${i}"><button type="submit" class="bigbtn" style="cursor:pointer">Aplicar al bot</button></form>` : `<span class="text-dim" style="font-size:12px">Pendiente de aprobación del administrador</span>`}</div>`).join("")}`
    : "";
  const contactos = await contactosDe(db, [...abiertos.slice(0, 150), ...cerrados].map((h) => h.conv_id));
  const volver = `${opts.orden ? `orden=${orden}` : ""}${tipo ? `${opts.orden ? "&" : ""}tipo=${tipo}` : ""}`;
  const tabla = (xs: Hallazgo[], res: boolean) => `<div class="crm-card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse">${xs.map((h) => fila(h, now, res, contactos.get(h.conv_id), volver)).join("")}</table></div>`;
  const enlace = (q: string, txt: string, on: boolean) => `<a class="crm-in" href="/crm/auditoria${q ? `?${q}` : ""}" style="text-decoration:none;font-size:12px;padding:5px 10px;${on ? "background:var(--accent);color:var(--bg);font-weight:700" : ""}">${txt}</a>`;
  const chips = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${enlace(`orden=${orden}`, `Todos · ${todos.length}`, !tipo)}${[...porTipo.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => enlace(`orden=${orden}&tipo=${t}`, `${ETIQUETA_TIPO[t as keyof typeof ETIQUETA_TIPO]?.icono ?? "•"} ${esc((ETIQUETA_TIPO[t as keyof typeof ETIQUETA_TIPO]?.texto ?? t).split(" (")[0].slice(0, 38))} · ${n}`, tipo === t)).join("")}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px"><span class="text-dim" style="font-size:12px">Orden:</span>${enlace(`orden=viejos${tipo ? `&tipo=${tipo}` : ""}`, "Los más viejos primero", orden === "viejos")}${enlace(`orden=nuevos${tipo ? `&tipo=${tipo}` : ""}`, "Los más nuevos primero", orden === "nuevos")}
      ${viejos3 ? `<form method="POST" action="/crm/auditoria/resolver-antiguos" style="margin:0 0 0 auto" onsubmit="return confirm('Se marcarán como resueltos ${viejos3} casos de más de 3 días. ¿Seguro?')"><input type="hidden" name="dias" value="3"><input type="hidden" name="tipo" value="${esc(tipo)}"><input type="hidden" name="volver" value="${esc(volver)}"><button class="crm-in" style="font-size:11.5px;padding:5px 10px;cursor:pointer" title="Para limpiar casos viejos que ya se vieron">✔ Marcar resueltos los de más de 3 días (${viejos3})</button></form>` : ""}</div>`;
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">El auditor revisa cada 5 minutos que ninguna conversación se quede trabada: buenos perfiles sin videollamada agendada, clientes sin respuesta, mensajes que no llegaron y fallos del bot. Cada caso se cierra solo cuando se resuelve y avisa al equipo una sola vez.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
      <div class="crm-card" style="padding:14px"><div class="text-dim" style="font-size:11px">POR ATENDER</div><div style="font-size:26px;font-weight:700;color:${todos.length ? "var(--bad)" : "var(--ok)"}">${todos.length}</div></div>
      <div class="crm-card" style="padding:14px"><div class="text-dim" style="font-size:11px">RESUELTOS (3 DÍAS)</div><div style="font-size:26px;font-weight:700">${cerrados.length}</div></div></div>
    ${opts.aviso ? `<div class="crm-card" style="padding:12px;margin-bottom:12px;color:var(--cream)">${esc(opts.aviso)}</div>` : ""}
    <h3 style="font-size:14px;margin:0 0 8px">Por atender</h3>
    ${chips}
    ${abiertos.length ? tabla(abiertos, false) : `<div class="crm-card" style="padding:22px;color:var(--ok)">✔ Nada pendiente: no hay conversaciones trabadas.</div>`}
    ${cerrados.length ? `<h3 style="font-size:14px;margin:22px 0 8px">Resueltos en los últimos 3 días</h3>${tabla(cerrados, true)}` : ""}
    ${bloqueMejoras}`;
  return crmLayout({ title: "Auditoría", activa: "auditoria", body, env });
}
