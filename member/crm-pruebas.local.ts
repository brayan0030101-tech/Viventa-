// member/crm-pruebas.local.ts — «Probar el bot»: conversaciones de prueba contra las instrucciones ACTUALES del bot.
// Cada escenario manda al modelo las instrucciones reales + una conversación corta y comprueba que la respuesta cumpla lo acordado
// (p. ej. «si dice 150 € al mes: explicar el mínimo y las opciones, sin ofrecer videollamada»). Cuesta ≈ 0,40 USD por corrida (≈ 10 llamadas a la IA);
// la corre el administrador a mano antes y después de cambiar las instrucciones. No escribe nada a clientes ni a Zoho.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { workModel } from "../src/llm/work-model";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, fechaHora } from "./crm.local";

type Turno = { role: "user" | "assistant"; content: string };
export interface Escenario {
  id: string;
  titulo: string;
  canal?: "WhatsApp" | "Instagram";
  previo: Turno[];
  cliente: string;
  /** Cada comprobación: descripción + función sobre la respuesta (sin tildes y en minúsculas). */
  espera: Array<{ que: string; ok: (r: string) => boolean }>;
}

const sin = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const apertura: Turno[] = [
  { role: "user", content: "Hola Maricela, vi tu perfil y quiero información para comprar vivienda en Colombia" },
  { role: "assistant", content: "Hola, gracias por escribirnos. Te atiende el equipo comercial de Maricela Naranjo. Para orientarte mejor, voy a hacerte unas preguntas muy sencillas. Antes de empezar, ¿nos autorizas a registrar los datos que nos compartas para gestionar tu asesoría y hacer seguimiento a tu solicitud?" },
  { role: "user", content: "Sí" },
  { role: "assistant", content: "Gracias. ¿Me compartes tu nombre completo y correo electrónico?" },
  { role: "user", content: "Laura Pérez, laura@correo.com" },
  { role: "assistant", content: "Mucho gusto, Laura. ¿En qué país y ciudad vives actualmente, y en qué ciudad de Colombia te gustaría comprar vivienda?" },
  { role: "user", content: "Vivo en Madrid y quiero comprar en Cali" },
  { role: "assistant", content: "Qué bien. ¿La vivienda sería para ti o tu familia, como inversión, o un poquito de las dos?" },
  { role: "user", content: "Para inversión" },
  { role: "assistant", content: "¿Te gustaría comprar próximamente o prefieres un proyecto a futuro para ir pagando la cuota inicial?" },
  { role: "user", content: "A futuro" },
  { role: "assistant", content: "¿Tienes algún ahorro disponible para la cuota inicial? Si es así, ¿de cuánto aproximadamente?" },
  { role: "user", content: "Unos 3000 euros" },
];
const preguntaCuota: Turno[] = [...apertura, { role: "assistant", content: "¿Cuánto podrías destinar mensualmente a la compra de tu vivienda?" }];
const preguntaIngresos: Turno[] = [...apertura, { role: "user", content: "Puedo destinar 500 euros al mes" }, { role: "assistant", content: "¿Trabajas como empleada o por tu cuenta, y de cuánto son tus ingresos mensuales aproximadamente?" }];

export const ESCENARIOS: Escenario[] = [
  { id: "cuota_baja", titulo: "Dice que puede destinar 150 € al mes", previo: preguntaCuota, cliente: "Unos 150 euros al mes",
    espera: [
      { que: "explica el mínimo (1.300.000 pesos o 400 euros)", ok: (r) => /1\.?300\.?000|400/.test(r) },
      { que: "ofrece alternativas (abono menor, CDT, prima o ingreso extra)", ok: (r) => /abono|cdt|prima|ingreso extra|pago adicional/.test(r) },
      { que: "NO ofrece videollamada", ok: (r) => !/videollamada|agendar|agenda/.test(r) },
    ] },
  { id: "pide_datacredito", titulo: "Después de los ingresos pregunta por Datacrédito", previo: preguntaIngresos, cliente: "Soy empleada y gano 1800 euros al mes",
    espera: [{ que: "pregunta si está reportada en Datacrédito", ok: (r) => /datacredito|reportad/.test(r) }, { que: "no habla de precios ni de videollamada todavía", ok: (r) => !/videollamada/.test(r) }] },
  { id: "reportado", titulo: "Dice que está reportado", previo: [...preguntaIngresos, { role: "user", content: "Soy empleada, gano 1800 euros" }, { role: "assistant", content: "¿Estás reportada en Datacrédito (centrales de riesgo)? Te lo preguntamos solo para saber si podemos gestionar un crédito." }], cliente: "Sí, estoy reportada",
    espera: [{ que: "pregunta si puede ponerse al día o quitar el reporte", ok: (r) => /al dia|quitar|ponerte|pagar|saldar/.test(r) }, { que: "NO ofrece videollamada", ok: (r) => !/videollamada|agendar/.test(r) }] },
  { id: "compra_pareja", titulo: "Compra con su esposo", previo: [...preguntaIngresos, { role: "user", content: "Empleada, 1800 euros" }, { role: "assistant", content: "¿Estás reportada en Datacrédito?" }, { role: "user", content: "No" }, { role: "assistant", content: "¿Comprarías sola o con otra persona (pareja o familiar)?" }], cliente: "Con mi esposo",
    espera: [{ que: "pide nombre, correo o teléfono de la otra persona", ok: (r) => /nombre|correo|telefono|numero/.test(r) }, { que: "pregunta por sus ingresos", ok: (r) => /ingreso|gana|sueldo|trabaj/.test(r) }] },
  { id: "no_interesa", titulo: "Dice que ya no le interesa", previo: apertura, cliente: "Ya no estoy interesada, gracias",
    espera: [{ que: "se despide con respeto", ok: (r) => /respet|gracias|entend|aqui estamos/.test(r) }, { que: "no insiste (sin cotización, videollamada ni nuevas preguntas)", ok: (r) => !/cotiz|videollamada|agend/.test(r) && !/\?/.test(r) }] },
  { id: "pregunta_precio", titulo: "Pregunta el precio en medio del guion", previo: preguntaCuota, cliente: "¿Y cuánto cuesta un apartamento en Cali?",
    espera: [{ que: "no inventa precios", ok: (r) => !/\$\s?\d|\d+\s?millones/.test(r) }, { que: "retoma su pregunta pendiente", ok: (r) => /\?/.test(r) }] },
  { id: "pide_persona", titulo: "Pide hablar con una persona", previo: apertura, cliente: "Prefiero hablar con una persona, no con un bot",
    espera: [{ que: "pasa el caso al equipo", ok: (r) => /equipo|paso tu caso|te escrib/.test(r) }] },
  { id: "es_bot", titulo: "Pregunta si es un bot", previo: apertura, cliente: "¿Eres un bot o una persona?",
    espera: [{ que: "responde con honestidad (asistente virtual)", ok: (r) => /asistente virtual|asistente|inteligencia artificial/.test(r) }, { que: "no se hace pasar por Maricela", ok: (r) => !/soy maricela/.test(r) }] },
  { id: "instagram_whatsapp", titulo: "Instagram: primer mensaje → autorización, nombre y pasar a WhatsApp", canal: "Instagram", previo: [], cliente: "Hola Maricela, vi tu perfil y quiero información para comprar vivienda",
    espera: [
      { que: "menciona que seguirán por WhatsApp", ok: (r) => /whatsapp/.test(r) },
      { que: "pide la autorización", ok: (r) => /autoriz/.test(r) },
      { que: "pide el nombre", ok: (r) => /como te llamas|tu nombre|cual es tu nombre/.test(r) },
      { que: "NO empieza el guion de preguntas (ingresos, ahorro, correo)", ok: (r) => !/ingreso|ahorro|correo|cuota/.test(r) },
    ] },
];

export interface ResultadoEscenario { id: string; titulo: string; respuesta: string; checks: Array<{ que: string; ok: boolean }>; ok: boolean; error?: string }

async function asegurarTabla(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS pruebas_bot (id INTEGER PRIMARY KEY AUTOINCREMENT, creado INTEGER NOT NULL, estado TEXT NOT NULL, resultados TEXT NOT NULL DEFAULT '[]')");
}

const MODO_PRUEBA = "\n\nMODO PRUEBA: esto es una simulación. No llames herramientas ni escribas marcas internas: responde SOLO con el mensaje exacto que le enviarías al cliente en este turno.";

export async function correrEscenario(env: Env, e: Escenario, instrucciones: string): Promise<ResultadoEscenario> {
  try {
    const llm = await workModel(env, "smart", "insights");
    const r = await llm.generate({
      system: `${instrucciones}\n\nCANAL ACTUAL: ${e.canal ?? "WhatsApp"}.${MODO_PRUEBA}`,
      messages: [...e.previo, { role: "user", content: e.cliente }],
      maxOutputTokens: 500, temperature: 0,
    } as never);
    const texto = String((r as { text?: string }).text ?? "").trim();
    const n = sin(texto);
    const checks = e.espera.map((c) => ({ que: c.que, ok: c.ok(n) }));
    return { id: e.id, titulo: e.titulo, respuesta: texto, checks, ok: checks.every((c) => c.ok) };
  } catch (err) {
    return { id: e.id, titulo: e.titulo, respuesta: "", checks: [], ok: false, error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  }
}

export async function correrPruebas(env: Env, now = Date.now(), escenarios: Escenario[] = ESCENARIOS): Promise<number> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const instrucciones = (await new SettingsRepo(db).get("custom_instructions")) ?? "";
  const r = await db.run("INSERT INTO pruebas_bot (creado, estado) VALUES (?, 'en curso')", [now]);
  const id = Number((r as { meta?: { last_row_id?: number } }).meta?.last_row_id ?? 0);
  const resultados: ResultadoEscenario[] = [];
  for (let i = 0; i < escenarios.length; i += 3) resultados.push(...(await Promise.all(escenarios.slice(i, i + 3).map((e) => correrEscenario(env, e, instrucciones)))));
  await db.run("UPDATE pruebas_bot SET estado = 'listo', resultados = ? WHERE id = ?", [JSON.stringify(resultados), id]);
  return id;
}

export async function renderPruebas(env: Env, opts: { aviso?: string } = {}): Promise<string> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const ult = await db.first<{ creado: number; estado: string; resultados: string }>("SELECT creado, estado, resultados FROM pruebas_bot ORDER BY id DESC LIMIT 1");
  let res: ResultadoEscenario[] = [];
  try { res = ult ? (JSON.parse(ult.resultados) as ResultadoEscenario[]) : []; } catch { /* sin resultados */ }
  const bien = res.filter((r) => r.ok).length;
  const tarjetas = res.map((r) => `<div class="crm-card" style="padding:12px 16px;margin-bottom:8px;border-left:4px solid ${r.ok ? "var(--ok)" : "var(--bad)"}">
      <div style="font-weight:700;color:var(--cream)">${r.ok ? "✅" : "❌"} ${esc(r.titulo)}</div>
      ${r.error ? `<div style="color:var(--bad);font-size:12px">Error: ${esc(r.error)}</div>` : ""}
      <div class="text-muted" style="font-size:12px;margin:6px 0;white-space:pre-wrap">${esc(r.respuesta)}</div>
      <div style="font-size:11.5px">${r.checks.map((c) => `<div style="color:${c.ok ? "var(--ok)" : "var(--bad)"}">${c.ok ? "✔" : "✘"} ${esc(c.que)}</div>`).join("")}</div></div>`).join("");
  const body = `${ESTILO_CRM}
    ${opts.aviso ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:12px;color:var(--ok);font-size:12.5px">${esc(opts.aviso)}</div>` : ""}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:12px;line-height:1.55">Pone a prueba las instrucciones <b>actuales</b> del bot con ${ESCENARIOS.length} conversaciones típicas (cuota baja, Datacrédito, reportado, pareja, «ya no me interesa»…). Cuesta unos <b>0,40 USD</b> por corrida y tarda cerca de un minuto. Córrela antes y después de cambiar las instrucciones. No escribe a ningún cliente.</div>
    <form method="POST" action="/crm/pruebas/correr" style="margin-bottom:16px" onsubmit="return confirm('Esto usa la IA unas 10 veces (≈ 0,40 USD). ¿Correr las pruebas?')"><button class="bigbtn" style="background:var(--accent);color:var(--bg);padding:9px 16px;font-weight:700;border:0;cursor:pointer">🧪 Correr las pruebas</button></form>
    ${ult ? `<div style="margin-bottom:10px;font-size:13px"><b>Última corrida:</b> ${esc(fechaHora(ult.creado))} · ${ult.estado === "en curso" ? "⏳ en curso (recarga en un minuto)" : `${bien} de ${res.length} bien`}</div>${tarjetas}` : `<div class="text-dim">Todavía no se ha corrido ninguna.</div>`}`;
  return crmLayout({ title: "Probar el bot", activa: "pruebas", body, env });
}
