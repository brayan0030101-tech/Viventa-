// member/crm-zohonota.local.ts — CRM de Viventa: «Nota y tarea para Zoho» de cada cliente.
// Maricela hoy llena a mano en Zoho una NOTA (mini resumen) y una TAREA (p. ej. «Videollamada
// programada»). Aquí se generan solas, listas para copiar y pegar. La tarea sale de reglas
// (llamada agendada → «Videollamada programada»; llamada hecha → su primer pendiente) y, si no hay
// nada claro, la sugiere la IA. Se recalculan solo cuando el cliente tiene novedades.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { workModel } from "../src/llm/work-model";
import { armarLeads, formatoLlamada } from "../src/followup/resumenDia";
import { esc, fechaHora } from "./crm.local";
import { anonimizar } from "./crm-ia.local";

export interface NotaZoho {
  convId: string;
  nota: string;
  tarea: string;
  cuando: string;
  creado: number;
  modelo: string;
}

async function asegurarTabla(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_zoho_notas (
       conversation_id TEXT PRIMARY KEY, nota TEXT NOT NULL, tarea TEXT NOT NULL, cuando TEXT NOT NULL DEFAULT '',
       creado INTEGER NOT NULL, firma TEXT NOT NULL DEFAULT '', modelo TEXT NOT NULL DEFAULT ''
     )`,
  );
}

const limpio = (t: string, max: number): string =>
  t.replace(/\[\[\s*botones?\s*:\s*([^\]]*)\]\]/gi, "(botones: $1)").replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

interface Contexto {
  nombre: string;
  ficha: string;
  llamadaTxt: string;
  tareaRegla: { titulo: string; cuando: string } | null;
  resultado: string;
  conversacion: string;
  firma: string;
}

async function reunirContexto(env: Env, convId: string, now: number): Promise<Contexto | null> {
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
  const nombre = lead?.nombre ?? conv.display_name ?? "";
  const ficha = lead
    ? Object.entries(lead.ficha.metadata).filter(([k, v]) => v && !/^(cita|cal|viventa_|crm_)/i.test(k)).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "(sin datos)";

  const { cargarLlamadas } = await import("./crm-calendario.local");
  const llamadas = (await cargarLlamadas(env, now)).filter((l) => l.convId === convId && l.estado !== "cancelada").sort((a, b) => a.inicio - b.inicio);
  const futura = llamadas.find((l) => l.estado === "agendada");
  const ultimaPasada = [...llamadas].reverse().find((l) => l.estado === "pasada");

  const { ultimoResultado, pendientesDe } = await import("./crm-resultados.local");
  const res = ultimaPasada ? await ultimoResultado(env, ultimaPasada.id) : null;
  const pend = (await pendientesDe(env, { convId })).filter((p) => !p.hecho && /maricela|equipo/i.test(p.responsable || "maricela"));

  let tareaRegla: Contexto["tareaRegla"] = null;
  let llamadaTxt = "Sin videollamada.";
  if (futura) {
    tareaRegla = { titulo: "Videollamada programada", cuando: formatoLlamada(futura.inicio) };
    llamadaTxt = `Videollamada agendada para ${formatoLlamada(futura.inicio)} (hora de España).`;
  } else if (ultimaPasada) {
    llamadaTxt = `Videollamada realizada el ${formatoLlamada(ultimaPasada.inicio)}.`;
    if (pend[0]) tareaRegla = { titulo: pend[0].texto, cuando: pend[0].cuando };
  }
  const resultado = res ? `Resultado de la llamada: ${res.analisis.resultado}. ${res.analisis.resumen} Próximo paso: ${res.analisis.proximoPaso || "—"}` : "";

  const msgs = await db.all<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 40",
    [convId],
  );
  msgs.reverse();
  const conversacion = anonimizar(
    msgs.map((m) => `${m.role === "user" ? "CLIENTE" : m.role === "owner" ? "EQUIPO" : "BOT"}: ${limpio(m.content, 400)}`).join("\n"),
    nombre,
  );
  // La firma cambia solo cuando hay novedades (mensajes nuevos, llamada agendada/hecha, resultado): evita gastar IA de más.
  const firma = [conv.last_message_at, futura?.id ?? "", futura?.inicio ?? "", ultimaPasada?.id ?? "", res?.id ?? ""].join("|");
  return { nombre, ficha, llamadaTxt, tareaRegla, resultado, conversacion, firma };
}

export async function notaZoho(
  env: Env,
  convId: string,
  opts: { forzar?: boolean } = {},
  now = Date.now(),
): Promise<{ ok: true; nota: NotaZoho; reutilizada: boolean } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const ctx = await reunirContexto(env, convId, now);
  if (!ctx) return { ok: false, error: "No encontré a ese cliente." };
  const previo = await db.first<{ nota: string; tarea: string; cuando: string; creado: number; firma: string; modelo: string }>("SELECT * FROM crm_zoho_notas WHERE conversation_id = ?", [convId]);
  if (previo && !opts.forzar && previo.firma === ctx.firma) {
    return { ok: true, reutilizada: true, nota: { convId, nota: previo.nota, tarea: previo.tarea, cuando: previo.cuando, creado: previo.creado, modelo: previo.modelo } };
  }
  const prompt = `Eres la asistente de Maricela Naranjo (Viventa), que ayuda a colombianos en el exterior a comprar vivienda en Colombia. Ella registra cada cliente en su CRM Zoho con una NOTA y una TAREA. Redáctalas por ella.

DATOS DEL CLIENTE (el nombre y los contactos se omitieron):
${ctx.ficha}
${ctx.llamadaTxt}
${ctx.resultado}

CONVERSACIÓN CON EL BOT (reciente):
${ctx.conversacion || "(sin mensajes)"}

Responde SOLO con un JSON válido, sin texto extra:
{"nota": "mini resumen de 2 a 4 frases, directo, en tercera persona sobre «el cliente»: qué busca, dónde vive, presupuesto/perfil y en qué quedó. No inventes datos.", "tarea": "una tarea corta y concreta para Maricela (verbo + qué), p. ej. «Llamar para…», «Enviar proyectos de…»", "cuando": "plazo si se mencionó, si no vacío"}`;

  let nota = "";
  let tareaIA = "";
  let cuandoIA = "";
  let modelo = "";
  try {
    const llm = await workModel(env, "smart", "insights");
    modelo = llm.modelId;
    const r = await llm.generate({ prompt, maxOutputTokens: 700, temperature: 0.2 } as never);
    const m = String((r as { text?: string }).text ?? "").match(/\{[\s\S]*\}/);
    const j = m ? (JSON.parse(m[0]) as Record<string, unknown>) : {};
    nota = String(j["nota"] ?? "").replace(/\s+/g, " ").trim().slice(0, 900);
    tareaIA = String(j["tarea"] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    cuandoIA = String(j["cuando"] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  } catch (e) {
    console.error("[crm-zohonota]", e);
    return { ok: false, error: "No pude consultar a la IA ahora. Inténtalo en unos minutos." };
  }
  if (!nota) return { ok: false, error: "La IA no devolvió una nota clara. Inténtalo de nuevo." };
  const tarea = ctx.tareaRegla?.titulo || tareaIA || "Hacer seguimiento al cliente";
  const cuando = ctx.tareaRegla ? ctx.tareaRegla.cuando : cuandoIA;
  await db.run(
    "INSERT OR REPLACE INTO crm_zoho_notas (conversation_id, nota, tarea, cuando, creado, firma, modelo) VALUES (?,?,?,?,?,?,?)",
    [convId, nota, tarea, cuando, now, ctx.firma, modelo],
  );
  return { ok: true, reutilizada: false, nota: { convId, nota, tarea, cuando, creado: now, modelo } };
}

// ─── Vista ───────────────────────────────────────────────────────────────────

function campoCopiable(id: string, titulo: string, valor: string, filas: number): string {
  return `<div style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><b style="font-size:12px;color:var(--cream)">${esc(titulo)}</b>
      <button type="button" class="ghostbtn" style="border:1px solid var(--line);padding:3px 10px;font-size:11px;color:var(--muted);cursor:pointer;background:none;font-family:inherit"
        onclick="var t=document.getElementById('${id}');t.select();try{navigator.clipboard.writeText(t.value)}catch(e){document.execCommand('copy')};this.textContent='✔ Copiado';var b=this;setTimeout(function(){b.textContent='Copiar'},1800)">Copiar</button></div>
    <textarea id="${id}" readonly rows="${filas}" class="crm-in" style="width:100%;resize:vertical;font-size:12.5px;line-height:1.5">${esc(valor)}</textarea></div>`;
}

/** Contenido de la tarjeta (se carga sola al abrir la ficha, porque la IA tarda unos segundos). */
export async function tarjetaNotaZohoContenido(env: Env, convId: string, forzar = false): Promise<string> {
  const r = await notaZoho(env, convId, { forzar });
  const cid = encodeURIComponent(convId);
  if (!r.ok) return `<div style="color:var(--bad);font-size:12.5px">${esc(r.error)}</div><button class="ghostbtn" hx-get="/crm/c/${cid}/zoho-nota?r=1" hx-target="#zoho-nota" hx-swap="innerHTML" style="border:1px solid var(--line);padding:6px 12px;font-size:12px;color:var(--muted);margin-top:8px;background:none;cursor:pointer">Reintentar</button>`;
  const n = r.nota;
  const id = "zn" + Math.abs([...convId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  return `${campoCopiable(id + "n", "Nota", n.nota, 5)}
    ${campoCopiable(id + "t", "Tarea" + (n.cuando ? ` · para ${n.cuando}` : ""), n.cuando ? `${n.tarea} — ${n.cuando}` : n.tarea, 2)}
    <div class="text-dim" style="font-size:10.5px">Generado ${esc(fechaHora(n.creado))} (España)${r.reutilizada ? " · sin novedades desde entonces" : ""} ·
      <a href="#" hx-get="/crm/c/${cid}/zoho-nota?r=1" hx-target="#zoho-nota" hx-swap="innerHTML" style="color:var(--accent)">Regenerar</a></div>`;
}

export function tarjetaNotaZoho(convId: string): string {
  const cid = encodeURIComponent(convId);
  return `<div class="crm-card" style="padding:16px;margin-bottom:14px;border-left:4px solid var(--info)">
    <div class="crm-sec">📋 Nota y tarea para Zoho</div>
    <div id="zoho-nota" hx-get="/crm/c/${cid}/zoho-nota" hx-trigger="load" hx-swap="innerHTML"><div class="text-dim" style="font-size:12.5px">Preparando la nota… (unos segundos)</div></div>
  </div>`;
}
