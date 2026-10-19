// member/crm-reactivacion.local.ts — CRM de Viventa: «Reactivación» de los clientes que quedaron «Revisar en el futuro».
// Zoho, al pasar un candidato a «Revisar en el futuro», crea una tarea «Retomar cliente a futuro…» a 3 meses; al cumplirse, la empresa
// lo reasigna a otro asesor. Antes de eso (entre el día 45 y el 60 desde que quedó para después) escribimos nosotros para reactivarlo:
// un mensaje con una oferta de vivienda que le pueda interesar según lo que habló (ciudad, presupuesto) o las más atractivas del catálogo.
//   · Maricela revisa y aprueba cada mensaje (borrador de la IA, editable) y lo envía con un botón; nada sale solo.
//   · WhatsApp fuera de las 24 h exige una plantilla aprobada por Meta (ajuste viventa_tpl_reactivacion); al responder el cliente, el bot
//     sigue la conversación con la oferta ya preparada (queda como nota interna en el hilo).
//   · Si en 10 días no responde: botón para pasarlo a «Cliente perdido» (motivo «Nunca me respondió») u omitirlo.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { workModel } from "../src/llm/work-model";
import { puedeEscribirAhora } from "../src/lib/horarioCliente";
import { TPL_REACTIVACION, TPL_REACTIVACION_TEXTO, enviarACliente } from "../src/followup/sistemaViventa";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, fechaHora } from "./crm.local";
import { anonimizar } from "./crm-ia.local";
import { escrituraActiva, hoyMadrid, MOTIVOS_PERDIDO, localDe } from "./crm-seguimientos.local";
import {
  ZohoError, candidatosPorIds, coql, completarTarea, crearNota, duenoZoho, ejecutarTransicion, notasDe, transicionesDe, zohoListo,
  type CandidatoZoho, type FetchFn,
} from "./crm-zohoapi.local";

const DIA = 86_400_000;
export const ESTADO_FUTURO_ZOHO = "Revisar en el futuro";
export const ASUNTO_FUTURO = "Retomar cliente a futuro";
/** Ventana en la que se le escribe: días desde que quedó «para después» (3 meses = 90). */
export const VENTANA_DESDE = 45;
export const VENTANA_HASTA = 60;
/** Días sin respuesta tras escribirle para darlo por no reactivado. */
export const DIAS_SIN_RESPUESTA = 10;
export const MOTIVO_NO_REACTIVO = "Nunca me respondió";
export const TEXTO_PLANTILLA_POR_DEFECTO =
  "Hola {{1}}, soy del equipo comercial de Maricela Naranjo (Viventa). Han salido nuevas oportunidades de vivienda en Colombia y pensé en ti. ¿Te cuento cuáles son? Responde SÍ y te envío las mejores opciones.";

export type Fase = "pronto" | "toca" | "tarde";
export type EstadoEnvio = "sin_escribir" | "escrito" | "respondio" | "sin_respuesta" | "perdido" | "omitido";

export interface FilaReactiva {
  tareaId: string;
  leadId: string;
  cand: CandidatoZoho;
  /** ms en que quedó «para después» (creación de la tarea «Retomar cliente a futuro»). */
  entrada: number;
  dias: number;
  /** Fecha límite de la tarea en Zoho (cuando la empresa lo reasigna). */
  vence: string;
  fase: Fase;
  envio: EstadoEnvio;
  enviadoEn: number | null;
  canal: string;
}

async function asegurar(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_reactiva (
       lead_id TEXT PRIMARY KEY, tarea_id TEXT NOT NULL DEFAULT '', conv_id TEXT NOT NULL DEFAULT '', borrador TEXT NOT NULL DEFAULT '', oferta TEXT NOT NULL DEFAULT '',
       creado INTEGER NOT NULL, enviado_en INTEGER, canal TEXT NOT NULL DEFAULT '', resultado TEXT NOT NULL DEFAULT ''
     )`,
  );
}

export function faseDe(dias: number): Fase {
  return dias < VENTANA_DESDE ? "pronto" : dias <= VENTANA_HASTA ? "toca" : "tarde";
}

/** Días completos desde `desde` (ms) hasta `now`. */
export const diasDesde = (desde: number, now: number): number => Math.max(0, Math.floor((now - desde) / DIA));

const refId = (v: unknown): string => (v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id ?? "") : "");

/** Tareas abiertas «Retomar cliente a futuro…» de Maricela con su candidato. */
export async function cargarReactivacion(env: Env, now = Date.now(), f?: FetchFn): Promise<FilaReactiva[]> {
  const dueno = await duenoZoho(env, f, now);
  const tareas: Array<{ id: string; leadId: string; vence: string; creada: number }> = [];
  for (let off = 0; off < 1000; off += 200) {
    const filas = await coql(
      env,
      `select id, Due_Date, Created_Time, What_Id, Who_Id, $se_module from Tasks where ((Owner = '${dueno.id}' and Subject like '${ASUNTO_FUTURO}%') and Status not in ('Completa','Completed')) order by Created_Time asc limit ${off}, 200`,
      f,
      now,
    );
    for (const r of filas) {
      const modulo = String(r["$se_module"] ?? "");
      const leadId = modulo === "Leads" ? refId(r["What_Id"]) || refId(r["Who_Id"]) : refId(r["Who_Id"]);
      const creada = Date.parse(String(r["Created_Time"] ?? ""));
      if (!leadId || !Number.isFinite(creada)) continue;
      tareas.push({ id: String(r["id"]), leadId, vence: String(r["Due_Date"] ?? ""), creada });
    }
    if (filas.length < 200) break;
  }
  const db = new Db(env.DB);
  await asegurar(db);
  // Quienes ya recibieron el mensaje (p. ej. el masivo) aunque no tengan la tarea «Retomar…»: se siguen mostrando para ver si respondieron.
  const escritos = (await db.all<{ lead_id: string }>("SELECT lead_id FROM crm_reactiva WHERE enviado_en IS NOT NULL AND resultado = ''")).map((r) => r.lead_id);
  const conTarea = new Set(tareas.map((t) => t.leadId));
  const sinTarea = escritos.filter((id) => !conTarea.has(id));
  if (tareas.length === 0 && sinTarea.length === 0) return [];
  const cands = await candidatosPorIds(env, [...tareas.map((t) => t.leadId), ...sinTarea], f, now);
  const reg = new Map((await db.all<{ lead_id: string; conv_id: string; enviado_en: number | null; canal: string; resultado: string }>("SELECT lead_id, conv_id, enviado_en, canal, resultado FROM crm_reactiva")).map((r) => [r.lead_id, r]));
  const out: FilaReactiva[] = [];
  for (const t of tareas) {
    const cand = cands.get(t.leadId);
    if (!cand || cand.estado !== ESTADO_FUTURO_ZOHO) continue; // ya salió de «para después»: no hay nada que reactivar
    const dias = diasDesde(t.creada, now);
    const r = reg.get(t.leadId);
    let envio: EstadoEnvio = "sin_escribir";
    if (r?.resultado === "perdido") envio = "perdido";
    else if (r?.resultado === "omitido") envio = "omitido";
    else if (r?.enviado_en) {
      envio = "escrito";
      const resp = r.conv_id
        ? await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ?", [r.conv_id, r.enviado_en])
        : null;
      if ((resp?.n ?? 0) > 0) envio = "respondio";
      else if (now - r.enviado_en > DIAS_SIN_RESPUESTA * DIA) envio = "sin_respuesta";
    }
    out.push({ tareaId: t.id, leadId: t.leadId, cand, entrada: t.creada, dias, vence: t.vence, fase: faseDe(dias), envio, enviadoEn: r?.enviado_en ?? null, canal: r?.canal ?? "" });
  }
  for (const id of sinTarea) {
    const cand = cands.get(id);
    const r = reg.get(id);
    if (!cand || cand.estado !== ESTADO_FUTURO_ZOHO || !r?.enviado_en) continue;
    let envio: EstadoEnvio = "escrito";
    const resp = r.conv_id ? await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ?", [r.conv_id, r.enviado_en]) : null;
    if ((resp?.n ?? 0) > 0) envio = "respondio";
    else if (now - r.enviado_en > DIAS_SIN_RESPUESTA * DIA) envio = "sin_respuesta";
    out.push({ tareaId: "", leadId: id, cand, entrada: r.enviado_en, dias: 0, vence: "", fase: "toca", envio, enviadoEn: r.enviado_en, canal: r.canal });
  }
  return out.sort((a, b) => b.dias - a.dias);
}

// ─── Teléfono ────────────────────────────────────────────────────────────────

/** Número internacional (solo dígitos, con prefijo de país) o null si no se puede asegurar. */
export function telefonoInternacional(movil: string, telefono: string, pais: string): string | null {
  for (const bruto of [movil, telefono]) {
    let d = bruto.replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length < 9) continue;
    if (d.length >= 11) return d; // ya trae prefijo
    const p = pais.toLowerCase();
    if (d.length === 9 && /^[67]/.test(d) && (!p || /espa/.test(p))) return `34${d}`;
    if (d.length === 10 && d.startsWith("3") && (!p || /colombia/.test(p))) return `57${d}`;
  }
  return null;
}

// ─── Ofertas del catálogo (KB) ───────────────────────────────────────────────

/** Fragmentos del catálogo de proyectos y ofertas más cercanos a lo que buscaba el cliente. */
export async function ofertasKb(env: Env, consulta: string): Promise<Array<{ titulo: string; texto: string }>> {
  try {
    const emb = (await env.AI.run("@cf/baai/bge-m3", { text: consulta })) as { data?: number[][] };
    const vec = emb.data?.[0];
    if (!Array.isArray(vec)) return [];
    const m = await env.KB.query(vec, { topK: 6, returnMetadata: "all" });
    return (m.matches ?? [])
      .filter((x: { score?: number }) => (x.score ?? 0) >= 0.45)
      .map((x: { metadata?: Record<string, unknown> }) => ({ titulo: String(x.metadata?.["title"] ?? ""), texto: String(x.metadata?.["content"] ?? "").replace(/\s+/g, " ").slice(0, 700) }))
      .filter((x: { texto: string }) => x.texto);
  } catch (e) {
    console.error("[crm-reactivacion] kb:", e);
    return [];
  }
}

// ─── Borrador ────────────────────────────────────────────────────────────────

export interface BorradorReactiva {
  mensaje: string;
  oferta: string;
  ciudad: string;
}

export function leerBorradorReactiva(texto: string, nombre: string): BorradorReactiva | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const primer = nombre.split(/\s+/).find((w) => w.replace(/[^\p{L}]/gu, "").length >= 2) ?? "";
  const mensaje = String(j["mensaje"] ?? "").replace(/\[\[[^\]]*\]\]/g, "").replace(/\[nombre\]/gi, primer).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 700);
  if (!mensaje) return null;
  return { mensaje, oferta: String(j["oferta"] ?? "").replace(/\s+/g, " ").trim().slice(0, 300), ciudad: String(j["ciudad"] ?? "").replace(/\s+/g, " ").trim().slice(0, 60) };
}

const REGLAS = `Eres la asistente comercial de Maricela Naranjo (Viventa), que ayuda a colombianos en el exterior a comprar vivienda en Colombia.
Este cliente quedó «para después» hace unas semanas y vamos a escribirle por WhatsApp para REACTIVARLO antes de que lo reasigne la empresa.
Escribe UN mensaje corto (máximo 5 líneas), cercano, en español, SIN emojis y sin presionar:
1. Salúdalo con [nombre] y retoma con naturalidad lo que se habló (ciudad o zona de interés, perfil), SIN repetir datos personales ni cifras de ingresos.
2. Cuéntale UNA oferta concreta y atractiva de las "OFERTAS DEL CATÁLOGO" que mejor encaje con lo que buscaba (la ciudad que dijo; si no dijo ciudad, la más atractiva/irresistible: un descuento, una entrega inmediata, una preaprobación de crédito). USA SOLO lo que aparece en el catálogo: no inventes precios, descuentos, fechas ni proyectos. Si el catálogo no trae nada relevante, habla de forma general de nuevas oportunidades en la ciudad que le interesaba, sin cifras.
3. Termina con UNA pregunta fácil de responder (por ejemplo si quiere que le envíes la información o agendar una videollamada corta con Maricela).
Responde SOLO con un JSON válido, sin texto extra:
{"mensaje": "texto para el cliente", "oferta": "frase corta de la oferta que usaste (vacío si fue general)", "ciudad": "ciudad o zona que le interesaba (vacío si no se sabe)"}`;

const idLead = (id: string): boolean => /^\d{6,30}$/.test(id);

export async function prepararMensaje(
  env: Env,
  leadId: string,
  opts: { forzar?: boolean; f?: FetchFn } = {},
  now = Date.now(),
): Promise<{ ok: true; borrador: BorradorReactiva; reutilizado: boolean } | { ok: false; error: string }> {
  if (!idLead(leadId)) return { ok: false, error: "Candidato no válido." };
  const db = new Db(env.DB);
  await asegurar(db);
  const previo = await db.first<{ borrador: string; oferta: string }>("SELECT borrador, oferta FROM crm_reactiva WHERE lead_id = ?", [leadId]);
  if (previo?.borrador && !opts.forzar) {
    try {
      return { ok: true, borrador: JSON.parse(previo.borrador) as BorradorReactiva, reutilizado: true };
    } catch {
      /* se rehace */
    }
  }
  let cand: CandidatoZoho | undefined;
  let notas: Array<{ texto: string }> = [];
  try {
    cand = (await candidatosPorIds(env, [leadId], opts.f, now)).get(leadId);
    if (cand) notas = await notasDe(env, leadId, 6, opts.f, now);
  } catch (e) {
    return { ok: false, error: e instanceof ZohoError ? e.message : "No pude leer a ese candidato en Zoho." };
  }
  if (!cand) return { ok: false, error: "No encontré a ese candidato en Zoho." };
  const local = await localDe(env, [cand.movil, cand.telefono], cand.nombre).catch(() => null);
  const notasTxt = notas.map((n) => `- ${anonimizar(n.texto.replace(/\s+/g, " "), cand!.nombre).slice(0, 350)}`).join("\n") || "(sin notas)";
  const ofertas = await ofertasKb(env, `${notasTxt.slice(0, 300)} ${local?.ficha.slice(0, 200) ?? ""} vivienda proyecto oferta descuento entrega inmediata`);
  const catalogo = ofertas.map((o, i) => `${i + 1}. ${o.titulo}: ${o.texto}`).join("\n") || "(no hay ofertas en el catálogo para esta consulta)";
  const prompt = `${REGLAS}

DATOS DEL CLIENTE (el nombre y los contactos se omitieron):
- País: ${cand.pais || "no indicado"}
NOTAS DE ZOHO (recientes primero):
${notasTxt}
${local?.ficha ? `FICHA DEL BOT:\n${local.ficha}\n` : ""}${local?.conversacion ? `CONVERSACIÓN RECIENTE CON EL BOT:\n${local.conversacion}\n` : ""}
OFERTAS DEL CATÁLOGO (únicas que puedes mencionar):
${catalogo}`;
  let b: BorradorReactiva | null = null;
  try {
    const llm = await workModel(env, "smart", "followups");
    const r = await llm.generate({ prompt, maxOutputTokens: 3000, temperature: 0.4 } as never);
    b = leerBorradorReactiva(String((r as { text?: string }).text ?? ""), cand.nombre);
  } catch (e) {
    console.error("[crm-reactivacion] IA:", e);
    return { ok: false, error: "No pude consultar a la IA ahora. Inténtalo en unos minutos." };
  }
  if (!b) return { ok: false, error: "La IA no devolvió un mensaje claro. Inténtalo de nuevo." };
  await db.run(
    `INSERT INTO crm_reactiva (lead_id, borrador, oferta, creado) VALUES (?,?,?,?)
       ON CONFLICT(lead_id) DO UPDATE SET borrador = excluded.borrador, oferta = excluded.oferta`,
    [leadId, JSON.stringify(b), b.oferta, now],
  );
  return { ok: true, borrador: b, reutilizado: false };
}

// ─── Enviar ──────────────────────────────────────────────────────────────────

export type ResultadoEnvio = { ok: true; via: "libre" | "plantilla"; zoho: string } | { ok: false; error: string };

export async function enviarReactivacion(
  env: Env,
  leadId: string,
  mensajeEditado: string,
  opts: { f?: FetchFn; /** Mensaje fijo de Maricela (envío masivo): no hace falta borrador de la IA. */ fijo?: { oferta: string }; cand?: CandidatoZoho } = {},
  now = Date.now(),
): Promise<ResultadoEnvio> {
  if (!idLead(leadId)) return { ok: false, error: "Candidato no válido." };
  const db = new Db(env.DB);
  await asegurar(db);
  let reg = await db.first<{ borrador: string; oferta: string; enviado_en: number | null }>("SELECT borrador, oferta, enviado_en FROM crm_reactiva WHERE lead_id = ?", [leadId]);
  if (opts.fijo) {
    if (!reg) {
      await db.run("INSERT INTO crm_reactiva (lead_id, creado, oferta) VALUES (?,?,?)", [leadId, now, opts.fijo.oferta]);
      reg = { borrador: "", oferta: opts.fijo.oferta, enviado_en: null };
    }
  } else if (!reg?.borrador) return { ok: false, error: "Primero prepara el mensaje de este cliente." };
  if (reg!.enviado_en) return { ok: false, error: "A este cliente ya se le escribió. No se envía dos veces." };
  const cand = opts.cand ?? (await candidatosPorIds(env, [leadId], opts.f, now).catch(() => new Map<string, CandidatoZoho>())).get(leadId);
  if (!cand) return { ok: false, error: "No encontré a ese candidato en Zoho." };
  if (cand.estado !== ESTADO_FUTURO_ZOHO) return { ok: false, error: `Ese candidato ya no está en «${ESTADO_FUTURO_ZOHO}» (está en «${cand.estado}»). No se le escribe.` };
  const tel = telefonoInternacional(cand.movil, cand.telefono, cand.pais);
  if (!tel) return { ok: false, error: "No puedo asegurar el teléfono con prefijo de país (Zoho trae un número corto). Escríbele tú desde WhatsApp." };
  const nombre = cand.nombre.split(/\s+/).find((w) => w.replace(/[^\p{L}]/gu, "").length >= 2) ?? "";
  const convs = new ConversationsRepo(db);
  const conv = await convs.getOrCreate("ycloud", tel, cand.nombre);
  const ref = { id: conv.id, channel: conv.channel, channel_user_id: conv.channel_user_id, display_name: conv.display_name };
  if (conv.taken_by) return { ok: false, error: "Una persona del equipo tiene tomada esa conversación; escríbele desde ahí." };
  if (!(await puedeEscribirAhora(db, ref, now))) return { ok: false, error: "Para este cliente es de madrugada. Envíalo a partir de las 9:00 de su hora." };

  const texto = opts.fijo ? mensajeEditado.trim().slice(0, 1500) : mensajeEditado.replace(/\s+/g, " ").trim().slice(0, 900) || (JSON.parse(reg!.borrador) as BorradorReactiva).mensaje;
  const ult = await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [conv.id]);
  const settings = new SettingsRepo(db);
  const plantillaBase = ((await settings.get(TPL_REACTIVACION_TEXTO)) ?? "").trim() || TEXTO_PLANTILLA_POR_DEFECTO;
  const usaNombre = plantillaBase.includes("{{1}}"); // la plantilla de Maricela no lleva variables
  const plantillaTexto = plantillaBase.replace(/\{\{1\}\}/g, nombre || "hola");
  const dentro = ult?.t != null && now - ult.t < 24 * 3600_000 - 300_000;
  let via: "libre" | "plantilla";
  try {
    via = await enviarACliente(env, db, ref, dentro ? texto : plantillaTexto, { setting: TPL_REACTIVACION, params: usaNombre ? [nombre || "hola"] : [] }, ult?.t ?? null, now);
  } catch (e) {
    if ((e as Error).message === "sin_plantilla") {
      return { ok: false, error: `WhatsApp ya cerró la ventana de 24 h con este cliente y todavía no hay plantilla aprobada para reactivaciones (ajuste ${TPL_REACTIVACION}). Avísale a Brayan para crearla en YCloud/Meta.` };
    }
    console.error("[crm-reactivacion] envío:", e);
    return { ok: false, error: "No se pudo enviar por WhatsApp. Inténtalo de nuevo en unos minutos." };
  }
  // Contexto interno para el bot: cuando el cliente responda, sigue con ESTA oferta (la nota no la ve el cliente).
  await new MessagesRepo(db).append(
    conv.id,
    "note",
    `Reactivación (cliente que quedó «para después»): se le escribió${via === "plantilla" ? " con la plantilla de reactivación" : ""}. Oferta preparada para cuando responda: ${reg!.oferta || "general (nuevas oportunidades de vivienda)"}. Mensaje enviado${opts.fijo ? " (texto de Maricela)" : ""}: «${(via === "plantilla" ? plantillaTexto : texto).slice(0, 900)}». Si responde con interés (Bogotá, playa u otra ciudad), retoma esto, pregúntale por su ciudad y presupuesto y ofrécele la videollamada con Maricela. Si responde que no le interesa, agradécele con amabilidad y no insistas.`,
  );
  await db.run("UPDATE crm_reactiva SET enviado_en = ?, canal = ?, conv_id = ? WHERE lead_id = ?", [now, via, conv.id, leadId]);
  let zoho = "";
  if (await escrituraActiva(env)) {
    try {
      await crearNota(env, leadId, `Reactivación por WhatsApp (${hoyMadrid(now)}): se le escribió${reg!.oferta ? ` ofreciendo ${reg!.oferta}` : " con novedades de proyectos"}.`, opts.f, now);
      zoho = "nota guardada en Zoho";
    } catch (e) {
      console.error("[crm-reactivacion] nota Zoho:", e);
      zoho = "no pude guardar la nota en Zoho";
    }
  }
  return { ok: true, via, zoho };
}

// ─── Cerrar / omitir ─────────────────────────────────────────────────────────

export type ResultadoCierre = { ok: true; manual: boolean } | { ok: false; error: string };

/** «Cliente perdido» (motivo «Nunca me respondió») por la transición de Zoho y completa la tarea «Retomar cliente a futuro». */
export async function pasarAPerdido(env: Env, leadId: string, opts: { f?: FetchFn } = {}, now = Date.now()): Promise<ResultadoCierre> {
  if (!idLead(leadId)) return { ok: false, error: "Candidato no válido." };
  if (!(await escrituraActiva(env))) return { ok: false, error: "Zoho está en modo solo lectura. Avísale a Brayan para activar la escritura." };
  const db = new Db(env.DB);
  await asegurar(db);
  try {
    const fila = (await cargarReactivacion(env, now, opts.f)).find((x) => x.leadId === leadId);
    if (!fila) return { ok: false, error: "Ese cliente ya no está en la lista de reactivación." };
    await crearNota(env, leadId, `Reactivación sin respuesta (${hoyMadrid(now)}): se le escribió y no respondió. Pasa a Cliente perdido.`, opts.f, now).catch(() => undefined);
    const trans = (await transicionesDe(env, leadId, opts.f, now)).find((t) => t.nombre === "Cliente perdido");
    let manual = false;
    if (!trans) manual = true;
    else {
      const motivo = trans.motivos.length === 0 || trans.motivos.includes(MOTIVO_NO_REACTIVO) ? MOTIVO_NO_REACTIVO : (trans.motivos.find((m) => MOTIVOS_PERDIDO.includes(m)) ?? "");
      await ejecutarTransicion(env, leadId, trans.id, motivo ? { motivo } : {}, opts.f, now);
    }
    await completarTarea(env, fila.tareaId, opts.f, now).catch((e) => console.error("[crm-reactivacion] completar tarea:", e));
    await db.run(`INSERT INTO crm_reactiva (lead_id, creado, resultado) VALUES (?,?, 'perdido') ON CONFLICT(lead_id) DO UPDATE SET resultado = 'perdido'`, [leadId, now]);
    return { ok: true, manual };
  } catch (e) {
    console.error("[crm-reactivacion] perdido:", e);
    return { ok: false, error: e instanceof ZohoError ? e.message : "No pude actualizar Zoho." };
  }
}

/** Saca al cliente de la lista (no se le escribe). No cambia nada en Zoho. */
export async function omitir(env: Env, leadId: string, now = Date.now()): Promise<void> {
  if (!idLead(leadId)) return;
  const db = new Db(env.DB);
  await asegurar(db);
  await db.run(`INSERT INTO crm_reactiva (lead_id, creado, resultado) VALUES (?,?, 'omitido') ON CONFLICT(lead_id) DO UPDATE SET resultado = 'omitido'`, [leadId, now]);
}

// ─── Vista ───────────────────────────────────────────────────────────────────

const FASE: Record<Fase, { txt: string; color: string }> = {
  pronto: { txt: "⏳ Aún no toca", color: "var(--dim)" },
  toca: { txt: "🟢 Toca escribirle", color: "var(--ok)" },
  tarde: { txt: "🟠 Se pasó la ventana", color: "var(--accent-2)" },
};
const ENVIO: Record<EstadoEnvio, string> = {
  sin_escribir: "Sin escribir",
  escrito: "✉ Escrito: esperando respuesta",
  respondio: "💬 Respondió",
  sin_respuesta: `😶 Sin respuesta en ${DIAS_SIN_RESPUESTA} días`,
  perdido: "✖ Pasado a perdido",
  omitido: "Omitido",
};

const idEl = (leadId: string): string => `re-${leadId.replace(/\W/g, "")}`;

function accionesFila(x: FilaReactiva): string {
  const id = idEl(x.leadId);
  const post = (ruta: string, txt: string, confirmar = "", extra = "") =>
    `<button class="bigbtn" style="cursor:pointer;padding:5px 10px;font-size:11.5px;${extra}" hx-post="/crm/reactivacion/${ruta}" hx-vals='{"lead":"${esc(x.leadId)}"}' hx-target="#${id}" hx-swap="innerHTML" hx-disabled-elt="this"${confirmar ? ` hx-confirm="${esc(confirmar)}"` : ""}>${txt}</button>`;
  if (x.envio === "perdido" || x.envio === "omitido") return "";
  if (x.envio === "sin_respuesta") {
    return `${post("perdido", "Pasar a Cliente perdido", "¿Pasar a este cliente a «Cliente perdido» (motivo «Nunca me respondió») y cerrar su tarea de reactivación?")} ${post("omitir", "Omitir", "¿Sacarlo de esta lista sin cambiar nada en Zoho?", "background:none;border:1px solid var(--line);color:var(--muted)")}`;
  }
  if (x.envio === "escrito" || x.envio === "respondio") return `<span class="text-dim" style="font-size:11px">${x.enviadoEn ? esc(fechaHora(x.enviadoEn)) : ""}</span>`;
  return `${post("preparar", x.fase === "toca" ? "Preparar mensaje" : "Preparar mensaje")} ${post("omitir", "Omitir", "¿Sacarlo de esta lista sin cambiar nada en Zoho?", "background:none;border:1px solid var(--line);color:var(--muted)")}`;
}

export async function renderReactivacion(env: Env, now = Date.now(), f?: FetchFn): Promise<string> {
  let cuerpo: string;
  if (!zohoListo(env)) {
    cuerpo = `<div class="crm-card" style="padding:28px;text-align:center;color:var(--dim)">Zoho todavía no está conectado.</div>`;
  } else {
    try {
      const todas = (await cargarReactivacion(env, now, f)).filter((x) => x.envio !== "omitido" && x.envio !== "perdido");
      const n = (fn: (x: FilaReactiva) => boolean) => todas.filter(fn).length;
      const kpi = (t: string, v: number, color?: string) => `<div class="crm-kpi"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${t}</div><div style="font-weight:700;font-size:26px;${color ? `color:${color}` : ""}">${v}</div></div>`;
      const COLS = "minmax(170px,1.2fr) 100px 110px 150px 190px 230px";
      const fila = (x: FilaReactiva) => {
        const fs = FASE[x.fase];
        const faltan = x.fase === "pronto" ? ` · faltan ${VENTANA_DESDE - x.dias} días` : "";
        return `<div class="crm-row" style="grid-template-columns:${COLS};align-items:start">
          <span><b style="color:var(--cream)">${esc(x.cand.nombre)}</b><br><span class="text-dim" style="font-size:11px">${esc(x.cand.movil || x.cand.telefono || "—")}${x.cand.pais ? ` · ${esc(x.cand.pais)}` : ""}</span></span>
          <span style="font-weight:700">${x.dias} días</span>
          <span class="text-dim" style="font-size:12px">${esc(x.vence || "—")}</span>
          <span style="font-size:12px;color:${fs.color}">${fs.txt}${faltan}</span>
          <span style="font-size:12px">${ENVIO[x.envio]}</span>
          <span>${accionesFila(x)}</span>
          <div id="${idEl(x.leadId)}" style="grid-column:1/-1"></div></div>`;
      };
      cuerpo = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px">
          ${kpi("Para después", todas.length)}
          ${kpi("🟢 Toca escribirles", n((x) => x.fase === "toca" && x.envio === "sin_escribir"), "var(--ok)")}
          ${kpi("🟠 Se pasó la ventana", n((x) => x.fase === "tarde" && x.envio === "sin_escribir"), "var(--accent-2)")}
          ${kpi("✉ Esperando respuesta", n((x) => x.envio === "escrito"))}
          ${kpi("💬 Respondieron", n((x) => x.envio === "respondio"), "var(--ok)")}
          ${kpi("😶 Sin respuesta", n((x) => x.envio === "sin_respuesta"), "var(--bad)")}</div>
        <div class="crm-card"><div style="overflow-x:auto"><div style="min-width:980px">
          <div class="crm-row crm-head" style="grid-template-columns:${COLS}"><span>Cliente</span><span>Para después hace</span><span>Reasigna el</span><span>Momento</span><span>Estado</span><span></span></div>
          ${todas.length ? todas.map(fila).join("") : `<div style="padding:44px 18px;text-align:center;color:var(--dim)">No hay clientes en «${ESTADO_FUTURO_ZOHO}» con su tarea «${ASUNTO_FUTURO}» pendiente.</div>`}
        </div></div></div>`;
    } catch (e) {
      console.error("[crm-reactivacion] cargar:", e);
      cuerpo = `<div class="crm-card" style="padding:24px;color:var(--bad)">${e instanceof ZohoError ? esc(e.message) : "No pude leer Zoho ahora. Inténtalo en unos minutos."}</div>`;
    }
  }
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Clientes que quedaron en «${ESTADO_FUTURO_ZOHO}»: a los 3 meses la empresa los reasigna a otro asesor. Antes de eso intentamos reactivarlos: <b style="color:var(--cream)">entre el día ${VENTANA_DESDE} y el ${VENTANA_HASTA}</b> el bot te prepara un mensaje con una oferta que les pueda interesar (según lo que hablaron). Tú lo revisas y lo envías; si en ${DIAS_SIN_RESPUESTA} días no responden, puedes pasarlos a «Cliente perdido».</div>
    ${cuerpo}`;
  return crmLayout({ title: "Reactivación", activa: "reactivacion", body, env });
}

// ─── Fragmentos (htmx) ───────────────────────────────────────────────────────

export async function fragmentoPreparar(env: Env, leadId: string, forzar: boolean, now = Date.now(), f?: FetchFn): Promise<string> {
  const r = await prepararMensaje(env, leadId, { forzar, f }, now);
  if (!r.ok) return `<div style="color:var(--bad);font-size:12.5px;margin-top:8px">${esc(r.error)}</div>`;
  const b = r.borrador;
  const hay = ((await new SettingsRepo(new Db(env.DB)).get(TPL_REACTIVACION)) ?? "").trim();
  const pid = "rb" + leadId.slice(-8);
  return `<div class="crm-card" style="padding:14px;margin-top:10px;border-left:4px solid var(--info)">
    <form hx-post="/crm/reactivacion/enviar" hx-target="#${idEl(leadId)}" hx-swap="innerHTML" hx-disabled-elt="find button[type=submit]" hx-confirm="¿Enviar este mensaje por WhatsApp a este cliente? Se envía una sola vez.">
      <input type="hidden" name="lead" value="${esc(leadId)}">
      <div style="font-size:12px;color:var(--cream);font-weight:600;margin-bottom:4px">Mensaje para el cliente (puedes editarlo)${b.ciudad ? ` · interés: ${esc(b.ciudad)}` : ""}</div>
      <textarea id="${pid}" name="mensaje" rows="5" class="crm-in" style="width:100%;resize:vertical;font-size:12.5px;line-height:1.5">${esc(b.mensaje)}</textarea>
      <div class="text-muted" style="font-size:12px;margin:6px 0">Oferta usada: <b style="color:var(--cream)">${esc(b.oferta || "general (sin cifras)")}</b></div>
      <div class="text-dim" style="font-size:11px;margin-bottom:8px">Si el cliente escribió al bot en las últimas 24 h, sale este texto. Si no, WhatsApp exige una <b>plantilla aprobada</b>${hay ? ` (configurada: «${esc(hay)}»); el bot guarda esta oferta como nota interna y la usa cuando el cliente responda` : `, que todavía NO está configurada: el envío te avisará. Avísale a Brayan para crearla`}.</div>
      <button type="submit" class="bigbtn" style="cursor:pointer">✉ Enviar por WhatsApp</button>
    </form>
    <div class="text-dim" style="font-size:10.5px;margin-top:6px">${r.reutilizado ? "Borrador guardado, sin gastar IA · " : ""}<a href="#" hx-post="/crm/reactivacion/preparar" hx-vals='{"lead":"${esc(leadId)}","r":"1"}' hx-target="#${idEl(leadId)}" hx-swap="innerHTML" style="color:var(--accent)">Regenerar</a></div></div>`;
}

export async function fragmentoEnviar(env: Env, leadId: string, mensaje: string, now = Date.now(), f?: FetchFn): Promise<string> {
  const r = await enviarReactivacion(env, leadId, mensaje, { f }, now);
  if (!r.ok) return `<div style="border-left:4px solid var(--bad);padding:8px 12px;margin-top:8px;font-size:12.5px;color:var(--bad)">${esc(r.error)}</div>`;
  return `<div style="border-left:4px solid var(--ok);padding:8px 12px;margin-top:8px;font-size:12.5px"><b style="color:var(--ok)">✔ Enviado</b> (${r.via === "plantilla" ? "con la plantilla de WhatsApp" : "texto libre"})${r.zoho ? ` · ${esc(r.zoho)}` : ""}. Cuando responda, el bot sigue la conversación con esa oferta; lo verás en «Respondió».</div>`;
}

export async function fragmentoPerdido(env: Env, leadId: string, now = Date.now(), f?: FetchFn): Promise<string> {
  const r = await pasarAPerdido(env, leadId, { f }, now);
  if (!r.ok) return `<div style="border-left:4px solid var(--bad);padding:8px 12px;margin-top:8px;font-size:12.5px;color:var(--bad)">${esc(r.error)}</div>`;
  return `<div style="border-left:4px solid var(--ok);padding:8px 12px;margin-top:8px;font-size:12.5px"><b style="color:var(--ok)">✔ Listo.</b> ${r.manual ? `Zoho no permite ese cambio de estado desde aquí: en el «Plan de acción» del candidato pulsa «Cliente perdido» con el motivo «${esc(MOTIVO_NO_REACTIVO)}». La nota y la tarea ya quedaron.` : "Pasó a «Cliente perdido» y se cerró su tarea."} Al recargar sale de la lista.</div>`;
}

export async function fragmentoOmitir(env: Env, leadId: string, now = Date.now()): Promise<string> {
  await omitir(env, leadId, now);
  return `<div style="font-size:12px;color:var(--ok);margin-top:6px">✔ Omitido. Al recargar sale de la lista (Zoho no cambió).</div>`;
}

// ─── Envío masivo con el mensaje de Maricela ─────────────────────────────────
// Maricela aprobó (19-oct-2026) escribirles a TODOS los clientes en «Revisar en el futuro» con un mensaje fijo (Bogotá o playa + enlace).
// Va por la plantilla aprobada `viventa_tpl_reactivacion` (sin variables) y SOLO corre con el ajuste `viventa_reactivacion_masiva = activo`.
// Se envía de a pocos por pasada (cada 15 min), solo de 9 a 21 h del cliente, una sola vez por cliente.

export const AJUSTE_MASIVO = "viventa_reactivacion_masiva";
export const OFERTA_MASIVA = "Bogotá y Playa (mensaje de Maricela)";
const MAX_POR_PASADA = 8;

/** ¿Meta ya aprobó la plantilla? Solo se consulta hasta que sale APPROVED (después queda guardado). Sin llave de YCloud no se puede verificar: se deja pasar y el envío fallará solo. */
export async function plantillaAprobada(env: Env, nombre: string): Promise<boolean> {
  const settings = new SettingsRepo(new Db(env.DB));
  const marca = `${TPL_REACTIVACION}_aprobada`;
  if (((await settings.get(marca)) ?? "") === nombre) return true;
  if (!env.YCLOUD_API_KEY) return true;
  try {
    const h = { "X-API-Key": env.YCLOUD_API_KEY };
    const numeros = (await (await fetch("https://api.ycloud.com/v2/whatsapp/phoneNumbers?limit=20", { headers: h })).json()) as { items?: Array<{ phoneNumber?: string; wabaId?: string }> };
    const mio = (numeros.items ?? []).find((n) => String(n.phoneNumber ?? "").replace(/\D/g, "") === (env.YCLOUD_WA_FROM ?? "").replace(/\D/g, "")) ?? numeros.items?.[0];
    if (!mio?.wabaId) return false;
    const t = (await (await fetch(`https://api.ycloud.com/v2/whatsapp/templates?limit=100&filter.wabaId=${encodeURIComponent(mio.wabaId)}`, { headers: h })).json()) as { items?: Array<{ name?: string; status?: string }> };
    const ok = (t.items ?? []).some((x) => x.name === nombre && x.status === "APPROVED");
    if (ok) await settings.set(marca, nombre);
    return ok;
  } catch (e) {
    console.error("[reactivacionMasiva] estado de la plantilla:", e);
    return false;
  }
}

export async function runReactivacionMasiva(env: Env, now = Date.now(), f?: FetchFn): Promise<{ sent: number; omitidos: number; fallos: number }> {
  const out = { sent: 0, omitidos: 0, fallos: 0 };
  const settings = new SettingsRepo(new Db(env.DB));
  if (((await settings.get(AJUSTE_MASIVO)) ?? "").trim().toLowerCase() !== "activo") return out;
  if (!zohoListo(env)) return out;
  const texto = ((await settings.get(TPL_REACTIVACION_TEXTO)) ?? "").trim();
  const plantilla = ((await settings.get(TPL_REACTIVACION)) ?? "").trim();
  if (!texto || !plantilla) return out;
  // Mientras Meta no apruebe la plantilla no se intenta nada (así no hay envíos fallidos ni avisos de más): arranca sola al aprobarse.
  if (!(await plantillaAprobada(env, plantilla))) return out;
  const db = new Db(env.DB);
  await asegurar(db);
  const hechos = new Set((await db.all<{ lead_id: string }>("SELECT lead_id FROM crm_reactiva WHERE enviado_en IS NOT NULL OR resultado <> ''")).map((r) => r.lead_id));
  const { candidatosEnEstado } = await import("./crm-zohoapi.local");
  const todos = (await candidatosEnEstado(env, ESTADO_FUTURO_ZOHO, f, now)).filter((c) => !hechos.has(c.id));
  if (todos.length === 0) return out;
  const vistos = new Set<string>();
  let seguidosFallidos = 0;
  for (const cand of todos) {
    if (out.sent >= MAX_POR_PASADA || seguidosFallidos >= 2) break;
    const tel = telefonoInternacional(cand.movil, cand.telefono, cand.pais);
    if (!tel || vistos.has(tel)) {
      out.omitidos++;
      continue;
    }
    vistos.add(tel);
    const r = await enviarReactivacion(env, cand.id, texto, { f, fijo: { oferta: OFERTA_MASIVA }, cand }, now);
    if (r.ok) {
      out.sent++;
      seguidosFallidos = 0;
    } else if (/madrugada/.test(r.error)) {
      out.omitidos++; // se reintenta en la próxima pasada
    } else if (/plantilla|No se pudo enviar/.test(r.error)) {
      out.fallos++;
      seguidosFallidos++;
      console.error(`[reactivacionMasiva] ${cand.id}: ${r.error}`);
    } else {
      out.omitidos++;
    }
  }
  if (out.sent > 0 || out.fallos > 0) {
    try {
      const { notifyCamila } = await import("../src/lib/camila");
      const { selfOrigin } = await import("../src/lib/self-origin");
      await notifyCamila(env, {
        heading: out.fallos ? "⚠️ Reactivación: hubo envíos que fallaron" : "♻️ Reactivación enviada",
        body: `Mensaje de Maricela (Bogotá / playa) enviado a ${out.sent} cliente(s) que estaban en «Revisar en el futuro».${out.fallos ? ` ${out.fallos} fallaron (¿la plantilla ya está aprobada?).` : ""} Las respuestas se ven en Reactivación del CRM y el bot las atiende.`,
        url: `${await selfOrigin(env)}/admin`,
      }).catch(() => false);
    } catch {
      /* el aviso nunca tumba el envío */
    }
  }
  return out;
}
