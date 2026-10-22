// member/crm-instrucciones.local.ts — CRM de Viventa: «Instrucciones del bot» (solo administrador).
// Historial de las instrucciones del bot (las guarda el guardián), qué reglas imprescindibles faltan en cada versión y botón para restaurar.
import type { Env } from "../src/env";
import { versionesInstrucciones, restaurarInstrucciones, runGuardianInstrucciones, MARCADORES } from "../src/followup/guardianInstrucciones";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, fechaHora } from "./crm.local";

export async function renderInstrucciones(env: Env, opts: { aviso?: string } = {}, now = Date.now()): Promise<string> {
  await runGuardianInstrucciones(env, now).catch(() => undefined);
  const vs = await versionesInstrucciones(env);
  const etiqueta = (k: string) => MARCADORES.find((m) => m.clave === k)?.texto ?? k;
  const filas = vs.map((v) => `<div class="crm-card" style="padding:12px 16px;margin-bottom:8px;display:grid;grid-template-columns:1.2fr 1fr 2fr auto;gap:12px;align-items:center">
      <div><b style="color:var(--cream)">${esc(fechaHora(v.creado))}</b>${v.actual ? ` <span style="color:var(--ok);font-size:11px;font-weight:700">● versión actual</span>` : ""}</div>
      <div class="text-dim" style="font-size:12px">${v.largo.toLocaleString("es-ES")} caracteres</div>
      <div style="font-size:12px">${v.faltan.length ? `<span style="color:var(--bad)">Le faltan: ${esc(v.faltan.map(etiqueta).join(" · "))}</span>` : `<span style="color:var(--ok)">Tiene todas las reglas imprescindibles</span>`}</div>
      <div>${v.actual ? "" : `<form method="POST" action="/crm/instrucciones/restaurar" style="margin:0" onsubmit="return confirm('¿Restaurar esta versión? Se guarda antes la actual.')"><input type="hidden" name="id" value="${v.id}"><button class="crm-in" style="font-size:11px;padding:5px 9px;cursor:pointer">↩ Restaurar</button></form>`}</div></div>`).join("");
  const body = `${ESTILO_CRM}
    ${opts.aviso ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:12px;color:var(--ok);font-size:12.5px">${esc(opts.aviso)}</div>` : ""}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px;line-height:1.55">Cada vez que cambian las instrucciones del bot se guarda una copia. Si alguien (o una sesión de trabajo) borra una regla importante, aparece aquí en rojo y se avisa por Telegram. Reglas que se vigilan: ${MARCADORES.map((m) => `«${esc(m.texto.toLowerCase())}»`).join(", ")}.</div>
    ${filas || `<div class="text-dim">Todavía no hay versiones guardadas.</div>`}`;
  return crmLayout({ title: "Instrucciones del bot", activa: "instrucciones", body, env });
}

export { restaurarInstrucciones };
