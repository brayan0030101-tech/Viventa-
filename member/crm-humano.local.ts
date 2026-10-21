// member/crm-humano.local.ts — CRM de Viventa: «Esperando un humano».
// Personas cuya prospección el bot NO pudo terminar (le faltan preguntas) y que no reaccionaron a los intentos del bot:
// una persona (Nicole, Camila o Maricela) debe llamarlas con las mismas preguntas y, si hay interés, invitarlas a la videollamada.
// Entran cuando: el último mensaje del cliente tiene ≥ 2 días, ya hubo 2 intentos del bot (o 1 en Instagram, donde no hay plantilla),
// nadie del equipo le escribió y el último mensaje del bot tiene ≥ 2 días. «Ya la llamé» la saca hasta que el cliente vuelva a escribir.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { armarLeads, evaluarCalificacion } from "../src/followup/resumenDia";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, hace } from "./crm.local";

const H = 3_600_000;
const DIA = 24 * H;

const ETIQUETA: Record<string, string> = {
  ciudadResidencia: "dónde vive", ciudadCompra: "ciudad de compra", entregaInmediataOFutura: "entrega", ahorroDisponible: "ahorro",
  capacidadMensual: "cuota mensual", tipoEmpleo: "trabajo", ingresosMensuales: "ingresos",
};
const BASE_PREGUNTAS = Object.keys(ETIQUETA);

export interface EsperandoHumano {
  convId: string;
  nombre: string;
  canal: "WhatsApp" | "Instagram";
  telefono: string;
  faltan: string[];
  intentos: number;
  ultimoCliente: number;
  ultimoBot: number;
  ultimoMensaje: string;
}

export async function cargarEsperandoHumano(env: Env, now = Date.now()): Promise<EsperandoHumano[]> {
  const db = new Db(env.DB);
  const convs = await db.all<{ id: string; channel: string; channel_user_id: string; display_name: string | null; last_message_at: number; metadata: string | null; paused_until: number | null }>(
    "SELECT id, channel, channel_user_id, display_name, last_message_at, metadata, paused_until FROM conversations WHERE channel IN ('ycloud', 'zernio') AND last_message_at BETWEEN ? AND ? ORDER BY last_message_at DESC LIMIT 500",
    [now - 30 * DIA, now - 2 * DIA],
  );
  const out: EsperandoHumano[] = [];
  for (const c of convs) {
    let meta: Record<string, unknown> = {};
    try { meta = c.metadata ? JSON.parse(c.metadata) : {}; } catch { /* metadatos rotos */ }
    if (["perdido", "cerrado"].includes(String(meta.crm_etapa ?? "")) || meta.crm_descarte || meta.viventa_registrado) continue;
    const msgs = await db.all<{ role: string; content: string; created_at: number }>("SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 40", [c.id]);
    const ultCli = msgs.find((m) => m.role === "user");
    if (!ultCli) continue;
    if (now - ultCli.created_at < 2 * DIA) continue;
    if (msgs.some((m) => m.role === "owner")) continue; // ya la atendió una persona
    const botDespues = msgs.filter((m) => m.role === "assistant" && m.created_at > ultCli.created_at);
    const ultBot = botDespues.reduce((a, m) => Math.max(a, m.created_at), 0);
    const intentos = Math.max(0, botDespues.length - 1);
    const sinPlantilla = c.channel === "zernio";
    if (intentos < (sinPlantilla ? 1 : 2)) continue;
    if (ultBot && now - ultBot < 2 * DIA) continue;
    if (Number(meta.crm_humano_hecho ?? 0) > ultCli.created_at) continue;
    if (/ya no estoy interesad|no me interesa|no estoy interesad/i.test(ultCli.content)) continue;
    const leadsRows = await db.all<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null; intent: string | null }>(
      "SELECT conversation_id, name, contact, notes, metadata, intent FROM leads WHERE conversation_id = ?", [c.id]);
    if (leadsRows.some((l) => (l.intent ?? "").startsWith("Cita ·"))) continue;
    if (leadsRows.some((l) => /no quiere continuar/i.test(l.notes ?? ""))) continue;
    const [lead] = armarLeads([{ id: c.id, channel: c.channel, channel_user_id: c.channel_user_id, display_name: c.display_name, last_message_at: c.last_message_at }], leadsRows.filter((l) => !(l.intent ?? "").startsWith("Cita ·")));
    const faltan = lead ? evaluarCalificacion(lead.ficha.metadata).faltan.filter((k) => BASE_PREGUNTAS.includes(k)) : BASE_PREGUNTAS;
    if (!faltan.length) continue;
    out.push({
      convId: c.id,
      nombre: lead?.nombre || c.display_name || "(sin nombre)",
      canal: c.channel === "ycloud" ? "WhatsApp" : "Instagram",
      telefono: lead?.telefono || (c.channel === "ycloud" ? `+${c.channel_user_id}` : ""),
      faltan, intentos, ultimoCliente: ultCli.created_at, ultimoBot: ultBot,
      ultimoMensaje: ultCli.content.replace(/\s+/g, " ").slice(0, 110),
    });
  }
  return out.sort((a, b) => (a.telefono ? 0 : 1) - (b.telefono ? 0 : 1) || b.ultimoCliente - a.ultimoCliente);
}

export async function marcarLlamada(env: Env, convId: string, now = Date.now()): Promise<void> {
  await new Db(env.DB).run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_humano_hecho', ?) WHERE id = ?", [now, convId]);
}

export async function renderCrmHumano(env: Env, now = Date.now()): Promise<string> {
  const lista = await cargarEsperandoHumano(env, now);
  const filas = lista
    .map((p) => {
      const wa = p.telefono ? `https://wa.me/${p.telefono.replace(/\D/g, "")}` : "";
      return `<div class="crm-card" style="padding:12px 16px;margin-bottom:10px;display:grid;grid-template-columns:1.3fr 1.6fr 1fr auto;gap:12px;align-items:center">
        <div><a href="/crm/c/${encodeURIComponent(p.convId)}" style="font-weight:600;color:var(--cream)">${esc(p.nombre)}</a>
          <div class="text-dim" style="font-size:11px;margin-top:2px">${esc(p.canal)}${p.telefono ? ` · ${esc(p.telefono)}` : " · sin teléfono (solo Instagram)"}</div></div>
        <div style="font-size:12px"><div class="text-muted">«${esc(p.ultimoMensaje)}»</div><div class="text-dim" style="font-size:11px;margin-top:2px">Le faltan: ${esc(p.faltan.map((k) => ETIQUETA[k] ?? k).join(", "))}</div></div>
        <div class="text-dim" style="font-size:11px">Escribió ${esc(hace(p.ultimoCliente, now))}<br>El bot lo intentó ${p.intentos} ${p.intentos === 1 ? "vez" : "veces"}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${wa ? `<a class="crm-in" href="${esc(wa)}" target="_blank" rel="noopener" style="font-size:11px;padding:5px 9px;text-decoration:none">💬 WhatsApp</a>` : ""}
          <form method="POST" action="/crm/esperando-humano/hecho" style="margin:0"><input type="hidden" name="conv" value="${esc(p.convId)}"><button class="crm-in" style="font-size:11px;padding:5px 9px;cursor:pointer" title="Ya hablaste con esta persona: sale de la lista hasta que vuelva a escribir">✔ Ya la llamé</button></form></div>
      </div>`;
    })
    .join("");
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px;line-height:1.55">Personas a las que el bot <b>no pudo terminarles la prospección</b> y que no reaccionaron a sus intentos (2 por WhatsApp, 1 por Instagram). Hay que <b>llamarlas con las mismas preguntas del bot</b> y, si hay interés, invitarlas a la videollamada. «Ya la llamé» la saca de aquí hasta que vuelva a escribir.</div>
    <div style="font-weight:700;font-size:26px;margin-bottom:12px">${lista.length} <span class="text-dim" style="font-size:12px;font-weight:400">esperando un humano</span></div>
    ${filas || `<div class="text-dim" style="font-size:13px">No hay nadie esperando por ahora. 🎉</div>`}`;
  return crmLayout({ title: "Esperando un humano", activa: "humano", body, env });
}
