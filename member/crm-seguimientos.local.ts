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
import { SettingsRepo } from "../src/db/settings";
import {
  ZohoError, ESTADOS_HECHOS, candidatosPorIds, completarTarea, crearNota, crearTarea, duenoZoho, notasDe,
  tareaPorId, tareasPendientes, zohoListo,
  type CandidatoZoho, type FetchFn, type NotaZoho, type TareaZoho,
} from "./crm-zohoapi.local";

const DIA = 86_400_000;
const H = 3_600_000;

export type Temperatura = "caliente" | "tibio" | "frio";
export type Accion = "whatsapp" | "videollamada" | "futuro" | "perdido" | "descartado";
/** «Cliente perdido» y «Descartado» son estados de Zoho que piden un MOTIVO, no dejan tarea y solo dejan nota (Maricela, 14 oct 2026). */
export const esCierre = (a: string): boolean => a === "perdido" || a === "descartado";

/** Motivos que ofrece Zoho al pasar a cada estado. Los valores son EXACTOS como los guarda Zoho en el campo `motivo` (picklist del módulo
 *  Candidatos, leída por la API el 14 oct 2026; p. ej. «Desistio compra» va sin tilde). */
export const MOTIVOS_PERDIDO = ["Proceso con otro broker", "Precio muy alto", "No le gustaron proyectos", "No cumple perfil", "No interesado", "Paga de contado", "Desistio compra", "Nunca me respondió"];
export const MOTIVOS_DESCARTADO = ["No es colombiano", "No quiere ser contactado", "Sin datos de contacto", "Interesado en otro país", "Número errado", "Reside y tiene ingresos en Colombia"];
/** Nombre del campo de motivo en Zoho (el mismo para los dos estados; se puede cambiar con los ajustes zoho_campo_motivo_*). */
export const CAMPO_MOTIVO = "motivo";
export const ESTADOS_CIERRE: Record<"perdido" | "descartado", string> = { perdido: "Cliente perdido", descartado: "Descartado" };

/** Cuántos días esperar para la siguiente tarea según el interés (reglas de Maricela). */
export const PLAZO_DIAS: Record<Temperatura, [number, number]> = { caliente: [2, 3], tibio: [5, 7], frio: [14, 14] };
/** Candidato con más de 3 intentos de contacto sin respuesta: pasa a «Revisar en el futuro». Zoho mismo crea la tarea de
 *  dentro de 3 meses al cambiar ese estado (confirmado por Maricela), así que aquí NO se crea otra. */
export const ESTADO_FUTURO = "Revisar en el futuro";

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
  /** Motivo de «Cliente perdido» / «Descartado» (uno de los de Zoho); vacío en las demás acciones. */
  motivoCierre: string;
  nota: string;
  /** Asunto de la siguiente tarea en Zoho (lo que hay que hacer la próxima vez). */
  tareaSiguiente: string;
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

// ─── Fase 2: actualizar Zoho ─────────────────────────────────────────────────

/** Interruptor de seguridad: Zoho solo se modifica con el ajuste `zoho_escritura = activo`. */
export async function escrituraActiva(env: Env): Promise<boolean> {
  return (((await new SettingsRepo(new Db(env.DB)).get("zoho_escritura")) ?? "").trim().toLowerCase()) === "activo";
}

async function asegurarTablaHecho(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_seg_hecho (
       tarea_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, creado INTEGER NOT NULL, completo INTEGER NOT NULL DEFAULT 0, pasos TEXT NOT NULL DEFAULT '{}'
     )`,
  );
}

export interface PasosHechos {
  nota?: string;
  tarea?: string;
  completada?: boolean;
  estado?: boolean;
}

export type ResultadoZoho =
  | { ok: true; pasos: PasosHechos; yaHecho: boolean; siguiente: { asunto: string; fecha: string } | null; aviso?: string; manual?: { estado: string; motivo: string; nota: string; notaGuardada: boolean } }
  | { ok: false; error: string; pasos: PasosHechos };

/**
 * «Ya lo envié»: deja Zoho al día para ESA tarea. Orden (si algo falla, lo ya hecho NO se repite al reintentar):
 *  1) nota en el candidato · 2) siguiente tarea «En Proceso» · 3) completa la tarea de hoy · 4) estado (solo «futuro»).
 * La acción, el candidato y los días salen del borrador guardado en el servidor, no de lo que mande el navegador.
 */
export async function aplicarEnZoho(
  env: Env,
  tareaId: string,
  entrada: { nota: string; tareaSiguiente: string; motivo?: string },
  opts: { f?: FetchFn } = {},
  now = Date.now(),
): Promise<ResultadoZoho> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  await asegurarTablaHecho(db);
  if (!(await escrituraActiva(env))) return { ok: false, error: "Zoho está en modo solo lectura. Avísale a Brayan para activar la escritura.", pasos: {} };
  const g = await db.first<{ lead_id: string; borrador: string }>("SELECT lead_id, borrador FROM crm_seg_borrador WHERE tarea_id = ?", [tareaId]);
  if (!g) return { ok: false, error: "Primero prepara el mensaje de esta tarea.", pasos: {} };
  let b: Borrador;
  try {
    b = JSON.parse(g.borrador) as Borrador;
  } catch {
    return { ok: false, error: "El borrador guardado no se pudo leer. Regenéralo.", pasos: {} };
  }
  const motivo = esCierre(b.accion) ? ((b.accion === "perdido" ? MOTIVOS_PERDIDO : MOTIVOS_DESCARTADO).find((m) => m === entrada.motivo) ?? b.motivoCierre) : "";
  const previo = await db.first<{ completo: number; pasos: string }>("SELECT completo, pasos FROM crm_seg_hecho WHERE tarea_id = ?", [tareaId]);
  const pasos: PasosHechos = previo ? (JSON.parse(previo.pasos) as PasosHechos) : {};
  if (previo?.completo) return { ok: true, pasos, yaHecho: true, siguiente: null };

  const hoy = hoyMadrid(now);
  const nota = entrada.nota.replace(/\s+/g, " ").trim().slice(0, 1500) || b.nota;
  const asunto = (entrada.tareaSiguiente || b.tareaSiguiente || "Seguimiento WhatsApp").replace(/\s+/g, " ").trim().slice(0, 160);
  const fechaSig = b.diasSiguiente != null ? masDias(hoy, b.diasSiguiente) : "";
  const guardar = async (completo: boolean) =>
    db.run("INSERT OR REPLACE INTO crm_seg_hecho (tarea_id, lead_id, creado, completo, pasos) VALUES (?,?,?,?,?)", [tareaId, g.lead_id, now, completo ? 1 : 0, JSON.stringify(pasos)]);

  try {
    // La tarea debe seguir pendiente y ser de este candidato (si alguien ya la completó en Zoho, no se duplica nada).
    const t = await tareaPorId(env, tareaId, opts.f, now);
    if (!t) return { ok: false, error: "No encontré esa tarea en Zoho.", pasos };
    if (t.leadId !== g.lead_id) return { ok: false, error: "La tarea no corresponde a ese candidato. Regenera el borrador.", pasos };
    if (ESTADOS_HECHOS.includes(t.estado) && !pasos.nota && !pasos.tarea) {
      pasos.completada = true;
      await guardar(true);
      return { ok: true, pasos, yaHecho: true, siguiente: null, aviso: "Esa tarea ya estaba completa en Zoho: no cambié nada." };
    }
    // «Revisar en el futuro», «Cliente perdido» y «Descartado» son TRANSICIONES de Zoho (ventana propia con motivo): escribir el campo por
    // la API no cambia el estado (Maricela lo comprobó el 14 oct). Mientras no se conecte la transición, el estado lo cambia ella. La ventana
    // de «Revisar en el futuro» trae su propia caja de NOTA (ahí va la nota); las de «Cliente perdido»/«Descartado» solo piden el motivo
    // (la nota la deja el sistema).
    const esTransicion = b.accion === "futuro" || esCierre(b.accion);
    const notaEnVentana = b.accion === "futuro";
    if (!notaEnVentana && !pasos.nota && nota) {
      pasos.nota = (await crearNota(env, g.lead_id, nota, opts.f, now)) || "ok";
      await guardar(false);
    }
    if (!pasos.tarea && b.diasSiguiente != null && !esCierre(b.accion) && b.accion !== "futuro") {
      const dueno = await duenoZoho(env, opts.f, now);
      pasos.tarea = (await crearTarea(env, { leadId: g.lead_id, asunto, fecha: fechaSig, ownerId: dueno.id }, opts.f, now)) || "ok";
      await guardar(false);
    }
    if (!pasos.completada) {
      await completarTarea(env, tareaId, opts.f, now);
      pasos.completada = true;
      await guardar(false);
    }
    await guardar(true);
    return {
      ok: true, pasos, yaHecho: false, siguiente: pasos.tarea ? { asunto, fecha: fechaSig } : null,
      ...(esTransicion ? { manual: { estado: b.accion === "futuro" ? ESTADO_FUTURO : ESTADOS_CIERRE[b.accion as "perdido" | "descartado"], motivo, nota, notaGuardada: !notaEnVentana } } : {}),
    };
  } catch (e) {
    console.error("[crm-seguimientos] aplicarEnZoho:", e);
    await guardar(false).catch(() => undefined);
    return { ok: false, error: `${e instanceof ZohoError ? e.message : "No pude actualizar Zoho."} Lo que ya se hizo no se repite si vuelves a intentar.`, pasos };
  }
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
  if (accion !== "whatsapp" && accion !== "videollamada" && accion !== "futuro" && accion !== "perdido" && accion !== "descartado") return null;
  const primerNombre = base.nombre.split(/\s+/).find((w) => w.replace(/[^\p{L}]/gu, "").length >= 2) ?? "";
  const mensajeCrudo = String(j["mensaje"] ?? "");
  const mensaje = (accion === "descartado" ? "" : mensajeCrudo)
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\[nombre\]/gi, primerNombre)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 700);
  // «futuro» y «perdido» llevan un último mensaje amable (opcional); solo «descartado» no escribe.
  if (accion !== "futuro" && accion !== "perdido" && accion !== "descartado" && !mensaje) return null;
  // El motivo debe ser uno de los de Zoho para ese estado; si la IA inventa otro, queda el más neutro de la lista.
  const lista = accion === "perdido" ? MOTIVOS_PERDIDO : accion === "descartado" ? MOTIVOS_DESCARTADO : [];
  const pedidoMotivo = String(j["motivo_cierre"] ?? "").trim().toLowerCase();
  const motivoCierre = lista.length ? (lista.find((m) => m.toLowerCase() === pedidoMotivo) ?? (accion === "perdido" ? "No interesado" : "No quiere ser contactado")) : "";
  // Días hasta la siguiente tarea: el plazo de su temperatura (la IA puede elegir dentro del rango).
  const [min, max] = PLAZO_DIAS[temperatura];
  const pedido = Number(j["dias_siguiente"]);
  const diasSiguiente = esCierre(accion) || accion === "futuro" ? null : Number.isFinite(pedido) ? Math.min(max, Math.max(min, Math.round(pedido))) : min;
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
    motivoCierre,
    nota: String(j["nota"] ?? "").replace(/\[nombre\]/gi, primerNombre).replace(/\s+/g, " ").trim().slice(0, 600),
    tareaSiguiente: esCierre(accion) || accion === "futuro" ? "" : String(j["tarea_siguiente"] ?? "").replace(/\[nombre\]/gi, primerNombre).replace(/\s+/g, " ").trim().slice(0, 160),
    creado: base.creado,
    modelo: base.modelo,
  };
}

const REGLAS = `Eres la asistente de Maricela Naranjo (Viventa, asesoría para comprar vivienda en Colombia desde el exterior). Hoy toca hacerle seguimiento a un candidato. Reglas de Maricela:
1. Lee las NOTAS: son lo que se hizo y en qué quedó el contacto. A partir de ellas decide si el candidato es CALIENTE (muy interesado, avanza), TIBIO (interesado pero lento) o FRÍO (poco interés o sin respuesta). No hay otra clasificación.
2. Si es frío, o todavía no se le han enviado proyectos: escríbele por WhatsApp para saber si sigue interesado. Si YA se le enviaron proyectos: lo mejor es proponerle una videollamada.
3. Si ya tiene perfil financiero y quiere avanzar, pregúntale si quiere seguir con el estudio de financiación. Si los ingresos del candidato son MENOS de 1.250 euros al mes, es muy difícil un crédito hipotecario: recomiéndale con tacto un segundo titular (por ejemplo su pareja o un familiar).
4. El seguimiento termina solo cuando el cliente compró, pidió que no lo contactemos más o ya no quiere comprar: en ese caso NO se deja otra tarea, solo una nota, y el candidato pasa a uno de dos estados de Zoho, cada uno con su MOTIVO:
   - "descartado": no es trabajable y no se debe insistir ni reactivar. Aquí NO se escribe mensaje. Motivos: ${MOTIVOS_DESCARTADO.join(" | ")}.
   - "perdido" (Cliente perdido): conoció la propuesta de Viventa y no se decide por nosotros, o los datos son correctos pero nunca contestó. Aquí SÍ se escribe un ÚLTIMO mensaje breve y cálido que deje la puerta abierta por si más adelante quiere retomar (sin presionar, sin pedir respuesta). Motivos: ${MOTIVOS_PERDIDO.join(" | ")}.
   Elige el motivo que mejor encaje con lo que dicen las notas y escríbelo exactamente igual que en la lista.
4b. Si en las notas se ven MÁS DE 3 intentos de contacto (llamadas o WhatsApp) sin que el cliente haya respondido, la acción es "futuro": el candidato pasa al estado «Revisar en el futuro». En ese caso el mensaje es un último mensaje breve y amable, sin presionar (por ejemplo, que no le llenamos de mensajes y que cuando quiera retomar aquí estamos), y NO se escribe siguiente tarea: Zoho la crea solo a los 3 meses al cambiar ese estado.
5. La siguiente tarea depende del interés: caliente 2 o 3 días, tibio 5 a 7 días, frío 14 días.
6. LA TAREA DE HOY MANDA: el asunto de la tarea (y su descripción) dice exactamente qué hay que hacer hoy con este candidato, y el mensaje debe lograr ESO. Ejemplo: si la tarea es «Confirmar si desea agendar la videollamada», el mensaje pregunta justo eso; si es «Preguntar si revisó los proyectos», pregunta si los revisó. Solo si la tarea es genérica («Seguimiento WhatsApp», «Seguimiento») decides tú según las notas y las reglas anteriores.
7. Además del mensaje, escribe el asunto de la SIGUIENTE tarea que se dejará en Zoho: una frase corta y concreta con lo que habrá que hacer la próxima vez (por ejemplo «Confirmar si desea agendar la videollamada»), según en qué quede este contacto.
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
 "accion": "whatsapp" | "videollamada" | "futuro" | "perdido" | "descartado",
 "proyectos_enviados": true si las notas dicen que ya se le enviaron proyectos; si no, false,
 "segundo_titular": true si recomiendas un segundo titular por ingresos menores a 1.250 euros; si no, false,
 "mensaje": "el mensaje de WhatsApp listo para enviar (vacío solo si la acción es descartado; en futuro y perdido es un último mensaje amable que deja la puerta abierta)",
 "motivo": "una frase para Maricela: por qué eliges esa acción y esa temperatura",
 "dias_siguiente": número de días para la siguiente tarea (dentro del rango de la temperatura),
 "motivo_cierre": "uno de los motivos de la lista, solo si la acción es perdido o descartado; si no, vacío",
 "nota": "la nota para dejar en Zoho tras el contacto: qué se hace ahora y en qué quedamos, en 1 o 2 frases",
 "tarea_siguiente": "asunto corto de la siguiente tarea de Zoho (vacío si la acción es futuro, perdido o descartado)"
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
        const viejo = JSON.parse(g.borrador) as Borrador;
        // Los borradores anteriores a «siguiente tarea» (14 oct 2026) se rehacen para que la traigan.
        if (typeof viejo.tareaSiguiente === "string" && typeof viejo.motivoCierre === "string") return { ok: true, borrador: { ...viejo, tareaId, leadId: g.lead_id, creado: g.creado, modelo: g.modelo }, reutilizado: true };
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
    // Con 900 tokens de tope Sonnet 5.5 gastaba todo razonando y la respuesta llegaba cortada (13 oct 2026).
    const r = await llm.generate({ prompt: texto, maxOutputTokens: 4000, temperature: 0.3 } as never);
    const crudo = String((r as { text?: string }).text ?? "");
    b = leerBorrador(crudo, { tareaId, leadId: tarea.leadId, nombre: cand.nombre, creado: now, modelo });
    if (!b) console.error(`[crm-seguimientos] respuesta sin JSON válido (${crudo.length} caracteres): ${crudo.slice(0, 200)}`);
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
const ETIQ_ACC: Record<Accion, string> = { whatsapp: "💬 Escribir por WhatsApp", videollamada: "📞 Proponer videollamada", perdido: "🏁 Pasar a «Cliente perdido»", descartado: "🚫 Pasar a «Descartado»", futuro: `🗓 Pasar a «${ESTADO_FUTURO}»` };

const campoCopiable = (id: string, titulo: string, valor: string, filas: number, editable = false, nombre = ""): string =>
  `<div style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><b style="font-size:12px;color:var(--cream)">${esc(titulo)}</b>
      <button type="button" class="ghostbtn" style="border:1px solid var(--line);padding:3px 10px;font-size:11px;color:var(--muted);cursor:pointer;background:none;font-family:inherit"
        onclick="var t=document.getElementById('${id}');t.select();try{navigator.clipboard.writeText(t.value)}catch(e){document.execCommand('copy')};this.textContent='✔ Copiado';var b=this;setTimeout(function(){b.textContent='Copiar'},1800)">Copiar</button></div>
    <textarea id="${id}" ${nombre ? `name="${nombre}"` : ""} ${editable ? "" : "readonly"} rows="${filas}" class="crm-in" style="width:100%;resize:vertical;font-size:12.5px;line-height:1.5">${esc(valor)}</textarea></div>`;

export function tarjetaBorrador(b: Borrador, cand: { movil: string; telefono: string; convId?: string }, hoy: string, reutilizado = false, escritura = false): string {
  const t = ETIQ_TEMP[b.temperatura];
  const tel = (cand.movil || cand.telefono).replace(/\D/g, "");
  const sig = b.diasSiguiente != null ? `${masDias(hoy, b.diasSiguiente)} (en ${b.diasSiguiente} día${b.diasSiguiente === 1 ? "" : "s"})` : esCierre(b.accion) ? "ninguna: en este estado solo se deja la nota" : b.accion === "futuro" ? `no hace falta crearla: Zoho la programa solo a los 3 meses al pasar a «${ESTADO_FUTURO}»` : "no se crea otra: se cierra el seguimiento";
  const id = "sb" + b.tareaId.slice(-8);
  const chips = `<span style="font-weight:600;color:${t.color}">${t.txt}</span> <span class="text-dim">·</span> <b>${ETIQ_ACC[b.accion]}</b>${b.proyectosEnviados ? ` <span class="text-dim">· ya recibió proyectos</span>` : ""}${b.segundoTitular ? ` <span class="text-dim">· sugiere segundo titular</span>` : ""}`;
  // Maricela escribe desde el panel de Forja: el botón abre ESA conversación con el mensaje ya puesto en la caja de respuesta
  // (y lo copia al portapapeles por si el navegador recorta el enlace). Sin conversación en el panel, queda WhatsApp.
  const boton = cand.convId
    ? `<button type="button" class="bigbtn" style="margin-bottom:12px;cursor:pointer" onclick="var m=document.getElementById('${id}m').value;try{navigator.clipboard.writeText(m)}catch(e){};var u='/admin/conversations?c=${esc(encodeURIComponent(cand.convId))}';var q='&texto='+encodeURIComponent(m);window.open(q.length<1800?u+q:u,'_blank')">💬 Abrir la conversación en el panel de Forja</button><div class="text-dim" style="font-size:10.5px;margin:-6px 0 12px">Se abre el chat con el mensaje listo en la caja de respuesta (también queda copiado).</div>`
    : tel.length >= 8
      ? `<button type="button" class="bigbtn" style="margin-bottom:12px;cursor:pointer" onclick="window.open('https://wa.me/${esc(tel)}?text='+encodeURIComponent(document.getElementById('${id}m').value),'_blank')">💬 Abrir WhatsApp con este mensaje</button><div class="text-dim" style="font-size:10.5px;margin:-6px 0 12px">Esta persona todavía no tiene conversación en el panel de Forja.</div>`
      : "";
  const avisoFuturo =
    b.accion === "futuro"
      ? `<div style="border:1px solid var(--accent-2);padding:8px 10px;font-size:12px;margin-bottom:10px;color:var(--cream)">Lleva más de 3 intentos sin respuesta: el candidato pasa al estado <b>«${esc(ESTADO_FUTURO)}»</b> en Zoho (el botón completa la tarea; el estado lo cambias tú en su ventana). Zoho programa solo la siguiente tarea a los 3 meses. El mensaje de abajo es un último aviso amable; puedes no enviarlo.</div>`
      : "";
  const listaMotivos = b.accion === "perdido" ? MOTIVOS_PERDIDO : MOTIVOS_DESCARTADO;
  const estadoManual = b.accion === "futuro" ? ESTADO_FUTURO : esCierre(b.accion) ? ESTADOS_CIERRE[b.accion as "perdido" | "descartado"] : "";
  const confirmacion = estadoManual
    ? `En Zoho se va a: ${b.accion === "futuro" ? "" : "agregar la nota y "}marcar ESTA tarea como completa. El cambio de estado a «${estadoManual}» ${b.accion === "futuro" ? "y la nota los dejas tú en la ventana de Zoho (te doy el texto)" : "lo haces tú en Zoho (elegir el motivo)"}. ¿Confirmas?`
    : `En Zoho se va a: agregar la nota, crear la siguiente tarea para el ${masDias(hoy, b.diasSiguiente ?? 0)} y marcar ESTA tarea como completa. ¿Confirmas?`;
  const cuerpo =
    b.accion === "descartado"
      ? `<div class="text-muted" style="font-size:12.5px;margin-bottom:10px">No hace falta escribirle. El candidato pasa a <b style="color:var(--cream)">«${esc(ESTADOS_CIERRE.descartado)}»</b> y solo se deja la nota (ninguna tarea).</div>`
      : `${b.accion === "perdido" ? `<div class="text-muted" style="font-size:12.5px;margin-bottom:10px">El candidato pasa a <b style="color:var(--cream)">«${esc(ESTADOS_CIERRE.perdido)}»</b> y solo se deja la nota (ninguna tarea). Antes puedes enviarle un último mensaje dejando la puerta abierta (opcional).</div>` : ""}
         ${campoCopiable(id + "m", b.accion === "perdido" || b.accion === "futuro" ? "Último mensaje para el cliente (opcional, puedes editarlo)" : "Mensaje para el cliente (puedes editarlo)", b.mensaje, 5, true)}
         ${boton}`;
  return `<div style="border-top:1px dashed var(--line);margin-top:10px;padding-top:12px">
    <div style="font-size:12.5px;margin-bottom:8px">${chips}</div>
    ${b.motivo ? `<div class="text-dim" style="font-size:12px;margin-bottom:10px">Por qué: ${esc(b.motivo)}</div>` : ""}
    ${avisoFuturo}${cuerpo}
    <form hx-post="/crm/seguimientos/hecho" hx-target="#bor-${esc(b.tareaId)}" hx-swap="innerHTML" hx-confirm="${esc(confirmacion)}" style="margin:0">
      <input type="hidden" name="tarea" value="${esc(b.tareaId)}">
      ${esCierre(b.accion) ? `<div style="margin-bottom:12px"><b style="font-size:12px;color:var(--cream)">Motivo en Zoho</b><br><select name="motivo_cierre" class="crm-in" style="margin-top:4px;font-size:12.5px">${listaMotivos.map((m) => `<option value="${esc(m)}"${m === b.motivoCierre ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></div>` : ""}
      ${campoCopiable(id + "n", "Nota para dejar en Zoho después de contactarle (puedes editarla)", b.nota, 2, true, "nota")}
      ${b.tareaSiguiente && b.accion !== "futuro" && !esCierre(b.accion) ? campoCopiable(id + "t", `Siguiente tarea en Zoho · para el ${masDias(hoy, b.diasSiguiente ?? 0)} (puedes editarla)`, b.tareaSiguiente, 1, true, "tarea_siguiente") : ""}
      <div class="text-muted" style="font-size:12px;margin-bottom:10px">Siguiente tarea: <b style="color:var(--cream)">${esc(sig)}</b></div>
      ${escritura
        ? `<button type="submit" class="bigbtn" style="cursor:pointer;margin-bottom:10px">✅ Ya lo envié: actualizar Zoho</button><div class="text-dim" style="font-size:10.5px;margin:-4px 0 10px">Solo toca este candidato y esta tarea; antes de hacerlo te pide confirmar. Nunca borra nada.</div>`
        : `<div class="text-dim" style="font-size:11.5px;margin-bottom:10px">Zoho está en modo solo lectura: copia la nota y marca la tarea tú. (Escritura apagada.)</div>`}
    </form>
    <div class="text-dim" style="font-size:10.5px">Borrador de ${esc(fechaHora(b.creado))} (España)${reutilizado ? " · guardado, sin gastar IA" : ""} · <b>${escritura ? "Zoho no cambia hasta que pulses «Ya lo envié»." : "Modo borrador: no se cambió nada en Zoho."}</b> ·
      <a href="#" hx-post="/crm/seguimientos/preparar" hx-vals='{"tarea":"${esc(b.tareaId)}","r":"1"}' hx-target="#bor-${esc(b.tareaId)}" hx-swap="innerHTML" style="color:var(--accent)">Regenerar</a></div>
  </div>`;
}

export function tarjetaHechoZoho(r: ResultadoZoho, tareaId: string): string {
  if (!r.ok) {
    return `<div style="border-left:4px solid var(--bad);padding:10px 12px;margin-top:10px;font-size:12.5px"><b style="color:var(--bad)">No se terminó de actualizar Zoho.</b><br>${esc(r.error)}
      <div style="margin-top:6px" class="text-dim">Hecho hasta ahora: ${esc(resumenPasos(r.pasos))}. Pulsa «Ver mensaje» para volver a intentarlo.</div></div>`;
  }
  const manual = r.manual
    ? `<div style="border:1px solid var(--accent-2);padding:10px 12px;margin-top:10px"><b style="color:var(--cream)">Falta un paso tuyo en Zoho:</b> en el «Plan de acción» del candidato pulsa <b>«${esc(r.manual.estado)}»</b>${r.manual.motivo ? ` y elige el motivo «${esc(r.manual.motivo)}»` : " y elige un motivo válido para esa transición"}. ${r.manual.notaGuardada ? "La nota ya quedó guardada en el candidato." : `En la ventana pega esta nota:${campoCopiable("nm" + tareaId.slice(-8), "Nota", r.manual.nota, 3)}`}<div class="text-dim" style="font-size:10.5px;margin-top:4px">Zoho no deja cambiar ese estado desde fuera: usa una ventana propia.</div></div>`
    : "";
  return `${manual ? "" : ""}<div style="border-left:4px solid var(--ok);padding:10px 12px;margin-top:10px;font-size:12.5px"><b style="color:var(--ok)">✔ ${r.yaHecho ? "Esta tarea ya estaba hecha" : r.manual ? "Tarea completada" : "Zoho actualizado"}.</b> ${esc(r.aviso ?? resumenPasos(r.pasos))}${r.siguiente ? `<br><span class="text-muted">Siguiente tarea: «${esc(r.siguiente.asunto)}» para el ${esc(r.siguiente.fecha)}.</span>` : ""}
    <div class="text-dim" style="font-size:10.5px;margin-top:4px">Al recargar la página esta tarea ya no aparece en la lista (tarea ${esc(tareaId)}).</div></div>${manual}`;
}

function resumenPasos(p: PasosHechos): string {
  const hechos = [p.nota ? "nota creada" : "", p.tarea ? "siguiente tarea creada" : "", p.completada ? "tarea marcada como completa" : "", p.estado ? "estado del candidato cambiado" : ""].filter(Boolean);
  return hechos.length ? hechos.join(" · ") : "nada todavía";
}

export async function fragmentoHecho(env: Env, tareaId: string, entrada: { nota: string; tareaSiguiente: string; motivo?: string }, now = Date.now(), f?: FetchFn): Promise<string> {
  return tarjetaHechoZoho(await aplicarEnZoho(env, tareaId, entrada, { f }, now), tareaId);
}

export async function fragmentoBorrador(env: Env, tareaId: string, forzar: boolean, now = Date.now(), f?: FetchFn): Promise<string> {
  const db0 = new Db(env.DB);
  await asegurarTablaHecho(db0);
  const hecho = await db0.first<{ pasos: string }>("SELECT pasos FROM crm_seg_hecho WHERE tarea_id = ? AND completo = 1", [tareaId]);
  if (hecho) return tarjetaHechoZoho({ ok: true, pasos: JSON.parse(hecho.pasos) as PasosHechos, yaHecho: true, siguiente: null }, tareaId);
  const r = await prepararBorrador(env, tareaId, { forzar, f }, now);
  if (!r.ok) {
    return `<div style="color:var(--bad);font-size:12.5px;margin-top:8px">${esc(r.error)}</div>`;
  }
  let cand: { movil: string; telefono: string; convId?: string } = { movil: "", telefono: "" };
  try {
    const c = (await candidatosPorIds(env, [r.borrador.leadId], f, now)).get(r.borrador.leadId);
    if (c) {
      cand = { movil: c.movil, telefono: c.telefono };
      const local = await localDe(env, [c.movil, c.telefono], c.nombre);
      if (local) cand.convId = local.convId;
    }
  } catch {
    /* sin botón de conversación */
  }
  return tarjetaBorrador(r.borrador, cand, hoyMadrid(now), r.reutilizado, await escrituraActiva(env));
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
            <span style="font-size:12px">${atr}<br><span class="text-dim" style="font-size:10.5px">${esc(x.tarea.vence)}</span><br><span style="font-size:10.5px;color:${/no iniciada|not started/i.test(x.tarea.estado) ? "var(--accent-2)" : "var(--dim)"}">${esc(x.tarea.estado || "—")}${/no iniciada|not started/i.test(x.tarea.estado) ? " ⚠" : ""}</span></span>
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
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Las tareas de seguimiento de Zoho que toca hacer hoy o que ya se pasaron. Pulsa <b style="color:var(--cream)">Preparar mensaje</b> y la IA lee la nota del candidato y te propone qué escribirle (o si hay que pasarlo a «Cliente perdido», «Descartado» o «Revisar en el futuro»).</div>
    ${cuerpo}`;
  return crmLayout({ title: "Seguimientos", activa: "seguimientos", body, env });
}
