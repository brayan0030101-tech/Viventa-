// member/crm-seguimientos.local.ts — CRM de Viventa: «Seguimientos de hoy».
// Las tareas de seguimiento de Maricela viven en Zoho (módulo Candidatos). Aquí se listan las de hoy y las
// vencidas y, al pulsar «Preparar mensaje», la IA lee la NOTA del candidato (lo que se hizo y en qué quedaron)
// y redacta el mensaje con las reglas de Maricela. FASE 1: solo borradores — no se envía nada ni se cambia
// nada en Zoho. A la IA nunca se le manda el nombre, correo ni teléfono del cliente (se anonimiza).
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { workModel } from "../src/llm/work-model";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, fechaHora } from "./crm.local";
import { anonimizar } from "./crm-ia.local";
import { clavePhone } from "./crm-poragendar.local";
import {
  ZohoError, candidatosPorIds, duenoZoho, notasDe, tareaPorId, tareasPendientes, zohoListo,
  type CandidatoZoho, type FetchFn, type NotaZoho, type TareaZoho,
} from "./crm-zohoapi.local";

const DIA = 86_400_000;
const H = 3_600_000;

export type Temperatura = "caliente" | "tibio" | "frio";
export type Accion = "whatsapp" | "videollamada" | "cerrar";

/** Cuántos días esperar para la siguiente tarea según el interés (reglas de Maricela). */
export const PLAZO_DIAS: Record<Temperatura, [number, number]> = { caliente: [2, 3], tibio: [5, 7], frio: [14, 14] };

export interface Borrador {
  tareaId: string;
  leadId: string;
  temperatura: Temperatura;
  accion: Accion;
  proyectosEnviados: boolean;
  segundoTitular: boolean;
  mensaje: string;
  motivo: string;
  diasSiguiente: number | null;
  razonCierre: "" | "compro" | "no_contactar";
  nota: string;
  creado: number;
  modelo: string;
}

/** Fecha de hoy en España (YYYY-MM-DD): las tareas de Zoho llevan fecha, no hora. */
export function hoyMadrid(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
/** Suma días a una fecha YYYY-MM-DD. */
export function masDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const diasEntre = (desde: string, hasta: string): number => Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / DIA);

async function asegurarTabla(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_seg_borrador (
       tarea_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, creado INTEGER NOT NULL, borrador TEXT NOT NULL, modelo TEXT NOT NULL DEFAULT ''
     )`,
  );
}

// ─── Respuesta de la IA ──────────────────────────────────────────────────────

const TEMPS: Temperatura[] = ["caliente", "tibio", "frio"];

/** Lee y valida el JSON de la IA. Devuelve null si no sirve (sin mensaje, o acción inválida). */
export function leerBorrador(texto: string, base: { tareaId: string; leadId: string; nombre: string; creado: number; modelo: string }): Borrador | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const t = String(j["temperatura"] ?? "").toLowerCase().replace("í", "i").replace("ó", "o");
  const temperatura: Temperatura = (TEMPS as string[]).includes(t) ? (t as Temperatura) : "tibio";
  const accion = String(j["accion"] ?? "").toLowerCase();
  if (accion !== "whatsapp" && accion !== "videollamada" && accion !== "cerrar") return null;
  const primerNombre = base.nombre.split(/\s+/).find((w) => w.replace(/[^\p{L}]/gu, "").length >= 2) ?? "";
  const mensaje = String(j["mensaje"] ?? "")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\[nombre\]/gi, primerNombre)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 700);
  if (accion !== "cerrar" && !mensaje) return null;
  const razon = String(j["razon_cierre"] ?? "");
  const razonCierre = accion === "cerrar" ? (razon === "compro" ? "compro" : "no_contactar") : "";
  // Días hasta la siguiente tarea: el plazo de su temperatura (la IA puede elegir dentro del rango).
  const [min, max] = PLAZO_DIAS[temperatura];
  const pedido = Number(j["dias_siguiente"]);
  const diasSiguiente = accion === "cerrar" ? null : Number.isFinite(pedido) ? Math.min(max, Math.max(min, Math.round(pedido))) : min;
  return {
    tareaId: base.tareaId,
    leadId: base.leadId,
    temperatura,
    accion,
    proyectosEnviados: j["proyectos_enviados"] === true,
    segundoTitular: j["segundo_titular"] === true,
    mensaje,
    motivo: String(j["motivo"] ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    diasSiguiente,
    razonCierre,
    nota: String(j["nota"] ?? "").replace(/\[nombre\]/gi, primerNombre).replace(/\s+/g, " ").trim().slice(0, 600),
    creado: base.creado,
    modelo: base.modelo,
  };
}

const REGLAS = `Eres la asistente de Maricela Naranjo (Viventa, asesoría para comprar vivienda en Colombia desde el exterior). Hoy toca hacerle seguimiento a un candidato. Reglas de Maricela:
1. Lee las NOTAS: son lo que se hizo y en qué quedó el contacto. A partir de ellas decide si el candidato es CALIENTE (muy interesado, avanza), TIBIO (interesado pero lento) o FRÍO (poco interés o sin respuesta). No hay otra clasificación.
2. Si es frío, o todavía no se le han enviado proyectos: escríbele por WhatsApp para saber si sigue interesado. Si YA se le enviaron proyectos: lo mejor es proponerle una videollamada.
3. Si ya tiene perfil financiero y quiere avanzar, pregúntale si quiere seguir con el estudio de financiación. Si los ingresos del candidato son MENOS de 1.250 euros al mes, es muy difícil un crédito hipotecario: recomiéndale con tacto un segundo titular (por ejemplo su pareja o un familiar).
4. El seguimiento termina solo cuando el cliente compró o pidió que no lo contactemos más: en ese caso la acción es "cerrar" y no se escribe mensaje.
5. La siguiente tarea depende del interés: caliente 2 o 3 días, tibio 5 a 7 días, frío 14 días.
Estilo del mensaje: WhatsApp en español, cálido y cercano, 2 a 4 renglones, UNA sola pregunta o propuesta, sin emojis, sin sonar a folleto. Empieza con "Hola [nombre]," (escribe literalmente [nombre]). No inventes datos ni precios, no nombres proyectos ni constructoras, no menciones notas, tareas ni el sistema, y no prometas cosas que no están en las notas.`;

function prompt(c: { tarea: TareaZoho; nombre: string; notas: NotaZoho[]; conversacion: string; ficha: string; hoy: string }): string {
  const notas = c.notas.length
    ? c.notas.map((n, i) => `NOTA ${i + 1}${n.creada ? ` (${n.creada.slice(0, 10)})` : ""}: ${anonimizar(`${n.titulo ? n.titulo + ". " : ""}${n.texto}`, c.nombre).replace(/\s+/g, " ").slice(0, 900)}`).join("\n")
    : "(El candidato no tiene notas.)";
  return `${REGLAS}

Fecha de hoy: ${c.hoy}. Tarea de Zoho: «${anonimizar(c.tarea.asunto, c.nombre)}» (vence ${c.tarea.vence}).
${c.tarea.descripcion ? `Descripción de la tarea: ${anonimizar(c.tarea.descripcion, c.nombre).replace(/\s+/g, " ").slice(0, 400)}\n` : ""}
NOTAS DEL CANDIDATO (la más reciente primero):
${notas}

${c.ficha ? `DATOS QUE EL BOT YA REUNIÓ:\n${c.ficha}\n\n` : ""}${c.conversacion ? `ÚLTIMOS MENSAJES DE LA CONVERSACIÓN (CLIENTE / EQUIPO):\n${c.conversacion}\n\n` : ""}Responde SOLO con un JSON válido, sin texto antes ni después, con esta forma exacta:
{
 "temperatura": "caliente" | "tibio" | "frio",
 "accion": "whatsapp" | "videollamada" | "cerrar",
 "proyectos_enviados": true si las notas dicen que ya se le enviaron proyectos; si no, false,
 "segundo_titular": true si recomiendas un segundo titular por ingresos menores a 1.250 euros; si no, false,
 "mensaje": "el mensaje de WhatsApp listo para enviar (vacío solo si la acción es cerrar)",
 "motivo": "una frase para Maricela: por qué eliges esa acción y esa temperatura",
 "dias_siguiente": número de días para la siguiente tarea (dentro del rango de la temperatura),
 "razon_cierre": "compro" | "no_contactar" (solo si la acción es cerrar; si no, vacío),
 "nota": "la nota para dejar en Zoho tras el contacto: qué se hace ahora y en qué quedamos, en 1 o 2 frases"
}`;
}

// ─── Datos locales del cliente (conversaciones del bot) ──────────────────────

interface Local {
  convId: string;
  canal: string;
  ultimoCliente: number | null;
  ficha: string;
  conversacion: string;
}

const quien = (r: string): string => (r === "user" ? "CLIENTE" : "EQUIPO");

/** Busca la conversación del bot de esta persona por teléfono (últimos 9 dígitos), en WhatsApp o en la ficha. */
export async function localDe(env: Env, telefonos: string[], nombre: string): Promise<Local | null> {
  const db = new Db(env.DB);
  const claves = [...new Set(telefonos.map(clavePhone).filter(Boolean))];
  let conv: { id: string; channel: string } | null = null;
  for (const k of claves) {
    conv = await db.first<{ id: string; channel: string }>("SELECT id, channel FROM conversations WHERE channel = 'ycloud' AND channel_user_id LIKE ? ORDER BY last_message_at DESC LIMIT 1", [`%${k}`]);
    if (conv) break;
    const l = await db.first<{ conversation_id: string }>("SELECT conversation_id FROM leads WHERE contact LIKE ? AND conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", [`%${k}%`]);
    if (l) conv = await db.first<{ id: string; channel: string }>("SELECT id, channel FROM conversations WHERE id = ?", [l.conversation_id]);
    if (conv) break;
  }
  if (!conv) return null;
  const msgs = await db.all<{ role: string; content: string; created_at: number }>(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND role IN ('user','assistant','owner') ORDER BY created_at DESC LIMIT 14",
    [conv.id],
  );
  const ultimoCliente = msgs.find((m) => m.role === "user")?.created_at ?? null;
  const conversacion = [...msgs]
    .reverse()
    .map((m) => `${quien(m.role)}: ${anonimizar(m.content.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " "), nombre).slice(0, 260)}`)
    .join("\n");
  const leads = await db.all<{ metadata: string | null }>("SELECT metadata FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC", [conv.id]);
  const meta: Record<string, string> = {};
  for (const l of leads) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(l.metadata ?? "{}") as Record<string, unknown>)) if (v && typeof v === "string" && !/^(cita|cal|viventa_|crm_)/i.test(k)) meta[k] = v;
    } catch {
      /* metadata rota */
    }
  }
  const ficha = Object.entries(meta).map(([k, v]) => `- ${k}: ${anonimizar(v, nombre)}`).join("\n");
  return { convId: conv.id, canal: conv.channel, ultimoCliente, ficha, conversacion };
}

// ─── Preparar el borrador ────────────────────────────────────────────────────

export async function prepararBorrador(
  env: Env,
  tareaId: string,
  opts: { forzar?: boolean; f?: FetchFn } = {},
  now = Date.now(),
): Promise<{ ok: true; borrador: Borrador; reutilizado: boolean } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  if (!opts.forzar) {
    const g = await db.first<{ lead_id: string; creado: number; borrador: string; modelo: string }>("SELECT lead_id, creado, borrador, modelo FROM crm_seg_borrador WHERE tarea_id = ?", [tareaId]);
    if (g && now - g.creado < 12 * H) {
      try {
        return { ok: true, borrador: { ...(JSON.parse(g.borrador) as Borrador), tareaId, leadId: g.lead_id, creado: g.creado, modelo: g.modelo }, reutilizado: true };
      } catch {
        /* se rehace */
      }
    }
  }
  let tarea: TareaZoho | null;
  let cand: CandidatoZoho | undefined;
  let notas: NotaZoho[];
  try {
    tarea = await tareaPorId(env, tareaId, opts.f, now);
    if (!tarea || !tarea.leadId) return { ok: false, error: "No encontré esa tarea en Zoho (¿ya se completó?)." };
    cand = (await candidatosPorIds(env, [tarea.leadId], opts.f, now)).get(tarea.leadId);
    if (!cand) return { ok: false, error: "Esa tarea no es de un candidato." };
    notas = await notasDe(env, tarea.leadId, 8, opts.f, now);
  } catch (e) {
    console.error("[crm-seguimientos] zoho:", e);
    return { ok: false, error: e instanceof ZohoError ? e.message : "No pude consultar Zoho ahora. Inténtalo en unos minutos." };
  }
  const local = await localDe(env, [cand.movil, cand.telefono], cand.nombre);
  const texto = prompt({ tarea, nombre: cand.nombre, notas, conversacion: local?.conversacion ?? "", ficha: local?.ficha ?? "", hoy: hoyMadrid(now) });
  let modelo = "";
  let b: Borrador | null = null;
  try {
    const llm = await workModel(env, "smart", "insights");
    modelo = llm.modelId;
    const r = await llm.generate({ prompt: texto, maxOutputTokens: 900, temperature: 0.3 } as never);
    b = leerBorrador(String((r as { text?: string }).text ?? ""), { tareaId, leadId: tarea.leadId, nombre: cand.nombre, creado: now, modelo });
  } catch (e) {
    console.error("[crm-seguimientos] IA:", e);
    return { ok: false, error: "No pude consultar a la IA ahora. Inténtalo en unos minutos." };
  }
  if (!b) return { ok: false, error: "La IA no devolvió un mensaje claro. Inténtalo de nuevo." };
  await db.run("INSERT OR REPLACE INTO crm_seg_borrador (tarea_id, lead_id, creado, borrador, modelo) VALUES (?,?,?,?,?)", [tareaId, tarea.leadId, now, JSON.stringify(b), modelo]);
  return { ok: true, borrador: b, reutilizado: false };
}

// ─── Lista de seguimientos ───────────────────────────────────────────────────

export interface FilaSeguimiento {
  tarea: TareaZoho;
  cand: CandidatoZoho;
  atraso: number; // días de atraso (0 = hoy)
  canal: "ycloud" | "zernio" | "";
  ventanaAbierta: boolean;
  borrador: Borrador | null;
}

export async function cargarSeguimientos(env: Env, now = Date.now(), f?: FetchFn): Promise<{ filas: FilaSeguimiento[]; dueno: string }> {
  const hoy = hoyMadrid(now);
  const dueno = await duenoZoho(env, f, now);
  const tareas = await tareasPendientes(env, hoy, f, now);
  const cands = await candidatosPorIds(env, tareas.map((t) => t.leadId), f, now);
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const guardados = await db.all<{ tarea_id: string; borrador: string }>("SELECT tarea_id, borrador FROM crm_seg_borrador WHERE creado > ?", [now - 12 * H]);
  const bor = new Map<string, Borrador>();
  for (const g of guardados) {
    try {
      bor.set(g.tarea_id, JSON.parse(g.borrador) as Borrador);
    } catch {
      /* se ignora */
    }
  }
  const filas: FilaSeguimiento[] = [];
  for (const t of tareas) {
    const cand = cands.get(t.leadId);
    if (!cand) continue; // no es un candidato (p. ej. una tarea de un contacto)
    const claves = [cand.movil, cand.telefono].map(clavePhone).filter(Boolean);
    let canal: FilaSeguimiento["canal"] = "";
    let ventanaAbierta = false;
    if (claves.length) {
      const c = await db.first<{ channel: string; ult: number | null }>(
        `SELECT c.channel AS channel, (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS ult
           FROM conversations c WHERE c.channel = 'ycloud' AND c.channel_user_id LIKE ? ORDER BY c.last_message_at DESC LIMIT 1`,
        [`%${claves[0]}`],
      );
      if (c) {
        canal = "ycloud";
        ventanaAbierta = !!c.ult && now - c.ult < 24 * H;
      }
    }
    filas.push({ tarea: t, cand, atraso: Math.max(0, diasEntre(t.vence, hoy)), canal, ventanaAbierta, borrador: bor.get(t.id) ?? null });
  }
  return { filas, dueno: dueno.nombre };
}

// ─── Vistas ──────────────────────────────────────────────────────────────────

const ETIQ_TEMP: Record<Temperatura, { txt: string; color: string }> = {
  caliente: { txt: "🔥 Caliente", color: "var(--bad)" },
  tibio: { txt: "🌤 Tibio", color: "var(--accent-2)" },
  frio: { txt: "⚪ Frío", color: "var(--info)" },
};
const ETIQ_ACC: Record<Accion, string> = { whatsapp: "💬 Escribir por WhatsApp", videollamada: "📞 Proponer videollamada", cerrar: "🏁 Cerrar el seguimiento" };

const campoCopiable = (id: string, titulo: string, valor: string, filas: number, editable = false): string =>
  `<div style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><b style="font-size:12px;color:var(--cream)">${esc(titulo)}</b>
      <button type="button" class="ghostbtn" style="border:1px solid var(--line);padding:3px 10px;font-size:11px;color:var(--muted);cursor:pointer;background:none;font-family:inherit"
        onclick="var t=document.getElementById('${id}');t.select();try{navigator.clipboard.writeText(t.value)}catch(e){document.execCommand('copy')};this.textContent='✔ Copiado';var b=this;setTimeout(function(){b.textContent='Copiar'},1800)">Copiar</button></div>
    <textarea id="${id}" ${editable ? "" : "readonly"} rows="${filas}" class="crm-in" style="width:100%;resize:vertical;font-size:12.5px;line-height:1.5">${esc(valor)}</textarea></div>`;

export function tarjetaBorrador(b: Borrador, cand: { movil: string; telefono: string }, hoy: string, reutilizado = false): string {
  const t = ETIQ_TEMP[b.temperatura];
  const tel = (cand.movil || cand.telefono).replace(/\D/g, "");
  const sig = b.diasSiguiente != null ? `${masDias(hoy, b.diasSiguiente)} (en ${b.diasSiguiente} día${b.diasSiguiente === 1 ? "" : "s"})` : "no se crea otra: se cierra el seguimiento";
  const id = "sb" + b.tareaId.slice(-8);
  const chips = `<span style="font-weight:600;color:${t.color}">${t.txt}</span> <span class="text-dim">·</span> <b>${ETIQ_ACC[b.accion]}</b>${b.proyectosEnviados ? ` <span class="text-dim">· ya recibió proyectos</span>` : ""}${b.segundoTitular ? ` <span class="text-dim">· sugiere segundo titular</span>` : ""}`;
  const cuerpo =
    b.accion === "cerrar"
      ? `<div class="text-muted" style="font-size:12.5px;margin-bottom:10px">${b.razonCierre === "compro" ? "El cliente ya compró." : "El cliente pidió que no le contactemos más."} No hace falta escribirle.</div>`
      : `${campoCopiable(id + "m", "Mensaje para el cliente (puedes editarlo)", b.mensaje, 5, true)}
         ${tel.length >= 8 ? `<button type="button" class="bigbtn" style="margin-bottom:12px;cursor:pointer" onclick="window.open('https://wa.me/${esc(tel)}?text='+encodeURIComponent(document.getElementById('${id}m').value),'_blank')">💬 Abrir WhatsApp con este mensaje</button>` : ""}`;
  return `<div style="border-top:1px dashed var(--line);margin-top:10px;padding-top:12px">
    <div style="font-size:12.5px;margin-bottom:8px">${chips}</div>
    ${b.motivo ? `<div class="text-dim" style="font-size:12px;margin-bottom:10px">Por qué: ${esc(b.motivo)}</div>` : ""}
    ${cuerpo}
    ${campoCopiable(id + "n", "Nota para dejar en Zoho después de contactarle", b.nota, 2)}
    <div class="text-muted" style="font-size:12px;margin-bottom:8px">Siguiente tarea: <b style="color:var(--cream)">${esc(sig)}</b></div>
    <div class="text-dim" style="font-size:10.5px">Borrador de ${esc(fechaHora(b.creado))} (España)${reutilizado ? " · guardado, sin gastar IA" : ""} · <b>Modo borrador: no se cambió nada en Zoho.</b> ·
      <a href="#" hx-post="/crm/seguimientos/preparar" hx-vals='{"tarea":"${esc(b.tareaId)}","r":"1"}' hx-target="#bor-${esc(b.tareaId)}" hx-swap="innerHTML" style="color:var(--accent)">Regenerar</a></div>
  </div>`;
}

export async function fragmentoBorrador(env: Env, tareaId: string, forzar: boolean, now = Date.now(), f?: FetchFn): Promise<string> {
  const r = await prepararBorrador(env, tareaId, { forzar, f }, now);
  if (!r.ok) {
    return `<div style="color:var(--bad);font-size:12.5px;margin-top:8px">${esc(r.error)}</div>`;
  }
  let cand = { movil: "", telefono: "" };
  try {
    const c = (await candidatosPorIds(env, [r.borrador.leadId], f, now)).get(r.borrador.leadId);
    if (c) cand = { movil: c.movil, telefono: c.telefono };
  } catch {
    /* sin botón de WhatsApp */
  }
  return tarjetaBorrador(r.borrador, cand, hoyMadrid(now), r.reutilizado);
}

export async function renderSeguimientos(env: Env, now = Date.now(), f?: FetchFn): Promise<string> {
  let cuerpo: string;
  if (!zohoListo(env)) {
    cuerpo = `<div class="crm-card" style="padding:28px;text-align:center;color:var(--dim)">Zoho todavía no está conectado.</div>`;
  } else {
    try {
      const { filas, dueno } = await cargarSeguimientos(env, now, f);
      const hoy = hoyMadrid(now);
      const vencidas = filas.filter((x) => x.atraso > 0).length;
      const deHoy = filas.length - vencidas;
      const COLS = "100px minmax(160px,1fr) minmax(160px,1.2fr) 150px 130px";
      const filasHtml = filas
        .map((x) => {
          const atr = x.atraso > 0 ? `<b style="color:var(--bad)">Vencida hace ${x.atraso} día${x.atraso === 1 ? "" : "s"}</b>` : `<b style="color:var(--ok)">Hoy</b>`;
          const canal = x.canal ? (x.ventanaAbierta ? "💬 WhatsApp · escribió hace menos de 24 h" : "💬 WhatsApp · lleva más de 24 h sin escribir") : "📵 Sin conversación con el bot";
          const tel = esc(x.cand.movil || x.cand.telefono || "—");
          return `<div class="crm-row" style="grid-template-columns:${COLS};align-items:start">
            <span style="font-size:12px">${atr}<br><span class="text-dim" style="font-size:10.5px">${esc(x.tarea.vence)}</span></span>
            <span><b style="color:var(--cream)">${esc(x.cand.nombre)}</b><br><span class="text-dim" style="font-size:11px">${tel}${x.cand.pais ? ` · ${esc(x.cand.pais)}` : ""}</span></span>
            <span class="text-muted" style="font-size:12px">${esc(x.tarea.asunto || "Seguimiento")}<br><span class="text-dim" style="font-size:10.5px">${esc(canal)}</span></span>
            <span class="text-dim" style="font-size:11.5px">${x.borrador ? `${ETIQ_TEMP[x.borrador.temperatura].txt}<br>${ETIQ_ACC[x.borrador.accion]}` : "Sin preparar"}</span>
            <span style="text-align:right"><button class="bigbtn" style="cursor:pointer;padding:6px 12px;font-size:12px" hx-post="/crm/seguimientos/preparar" hx-vals='{"tarea":"${esc(x.tarea.id)}"}' hx-target="#bor-${esc(x.tarea.id)}" hx-swap="innerHTML" hx-disabled-elt="this">${x.borrador ? "Ver mensaje" : "Preparar mensaje"}</button></span>
            <div id="bor-${esc(x.tarea.id)}" style="grid-column:1/-1"></div>
          </div>`;
        })
        .join("");
      cuerpo = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
          <div class="crm-kpi"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">Vencidas</div><div style="font-weight:700;font-size:26px;color:var(--bad)">${vencidas}</div></div>
          <div class="crm-kpi"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">Para hoy</div><div style="font-weight:700;font-size:26px">${deHoy}</div></div></div>
        <div class="crm-card"><div style="overflow-x:auto"><div style="min-width:860px">
          <div class="crm-row crm-head" style="grid-template-columns:${COLS}"><span>Vence</span><span>Candidato</span><span>Tarea</span><span>Mensaje</span><span></span></div>
          ${filas.length ? filasHtml : `<div style="padding:44px 18px;text-align:center;color:var(--dim)">No hay tareas vencidas ni para hoy 🎉</div>`}
        </div></div></div>
        <p class="text-dim" style="font-size:11px;margin-top:10px">Tareas de ${esc(dueno || "Maricela")} en Zoho (Candidatos) con fecha de hoy (${esc(hoy)}) o anterior que no están en «Completa». «Preparar mensaje» usa la IA una vez por candidato (unos 0,02 USD) y lee la nota de Zoho; el mensaje queda guardado 12 horas. Por ahora es solo un borrador: tú lo envías y no se cambia nada en Zoho.</p>`;
    } catch (e) {
      console.error("[crm-seguimientos] cargar:", e);
      cuerpo = `<div class="crm-card" style="padding:24px;color:var(--bad)">${e instanceof ZohoError ? esc(e.message) : "No pude leer Zoho ahora. Inténtalo en unos minutos."}</div>`;
    }
  }
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Las tareas de seguimiento de Zoho que toca hacer hoy o que ya se pasaron. Pulsa <b style="color:var(--cream)">Preparar mensaje</b> y la IA lee la nota del candidato y te propone qué escribirle (o si ya toca cerrar el seguimiento).</div>
    ${cuerpo}`;
  return crmLayout({ title: "Seguimientos", activa: "seguimientos", body, env });
}
