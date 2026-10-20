/**
 * AUDITOR CON IA (aprobado por Brayan el 20 oct 2026, ~2 USD/día). Una vez al día (a partir de las 06:00 UTC) revisa las conversaciones de
 * las últimas 24 h con al menos 3 mensajes del cliente y juzga si el bot actuó mal: ignoró un mensaje, no ofreció la videollamada con los
 * datos completos, agendó a una hora distinta de la elegida, dijo algo sin respaldo, repitió preguntas, etc. Procesa pocas conversaciones por
 * pasada de 5 min (cola en el ajuste `auditoria_ia_cola`), con tope diario, y deja los hallazgos en la tabla del auditor (tipo `revision_ia`).
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { registrarHallazgo } from "./auditor";

const H = 3_600_000;
const POR_PASADA = 5;
const TOPE_DIARIO = 60;
const HORA_INICIO_UTC = 6;

const REGLAS = `Eres el auditor de calidad del chatbot de ventas de Viventa (asesoría de Maricela Naranjo para colombianos en el exterior que quieren comprar vivienda en Colombia). Recibes la transcripción de UNA conversación (CLIENTE / BOT / EQUIPO; entre corchetes, las herramientas que usó el bot) y decides si el bot actuó mal.
Cómo debe ser el bot: sigue un guion corto (autorización de datos; nombre, correo y, solo en Instagram, número de WhatsApp; país y ciudad donde vive; ciudad de Colombia; compra ahora o a futuro; ahorro; cuota mensual; empleo; ingresos; situación de residencia) y, al terminar los datos o si el cliente pide ver proyectos, ofrece la videollamada de 30 minutos con Maricela (botones de día y hora) y la agenda con agendarCita. Un solo mensaje corto por turno. No inventa datos, precios, proyectos, créditos ni fechas; si no sabe, avisa al equipo y se lo dice al cliente.
Busca SOLO problemas reales y concretos, de estos tipos:
- "ignorado": un mensaje del cliente (pregunta, cambio de hora, queja) que el bot no contestó o contestó sin relación.
- "sin_videollamada": ya había datos completos o el cliente pidió ver proyectos y el bot NO ofreció la videollamada, o la oferta quedó sin cerrar.
- "hora_distinta": el bot agendó (agendarCita) una fecha/hora diferente a la que el cliente eligió o pidió.
- "dato_inventado": el bot afirmó algo que no puede saber o prometió algo indebido (precio, disponibilidad, crédito aprobado, que alcanza un monto).
- "repetido": preguntó lo mismo varias veces o entró en un bucle.
- "mal_trato": tono inadecuado, respuesta fuera de lugar o error evidente de idioma o contexto.
No marques como problema: un cliente que simplemente dejó de contestar, mensajes de cortesía sin respuesta, ni diferencias menores de estilo.
Responde SOLO con un JSON válido: {"gravedad":"ninguna"|"media"|"alta","problemas":[{"tipo":"…","detalle":"una frase concreta que cite el mensaje del cliente o del bot"}]}. "alta" = se puede perder un cliente (no se agendó, hora equivocada, ignoraron una pregunta importante); "media" = fallo que conviene corregir.`;

export interface ResultadoIA {
  gravedad: "ninguna" | "media" | "alta";
  problemas: Array<{ tipo: string; detalle: string }>;
}

export function leerResultadoIA(texto: string): ResultadoIA | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { gravedad?: string; problemas?: Array<{ tipo?: string; detalle?: string }> };
    const g = String(j.gravedad ?? "").toLowerCase();
    const gravedad = g === "alta" ? "alta" : g === "media" ? "media" : "ninguna";
    const problemas = (j.problemas ?? []).filter((p) => p?.detalle).map((p) => ({ tipo: String(p.tipo ?? "otro").slice(0, 30), detalle: String(p.detalle).replace(/\s+/g, " ").slice(0, 220) })).slice(0, 4);
    return { gravedad: problemas.length === 0 ? "ninguna" : gravedad === "ninguna" ? "media" : gravedad, problemas };
  } catch {
    return null;
  }
}

/** Transcripción compacta (rol, hora UTC, texto) con las herramientas que usó el bot; se queda con el final si es muy larga. */
async function transcripcion(db: Db, convId: string, desde: number): Promise<string> {
  const ms = await db.all<{ role: string; content: string; tool_calls: string | null; created_at: number }>(
    "SELECT role, content, tool_calls, created_at FROM messages WHERE conversation_id = ? AND created_at > ? AND role IN ('user', 'assistant', 'owner') ORDER BY created_at ASC",
    [convId, desde],
  );
  const quien = (r: string) => (r === "user" ? "CLIENTE" : r === "owner" ? "EQUIPO" : "BOT");
  const lineas = ms.map((m) => {
    let tools = "";
    if (m.tool_calls) {
      try {
        const t = JSON.parse(m.tool_calls) as Array<{ toolName?: string; input?: Record<string, unknown> }>;
        tools = t
          .map((x) => (x.toolName === "agendarCita" ? `agendarCita ${String(x.input?.["fecha"] ?? "")} ${String(x.input?.["hora"] ?? "")}` : x.toolName === "handoffHuman" ? "handoffHuman" : ""))
          .filter(Boolean)
          .join(", ");
      } catch {
        /* sin herramientas legibles */
      }
    }
    const hora = new Date(m.created_at).toISOString().slice(11, 16);
    return `${quien(m.role)} ${hora}: ${m.content.replace(/\[\[[^\]]*\]\]/g, "[botones]").replace(/\s+/g, " ").slice(0, 330)}${tools ? ` [${tools}]` : ""}`;
  });
  let texto = lineas.join("\n");
  if (texto.length > 6500) texto = "(…inicio omitido…)\n" + texto.slice(-6500);
  return texto;
}

export interface MejoraSugerida {
  titulo: string;
  texto: string;
  aplicada?: string;
}

/** Con los problemas del día, propone reglas nuevas para las instrucciones del bot (no las aplica: las aprueba el administrador en CRM → Auditoría). */
async function proponerMejoras(env: Env, db: Db, st: SettingsRepo, hoy: string, generar?: (prompt: string) => Promise<string>): Promise<void> {
  const hs = await db.all<{ detalle: string }>("SELECT detalle FROM auditoria_hallazgos WHERE tipo = 'revision_ia' AND clave = ? ORDER BY id", [hoy]);
  if (hs.length === 0) return;
  const reglasActuales = ((await st.get("custom_instructions")) ?? "")
    .split("\n")
    .filter((l) => /^REGLA/i.test(l.trim()))
    .map((l) => `- ${l.slice(0, 120)}`)
    .slice(-30)
    .join("\n");
  const prompt = `Eres el mejorador del chatbot de ventas de Viventa. Estos son los problemas que el auditor encontró hoy en conversaciones reales del bot:\n${hs.map((h) => `- ${h.detalle}`).join("\n")}\n\nReglas que ya tiene el bot (resumen):\n${reglasActuales || "(ninguna)"}\n\nPropón hasta 3 reglas NUEVAS y concretas que corrijan los problemas repetidos o graves (no repitas reglas que ya existen). Cada regla: un título corto y un texto listo para añadir a las instrucciones, en español, que empiece por "REGLA NUEVA (${hoy}, propuesta por el auditor):", con instrucciones claras de qué hacer y qué NO hacer. Responde SOLO con JSON: {"reglas":[{"titulo":"…","texto":"…"}]}`;
  let salida = "";
  if (generar) salida = await generar(prompt);
  else {
    const { workModel } = await import("../llm/work-model");
    const llm = await workModel(env, "smart", "insights");
    salida = ((await llm.generate({ prompt, maxOutputTokens: 1500, temperature: 0.2 } as never)) as { text?: string }).text ?? "";
  }
  const m = salida.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const j = JSON.parse(m[0]) as { reglas?: Array<{ titulo?: string; texto?: string }> };
    const reglas: MejoraSugerida[] = (j.reglas ?? []).filter((r) => r?.titulo && r?.texto).map((r) => ({ titulo: String(r.titulo).slice(0, 90), texto: String(r.texto).slice(0, 1800) })).slice(0, 3);
    if (reglas.length === 0) return;
    await st.set("auditoria_ia_mejoras", JSON.stringify({ fecha: hoy, reglas }));
    await registrarHallazgo(env, { tipo: "mejora_sugerida", convId: "bot", clave: hoy, detalle: `El auditor propone ${reglas.length} ${reglas.length === 1 ? "regla nueva" : "reglas nuevas"} para el bot: ${reglas.map((r) => r.titulo).join(" · ")}. Revísalas en CRM → Auditoría.` });
  } catch (e) {
    console.error("[auditor-ia] mejoras:", e);
  }
}

/** Añade al final de las instrucciones del bot una mejora sugerida (con copia de seguridad previa). Solo la llama el administrador. */
export async function aplicarMejora(env: Env, indice: number, now = Date.now()): Promise<{ ok: boolean; mensaje: string }> {
  const st = new SettingsRepo(new Db(env.DB));
  let sug: { fecha: string; reglas: MejoraSugerida[] } | null = null;
  try {
    sug = JSON.parse((await st.get("auditoria_ia_mejoras")) ?? "null");
  } catch {
    sug = null;
  }
  const r = sug?.reglas?.[indice];
  if (!sug || !r) return { ok: false, mensaje: "Esa sugerencia ya no existe." };
  if (r.aplicada) return { ok: false, mensaje: "Esa regla ya se aplicó." };
  const actual = (await st.get("custom_instructions")) ?? "";
  if (!actual.trim()) return { ok: false, mensaje: "El bot no tiene instrucciones guardadas: no se cambia nada." };
  await st.set(`custom_instructions_respaldo_${sug.fecha}-auditor-${indice + 1}`, actual);
  await st.set("custom_instructions", `${actual.trimEnd()}\n\n${r.texto.trim()}`);
  r.aplicada = new Date(now).toISOString();
  await st.set("auditoria_ia_mejoras", JSON.stringify(sug));
  return { ok: true, mensaje: "Regla añadida a las instrucciones del bot (con copia de seguridad). Ya está en uso." };
}

export async function runAuditorIA(env: Env, now = Date.now(), generar?: (prompt: string) => Promise<string>): Promise<{ revisadas: number }> {
  const st = new SettingsRepo(new Db(env.DB));
  const db = new Db(env.DB);
  const hoy = new Date(now).toISOString().slice(0, 10);
  let cola: { fecha: string; ids: string[]; idx: number; problemas: number } | null = null;
  try {
    cola = JSON.parse((await st.get("auditoria_ia_cola")) ?? "null");
  } catch {
    cola = null;
  }
  if (!cola || cola.fecha !== hoy) {
    if (new Date(now).getUTCHours() < HORA_INICIO_UTC) return { revisadas: 0 };
    const ids = (
      await db.all<{ id: string }>(
        `SELECT c.id FROM conversations c
          WHERE c.last_message_at > ? AND c.channel IN ('ycloud', 'zernio')
            AND (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.created_at > ?) >= 3
          ORDER BY c.last_message_at DESC LIMIT ?`,
        [now - 24 * H, now - 24 * H, TOPE_DIARIO],
      )
    ).map((r) => r.id);
    cola = { fecha: hoy, ids, idx: 0, problemas: 0 };
  }
  if (cola.idx >= cola.ids.length) return { revisadas: 0 };

  let llm: { modelId: string; generate: (a: never) => Promise<{ text: string }> } | null = null;
  if (!generar) {
    const { workModel } = await import("../llm/work-model");
    llm = (await workModel(env, "smart", "insights")) as unknown as typeof llm;
  }
  let revisadas = 0;
  const lote = cola.ids.slice(cola.idx, cola.idx + POR_PASADA);
  for (const id of lote) {
    cola.idx++;
    try {
      const texto = await transcripcion(db, id, now - 24 * H);
      if (!texto) continue;
      const prompt = `${REGLAS}\n\nTRANSCRIPCIÓN (últimas 24 h):\n${texto}`;
      const salida = generar ? await generar(prompt) : ((await llm!.generate({ prompt, maxOutputTokens: 700, temperature: 0 } as never)).text ?? "");
      revisadas++;
      const r = leerResultadoIA(salida);
      if (!r || r.gravedad === "ninguna") continue;
      cola.problemas++;
      const conv = await db.first<{ display_name: string | null }>("SELECT display_name FROM conversations WHERE id = ?", [id]);
      await registrarHallazgo(env, { tipo: "revision_ia", convId: id, clave: hoy, detalle: `${conv?.display_name || "Cliente"} (${r.gravedad}): ${r.problemas.map((p) => `${p.tipo}: ${p.detalle}`).join(" · ")}`.slice(0, 400) }, now);
    } catch (e) {
      console.error(`[auditor-ia] ${id}:`, e);
    }
  }
  await st.set("auditoria_ia_cola", JSON.stringify(cola));
  if (cola.idx >= cola.ids.length) {
    await st.set("auditoria_ia_ultimo", JSON.stringify({ fecha: hoy, revisadas: cola.ids.length, conProblemas: cola.problemas }));
    await proponerMejoras(env, db, st, hoy, generar).catch((e) => console.error("[auditor-ia] proponerMejoras:", e));
  }
  return { revisadas };
}
