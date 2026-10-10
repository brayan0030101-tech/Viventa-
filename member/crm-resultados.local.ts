// member/crm-resultados.local.ts — CRM de Viventa: resultado de cada videollamada.
// Maricela pega (o sube) la transcripción de la llamada; la IA la interpreta: qué pasó,
// qué se concretó, qué no, objeciones, interés, cierre y pendientes (que quedan como tareas).
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { workModel } from "../src/llm/work-model";
import { esc, fechaHora } from "./crm.local";
import { anonimizar } from "./crm-ia.local";

const MAX_TRANSCRIPCION = 60_000;

export type ResultadoLlamada = "concretado" | "parcial" | "no_concretado" | "sin_respuesta";

export interface Pendiente {
  id: string;
  convId: string;
  leadId: string;
  texto: string;
  responsable: string;
  cuando: string;
  hecho: boolean;
  creado: number;
}

export interface AnalisisLlamada {
  resultado: ResultadoLlamada;
  resumen: string;
  concretado: string[];
  noConcretado: string[];
  objeciones: string[];
  interes: number;
  proximoPaso: string;
  pendientes: Array<{ tarea: string; responsable: string; cuando: string }>;
}

export interface ResultadoGuardado {
  id: string;
  leadId: string;
  convId: string;
  creado: number;
  analisis: AnalisisLlamada;
  modelo: string;
  chars: number;
}

export async function asegurarTablas(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_llamada_resultado (
       id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, creado INTEGER NOT NULL,
       transcripcion TEXT NOT NULL, analisis TEXT NOT NULL, modelo TEXT NOT NULL DEFAULT ''
     )`,
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_crm_llres_lead ON crm_llamada_resultado(lead_id, creado)");
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_pendientes (
       id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, lead_id TEXT NOT NULL, texto TEXT NOT NULL,
       responsable TEXT NOT NULL DEFAULT '', cuando TEXT NOT NULL DEFAULT '', hecho INTEGER NOT NULL DEFAULT 0,
       creado INTEGER NOT NULL, hecho_en INTEGER
     )`,
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_crm_pend_conv ON crm_pendientes(conversation_id, hecho)");
}

// ─── Limpieza de la transcripción ────────────────────────────────────────────

/** Quita de un .vtt / .srt las cabeceras, números y horas, dejando solo lo que se dijo. */
export function limpiarTranscripcion(raw: string): string {
  const lineas = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^WEBVTT/i.test(l) && !/^\d+$/.test(l) && !/-->/.test(l) && !/^NOTE\b/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, ""));
  // Une líneas consecutivas del mismo bloque si el archivo venía en formato de subtítulos.
  return lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Lectura segura de la respuesta de la IA ────────────────────────────────

const texto = (v: unknown, max = 400): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const lista = (v: unknown, n = 8): string[] => (Array.isArray(v) ? v.map((x) => texto(x)).filter(Boolean).slice(0, n) : []);

export function leerAnalisis(raw: string): AnalisisLlamada | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const res = texto(j["resultado"], 20).toLowerCase();
  const resultado: ResultadoLlamada = res === "concretado" || res === "parcial" || res === "sin_respuesta" ? res : "no_concretado";
  const resumen = texto(j["resumen"], 1500);
  if (!resumen) return null;
  const pend = Array.isArray(j["pendientes"]) ? (j["pendientes"] as unknown[]) : [];
  return {
    resultado,
    resumen,
    concretado: lista(j["concretado"]),
    noConcretado: lista(j["no_concretado"]),
    objeciones: lista(j["objeciones"]),
    interes: Math.min(5, Math.max(1, Math.round(Number(j["interes"]) || 3))),
    proximoPaso: texto(j["proximo_paso"], 400),
    pendientes: pend
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return { tarea: texto(o["tarea"], 300), responsable: texto(o["responsable"], 40), cuando: texto(o["cuando"], 60) };
      })
      .filter((p) => p.tarea)
      .slice(0, 10),
  };
}

// ─── Análisis ────────────────────────────────────────────────────────────────

export async function analizarLlamada(
  env: Env,
  leadId: string,
  transcripcionRaw: string,
  now = Date.now(),
): Promise<{ ok: true; resultado: ResultadoGuardado } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  await asegurarTablas(db);
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const ll = (await cargarLlamadas(env, now)).find((x) => x.id === leadId);
  if (!ll) return { ok: false, error: "No encontré esa llamada." };
  const trans = limpiarTranscripcion(transcripcionRaw).slice(0, MAX_TRANSCRIPCION);
  if (trans.length < 200) return { ok: false, error: "La transcripción es muy corta. Pega la conversación completa de la llamada." };

  const limpia = anonimizar(trans, ll.nombre);
  const prompt = `Viventa (Maricela Naranjo) ayuda a colombianos en el exterior a comprar vivienda en Colombia. Esta es la transcripción de una videollamada de unos 30 minutos entre Maricela y un cliente (el nombre y los datos de contacto fueron reemplazados por [nombre], [correo], [teléfono]).

TRANSCRIPCIÓN:
${limpia}

Interpreta la llamada para Maricela (no es técnica). No inventes nada que no se haya dicho; si algo no quedó claro, déjalo vacío. Responde SOLO con un JSON válido, sin texto antes ni después, con esta forma exacta:
{
 "resultado": "concretado" | "parcial" | "no_concretado" | "sin_respuesta",
 "resumen": "4 a 6 frases: qué pasó en la llamada y cómo terminó",
 "concretado": ["lo que se acordó o decidió"],
 "no_concretado": ["lo que quedó sin decidir o sin resolver"],
 "objeciones": ["dudas o frenos del cliente"],
 "interes": 1 a 5 (5 = quiere avanzar ya),
 "proximo_paso": "la siguiente acción concreta",
 "pendientes": [{"tarea": "qué hay que hacer", "responsable": "Maricela" | "Cliente" | "Equipo", "cuando": "fecha o plazo si se dijo, si no vacío"}]
}
«concretado» = se cerró algo claro (reserva, envío de documentos, siguiente cita). «parcial» = hubo avance pero falta algo. «no_concretado» = no se acordó nada. «sin_respuesta» = el cliente no se presentó o la llamada no avanzó.`;

  let analisis: AnalisisLlamada | null = null;
  let modelo = "";
  try {
    const llm = await workModel(env, "smart", "insights");
    modelo = llm.modelId;
    const r = await llm.generate({ prompt, maxOutputTokens: 1600, temperature: 0.2 } as never);
    analisis = leerAnalisis(String((r as { text?: string }).text ?? ""));
  } catch (e) {
    console.error("[crm-resultados] analizarLlamada:", e);
    return { ok: false, error: "No pude consultar a la IA ahora. Inténtalo en unos minutos." };
  }
  if (!analisis) return { ok: false, error: "La IA no devolvió un resultado claro. Inténtalo de nuevo." };

  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO crm_llamada_resultado (id, lead_id, conversation_id, creado, transcripcion, analisis, modelo) VALUES (?,?,?,?,?,?,?)",
    [id, leadId, ll.convId, now, trans, JSON.stringify(analisis), modelo],
  );
  // Si se vuelve a analizar la misma llamada, los pendientes anteriores sin hacer se reemplazan.
  await db.run("DELETE FROM crm_pendientes WHERE lead_id = ? AND hecho = 0", [leadId]);
  for (const p of analisis.pendientes) {
    await db.run("INSERT INTO crm_pendientes (id, conversation_id, lead_id, texto, responsable, cuando, creado) VALUES (?,?,?,?,?,?,?)", [
      crypto.randomUUID(), ll.convId, leadId, p.tarea, p.responsable, p.cuando, now,
    ]);
  }
  try {
    await (await import("./crm-pipeline.local")).avanzarPorResultado(env, ll.convId, analisis.resultado);
  } catch (e) {
    console.error("[crm-resultados] avanzar etapa:", e);
  }
  return { ok: true, resultado: { id, leadId, convId: ll.convId, creado: now, analisis, modelo, chars: trans.length } };
}

export async function ultimoResultado(env: Env, leadId: string): Promise<ResultadoGuardado | null> {
  const db = new Db(env.DB);
  await asegurarTablas(db);
  const r = await db.first<{ id: string; lead_id: string; conversation_id: string; creado: number; analisis: string; modelo: string; n: number }>(
    "SELECT id, lead_id, conversation_id, creado, analisis, modelo, length(transcripcion) AS n FROM crm_llamada_resultado WHERE lead_id = ? ORDER BY creado DESC LIMIT 1",
    [leadId],
  );
  if (!r) return null;
  const a = leerAnalisis(r.analisis);
  return a ? { id: r.id, leadId: r.lead_id, convId: r.conversation_id, creado: r.creado, analisis: a, modelo: r.modelo, chars: r.n } : null;
}

export async function pendientesDe(env: Env, filtro: { leadId?: string; convId?: string }): Promise<Pendiente[]> {
  const db = new Db(env.DB);
  await asegurarTablas(db);
  const rs = await db.all<{ id: string; conversation_id: string; lead_id: string; texto: string; responsable: string; cuando: string; hecho: number; creado: number }>(
    `SELECT id, conversation_id, lead_id, texto, responsable, cuando, hecho, creado FROM crm_pendientes WHERE ${filtro.leadId ? "lead_id" : "conversation_id"} = ? ORDER BY hecho ASC, creado DESC LIMIT 40`,
    [filtro.leadId ?? filtro.convId ?? ""],
  );
  return rs.map((r) => ({ id: r.id, convId: r.conversation_id, leadId: r.lead_id, texto: r.texto, responsable: r.responsable, cuando: r.cuando, hecho: !!r.hecho, creado: r.creado }));
}

export async function alternarPendiente(env: Env, id: string, now = Date.now()): Promise<Pendiente | null> {
  const db = new Db(env.DB);
  await asegurarTablas(db);
  await db.run("UPDATE crm_pendientes SET hecho = 1 - hecho, hecho_en = CASE WHEN hecho = 0 THEN ? ELSE NULL END WHERE id = ?", [now, id]);
  const r = await db.first<{ conversation_id: string }>("SELECT conversation_id FROM crm_pendientes WHERE id = ?", [id]);
  if (!r) return null;
  return (await pendientesDe(env, { convId: r.conversation_id })).find((p) => p.id === id) ?? null;
}

// ─── Vistas ──────────────────────────────────────────────────────────────────

const ETIQ_RESULTADO: Record<ResultadoLlamada, { txt: string; color: string }> = {
  concretado: { txt: "✅ Se concretó", color: "var(--ok)" },
  parcial: { txt: "🟡 Avance parcial", color: "#E09A00" },
  no_concretado: { txt: "⚪ No se concretó", color: "var(--dim)" },
  sin_respuesta: { txt: "🚫 Sin respuesta / no asistió", color: "var(--bad)" },
};

export function filaPendiente(p: Pendiente): string {
  const meta = [p.responsable, p.cuando].filter(Boolean).map(esc).join(" · ");
  return `<li id="pend-${esc(p.id)}" style="list-style:none;display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed var(--line)">
    <input type="checkbox" ${p.hecho ? "checked" : ""} hx-post="/crm/pendiente/${esc(p.id)}" hx-target="#pend-${esc(p.id)}" hx-swap="outerHTML" style="margin-top:3px;accent-color:var(--accent);cursor:pointer">
    <div style="font-size:12.5px;${p.hecho ? "text-decoration:line-through;color:var(--dim)" : "color:var(--cream)"}">${esc(p.texto)}${meta ? `<div class="text-dim" style="font-size:11px">${meta}</div>` : ""}</div>
  </li>`;
}

export function listaPendientes(ps: Pendiente[]): string {
  if (!ps.length) return `<div class="text-dim" style="font-size:12.5px">No hay pendientes.</div>`;
  return `<ul style="margin:0;padding:0">${ps.map(filaPendiente).join("")}</ul>`;
}

const bullets = (items: string[], vacio: string) =>
  items.length
    ? `<ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6;color:var(--cream)">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : `<div class="text-dim" style="font-size:12px;margin-top:4px">${vacio}</div>`;

/** Sección «Resultado de la llamada» para la ventana de la llamada. */
export async function seccionResultado(env: Env, leadId: string, opts: { error?: string } = {}): Promise<string> {
  const res = await ultimoResultado(env, leadId);
  const lid = encodeURIComponent(leadId);
  const form = `<form hx-post="/crm/llamada/${lid}/transcripcion" hx-target="#modal-root" hx-swap="innerHTML" hx-encoding="multipart/form-data" hx-disabled-elt="find button">
      <textarea name="transcripcion" rows="${res ? 4 : 7}" class="crm-in" style="width:100%;resize:vertical" placeholder="Pega aquí la transcripción de la llamada (o sube el archivo de abajo)…"></textarea>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px">
        <input type="file" name="archivo" accept=".txt,.vtt,.srt,.md,text/plain" style="font-size:11.5px;color:var(--muted)">
        <button class="bigbtn" style="background:var(--accent);color:var(--bg);padding:8px 14px;font-size:12px;font-weight:700;border:0;cursor:pointer">${res ? "Analizar de nuevo" : "🧠 Interpretar la llamada"}</button>
        <span class="htmx-indicator text-dim" style="font-size:11.5px">Analizando… unos 20 segundos</span>
      </div>
    </form>`;
  if (!res) {
    return `<div class="crm-sec">📝 Resultado de la llamada</div>
      ${opts.error ? `<div style="color:var(--bad);font-size:12.5px;margin-bottom:8px">${esc(opts.error)}</div>` : ""}
      <div class="text-dim" style="font-size:12.5px;margin-bottom:8px">Después de la llamada, pega la transcripción. La IA resume lo que pasó, lo que se concretó y lo que quedó pendiente.</div>${form}`;
  }
  const a = res.analisis;
  const e = ETIQ_RESULTADO[a.resultado];
  const pend = await pendientesDe(env, { leadId });
  return `<div class="crm-sec">📝 Resultado de la llamada</div>
    ${opts.error ? `<div style="color:var(--bad);font-size:12.5px;margin-bottom:8px">${esc(opts.error)}</div>` : ""}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-weight:700;font-size:14px;color:${e.color}">${e.txt}</span>
      <span style="font-size:12px;color:var(--muted)">Interés del cliente: <b style="color:var(--cream)">${"●".repeat(a.interes)}${"○".repeat(5 - a.interes)}</b> ${a.interes}/5</span>
    </div>
    <p style="font-size:13px;line-height:1.6;color:var(--muted);margin:0 0 10px">${esc(a.resumen)}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div><b style="font-size:12px;color:var(--ok)">Se concretó</b>${bullets(a.concretado, "Nada quedó cerrado.")}</div>
      <div><b style="font-size:12px;color:var(--bad)">No se concretó</b>${bullets(a.noConcretado, "—")}</div>
    </div>
    <div style="margin-top:10px"><b style="font-size:12px;color:var(--info)">Dudas y objeciones</b>${bullets(a.objeciones, "No hubo objeciones claras.")}</div>
    ${a.proximoPaso ? `<div style="margin-top:10px;font-size:12.5px"><b style="color:var(--accent)">Próximo paso:</b> <span style="color:var(--cream)">${esc(a.proximoPaso)}</span></div>` : ""}
    <div style="margin-top:12px"><b style="font-size:12px;color:var(--accent)">Pendientes</b><div style="margin-top:4px">${listaPendientes(pend)}</div></div>
    <div class="text-dim" style="font-size:10.5px;margin:10px 0">Analizado ${esc(fechaHora(res.creado))} (España) · ${res.chars.toLocaleString("es-ES")} caracteres leídos · ${esc(res.modelo)}</div>
    <details><summary style="cursor:pointer;font-size:12px;color:var(--muted)">Cargar otra transcripción</summary><div style="margin-top:8px">${form}</div></details>`;
}

/** Tarjeta para la ficha del cliente: pendientes abiertos y resultado de sus llamadas. */
export async function tarjetaPendientes(env: Env, convId: string): Promise<string> {
  const ps = await pendientesDe(env, { convId });
  if (!ps.length) return "";
  const abiertos = ps.filter((p) => !p.hecho).length;
  return `<div class="crm-card" style="padding:16px;margin-bottom:14px;border-left:4px solid var(--accent)">
    <div class="crm-sec">📌 Pendientes de la llamada (${abiertos} por hacer)</div>${listaPendientes(ps)}</div>`;
}
