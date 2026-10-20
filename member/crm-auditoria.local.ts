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

const fila = (h: Hallazgo, now: number, resuelto: boolean): string => {
  const e = ETIQUETA_TIPO[h.tipo] ?? { icono: "•", texto: h.tipo, grave: false };
  return `<tr style="border-top:1px solid var(--line)">
    <td style="padding:9px 8px;white-space:nowrap;font-size:12px">${e.icono} <b style="color:var(--cream)">${esc(e.texto)}</b></td>
    <td style="padding:9px 8px;font-size:12.5px">${esc(h.detalle)}</td>
    <td style="padding:9px 8px;white-space:nowrap;font-size:11.5px;color:var(--dim)">${hace(now - h.creado)}${resuelto && h.resuelto_en ? `<br>resuelto ${hace(now - h.resuelto_en)}` : ""}</td>
    <td style="padding:9px 8px;text-align:right"><a href="/admin/conversations?c=${esc(encodeURIComponent(h.conv_id))}" target="_blank" style="color:var(--accent);font-size:12px">Abrir conversación</a></td></tr>`;
};

export async function renderAuditoria(env: Env, now = Date.now(), opts: { esAdmin?: boolean; aviso?: string } = {}): Promise<string> {
  const db = new Db(env.DB);
  await asegurarTablaAuditoria(db);
  const abiertos = await db.all<Hallazgo>("SELECT * FROM auditoria_hallazgos WHERE resuelto_en IS NULL ORDER BY creado DESC LIMIT 100");
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
  const tabla = (xs: Hallazgo[], res: boolean) => `<div class="crm-card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse">${xs.map((h) => fila(h, now, res)).join("")}</table></div>`;
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">El auditor revisa cada 5 minutos que ninguna conversación se quede trabada: buenos perfiles sin videollamada agendada, clientes sin respuesta, mensajes que no llegaron y fallos del bot. Cada caso se cierra solo cuando se resuelve y avisa al equipo una sola vez.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
      <div class="crm-card" style="padding:14px"><div class="text-dim" style="font-size:11px">POR ATENDER</div><div style="font-size:26px;font-weight:700;color:${abiertos.length ? "var(--bad)" : "var(--ok)"}">${abiertos.length}</div></div>
      <div class="crm-card" style="padding:14px"><div class="text-dim" style="font-size:11px">RESUELTOS (3 DÍAS)</div><div style="font-size:26px;font-weight:700">${cerrados.length}</div></div></div>
    ${opts.aviso ? `<div class="crm-card" style="padding:12px;margin-bottom:12px;color:var(--cream)">${esc(opts.aviso)}</div>` : ""}
    <h3 style="font-size:14px;margin:0 0 8px">Por atender</h3>
    ${abiertos.length ? tabla(abiertos, false) : `<div class="crm-card" style="padding:22px;color:var(--ok)">✔ Nada pendiente: no hay conversaciones trabadas.</div>`}
    ${cerrados.length ? `<h3 style="font-size:14px;margin:22px 0 8px">Resueltos en los últimos 3 días</h3>${tabla(cerrados, true)}` : ""}
    ${bloqueMejoras}`;
  return crmLayout({ title: "Auditoría", activa: "auditoria", body, env });
}
