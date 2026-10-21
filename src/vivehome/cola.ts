/**
 * COTIZACIONES DEL BOT (trabajo en segundo plano, cron propio cada 15 min; nunca dentro de la conversación con el cliente).
 *
 * El bot arma en ViveHome una cotización «como las de Maricela» para quien ya dijo en qué ciudad quiere comprar y cuánto puede pagar al mes, y le
 * manda el enlace por WhatsApp/Instagram. Prioridad: los que no tienen videollamada agendada.
 *
 * Interruptor: ajuste `viventa_cotizaciones_bot` = apagado | piloto | activo (sin valor = apagado).
 *  · piloto: solo las conversaciones del ajuste `viventa_cotizaciones_piloto` (ids separados por coma, máx. 10). Se preparan las propuestas
 *    (proyectos + borrador del mensaje) y NO se crea ni envía nada hasta que su id esté también en `viventa_cotizaciones_piloto_ok`
 *    (lo pone el equipo cuando Brayan aprueba por escrito la lista y los textos).
 *  · activo: todos los clientes con ciudad + cuota mensual, sin videollamada, sin cotización previa (ni del bot ni de Maricela).
 *
 * Cola en D1 (`cotizaciones_bot`), una fila por cliente (ronda 1; una nueva ronda solo si el cliente pide otra → botón en la ficha). Estados:
 *  propuesta → creando → creada → enviada; o pendiente_plantilla (fuera de la ventana de 24 h: no se crea nada hasta que el cliente vuelva a
 *  escribir), sin_proyectos (avisado a Maricela), omitida (la conversación la tomó una persona o ya tiene cotización), error (3 intentos fallidos).
 *
 * Seguridad: solo de 9 a 21 h del cliente; texto libre solo dentro de la ventana de 24 h; la casilla «Reportar a la constructora» siempre
 * desmarcada; cuota inicial 20 % (o la que pida el proyecto, hasta 30 %); cualquier fallo de ViveHome (pantalla cambiada, sin sesión…) queda como hallazgo del auditor y aviso al equipo.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { armarLeads, correoParaFormulario, evaluarCalificacion, type LeadResumen } from "../followup/resumenDia";
import { puedeEscribirAhora } from "../lib/horarioCliente";
import { registrarHallazgo } from "../followup/auditor";
import { asegurarTablaCotizaciones } from "../followup/cotizaciones";
import { ErrorPantalla, URL_PUBLICA, type Catalogo, type Pagina, type ProyectoPublico } from "./navegador";
import { ciudadesBuscadas, elegirProyectos, leerCapacidad, primerNombre, textoMensaje, pesos, type Elegido } from "./reglas";

/** Primera ciudad que nombró el cliente (para aclarar «muy cerca de …» si las opciones son de una ciudad vecina). */
function ciudadDelCliente(lead: LeadResumen, items: Elegido[]): string | undefined {
  return ciudadesBuscadas(lead.ficha.metadata.ciudadCompra, items.map((i) => i.ciudad))?.nombradas[0];
}

export const AJUSTE_MODO = "viventa_cotizaciones_bot";
export const AJUSTE_PILOTO = "viventa_cotizaciones_piloto";
export const AJUSTE_PILOTO_OK = "viventa_cotizaciones_piloto_ok";
const AJUSTE_CANDADO = "viventa_cotizaciones_bot_candado";
/** Interruptor aparte para la plantilla de WhatsApp (cada envío lo cobra Meta): apagado | activo. */
export const AJUSTE_PLANTILLA = "viventa_cotizaciones_plantilla";
/** Plantilla aprobada por Brayan el 21 oct 2026 (marketing, es_ES, {{1}} = primer nombre; botones «Sí, envíamela» / «Ahora no»). */
export const PLANTILLA_COTIZACION = "viventa_cotizacion_lista";
export const TEXTO_PLANTILLA = (nombre: string) =>
  `Hola ${nombre}, te escribe el equipo de Maricela Naranjo (Viventa). Con los datos que nos compartiste te preparamos una cotización personalizada de vivienda en Colombia: el valor, la cuota inicial y cuánto pagarías al mes. ¿Te la enviamos por aquí?\n[Sí, envíamela] [Ahora no]`;
const MAX_PLANTILLAS_POR_PASADA = 8;
/** Respuestas que significan «no quiero la cotización» (botón «Ahora no» de la plantilla o texto parecido). */
export const RE_NO_QUIERE = /^\s*(ahora no|no,? gracias|no me interesa|no quiero|ya no)\b/i;

const MIN = 60_000;
const H = 60 * MIN;
const DIA = 24 * H;
/** Margen antes de que se cierre la ventana de 24 h (crear y enviar toma unos minutos). */
const VENTANA = 23 * H;
const MAX_CREAR_POR_PASADA = 3;
const MAX_NUEVAS_POR_PASADA = 10;
const MAX_INTENTOS = 3;
const CATALOGO_VIGENTE = 20 * H;

export type Modo = "apagado" | "piloto" | "activo";
export type Estado = "propuesta" | "creando" | "creada" | "enviada" | "pendiente_plantilla" | "sin_proyectos" | "omitida" | "error" | "pedida";

export interface FilaCola {
  id: number;
  conv_id: string;
  ronda: number;
  estado: Estado;
  tipo: "a_la_medida" | "mas_economicas" | null;
  capacidad: number | null;
  capacidad_texto: string | null;
  ciudad_texto: string | null;
  items: string | null;
  cot_id: string | null;
  mensaje: string | null;
  intentos: number;
  error: string | null;
  creado: number;
  actualizado: number;
  enviado_en: number | null;
  plantilla_en?: number | null;
}

export async function asegurarTablasCola(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS cotizaciones_bot (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL, ronda INTEGER NOT NULL DEFAULT 1,
      estado TEXT NOT NULL, tipo TEXT, capacidad INTEGER, capacidad_texto TEXT, ciudad_texto TEXT, items TEXT, cot_id TEXT, mensaje TEXT,
      intentos INTEGER NOT NULL DEFAULT 0, error TEXT, creado INTEGER NOT NULL, actualizado INTEGER NOT NULL, enviado_en INTEGER, UNIQUE (conv_id, ronda))`,
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_cotbot_estado ON cotizaciones_bot (estado)");
  // Cuándo se le mandó la plantilla de WhatsApp (una sola vez por fila).
  await db.run("ALTER TABLE cotizaciones_bot ADD COLUMN plantilla_en INTEGER").catch(() => undefined);
  await db.run("CREATE TABLE IF NOT EXISTS vivehome_catalogo (id INTEGER PRIMARY KEY CHECK (id = 1), leido_en INTEGER NOT NULL, eur REAL NOT NULL, usd REAL NOT NULL, datos TEXT NOT NULL)");
}

export async function leerModo(db: Db): Promise<Modo> {
  const v = ((await new SettingsRepo(db).get(AJUSTE_MODO)) ?? "").trim().toLowerCase();
  return v === "piloto" || v === "activo" ? v : "apagado";
}

const lista = (v: string | null) =>
  String(v ?? "")
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// ─── Catálogo guardado ───────────────────────────────────────────────────────

export async function catalogoGuardado(db: Db): Promise<(Catalogo & { leidoEn: number }) | null> {
  const r = await db.first<{ leido_en: number; eur: number; usd: number; datos: string }>("SELECT leido_en, eur, usd, datos FROM vivehome_catalogo WHERE id = 1");
  if (!r) return null;
  try {
    return { leidoEn: r.leido_en, eur: r.eur, usd: r.usd, tipologias: JSON.parse(r.datos) };
  } catch {
    return null;
  }
}

export async function guardarCatalogo(db: Db, c: Catalogo, now: number): Promise<void> {
  await db.run("INSERT OR REPLACE INTO vivehome_catalogo (id, leido_en, eur, usd, datos) VALUES (1, ?, ?, ?, ?)", [now, c.eur, c.usd, JSON.stringify(c.tipologias)]);
}

// ─── Candidatos ──────────────────────────────────────────────────────────────

interface ConvFila {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  last_message_at: number;
  paused_until: number | null;
  metadata: string | null;
}

async function convsPorId(db: Db, ids: string[]): Promise<ConvFila[]> {
  const out: ConvFila[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const lote = ids.slice(i, i + 80);
    out.push(
      ...(await db.all<ConvFila>(
        `SELECT id, channel, channel_user_id, display_name, last_message_at, paused_until, metadata FROM conversations WHERE id IN (${lote.map(() => "?").join(",")})`,
        lote,
      )),
    );
  }
  return out;
}

async function leadsDe(db: Db, convs: ConvFila[]): Promise<LeadResumen[]> {
  const ids = convs.map((c) => c.id);
  const filas: Array<{ conversation_id: string | null; name: string | null; contact: string | null; notes: string | null; metadata: string | null }> = [];
  for (let i = 0; i < ids.length; i += 80) {
    const lote = ids.slice(i, i + 80);
    filas.push(
      ...(await db.all<(typeof filas)[number]>(
        `SELECT conversation_id, name, contact, notes, metadata FROM leads WHERE conversation_id IN (${lote.map(() => "?").join(",")}) AND intent NOT LIKE 'Cita ·%' ORDER BY created_at ASC`,
        lote,
      )),
    );
  }
  return armarLeads(convs, filas);
}

const descartada = (c: ConvFila): boolean => {
  try {
    const m = JSON.parse(c.metadata ?? "{}") as { crm_etapa?: string; crm_descarte?: unknown };
    return !!m.crm_descarte || m.crm_etapa === "cerrado" || m.crm_etapa === "perdido";
  } catch {
    return false;
  }
};

const ultimos9 = (s: string) => s.replace(/\D/g, "").slice(-9);

const RECHAZO = /ya no (estoy|me) interesad|no (estoy|me) interesad|no me interesa|no quiero (m[aá]s )?(informaci|que me escrib)|dejen de escribir|no (me )?escrib[ai]n m[aá]s/i;

/**
 * ¿El cliente dijo que NO le interesa (último mensaje suyo, aquí o en la conversación enlazada de Instagram↔WhatsApp) o el bot anotó «No quiere continuar»?
 * Pasó el 21 oct: un cliente tocó «Ya no estoy interesado/a» y 10 min después le llegó una cotización.
 */
export async function dijoQueNo(db: Db, convId: string): Promise<boolean> {
  const ids = new Set<string>([convId]);
  const enlace = await db.first<{ m: string | null }>("SELECT json_extract(COALESCE(metadata, '{}'), '$.viventa_retomar_ig') AS m FROM conversations WHERE id = ?", [convId]);
  if (enlace?.m) ids.add(enlace.m);
  for (const r of await db.all<{ id: string }>("SELECT id FROM conversations WHERE json_extract(COALESCE(metadata, '{}'), '$.viventa_retomar_ig') = ?", [convId])) ids.add(r.id);
  for (const id of ids) {
    const msgs = await db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 3", [id]);
    if (msgs.some((m) => RECHAZO.test(m.content))) return true;
    const notas = await db.all<{ notes: string | null }>("SELECT notes FROM leads WHERE conversation_id = ? AND notes IS NOT NULL", [id]);
    if (notas.some((l) => /no quiere continuar/i.test(l.notes ?? ""))) return true;
  }
  return false;
}

/** Conversaciones a considerar según el modo (sin las que ya tienen fila en la cola). */
async function candidatos(db: Db, modo: Modo, now: number): Promise<ConvFila[]> {
  const conFila = new Set((await db.all<{ conv_id: string }>("SELECT DISTINCT conv_id FROM cotizaciones_bot")).map((r) => r.conv_id));
  if (modo === "piloto") {
    const ids = lista(await new SettingsRepo(db).get(AJUSTE_PILOTO)).slice(0, 10);
    return (await convsPorId(db, ids)).filter((c) => !conFila.has(c.id));
  }
  const ids = (
    await db.all<{ conversation_id: string }>(
      `SELECT DISTINCT conversation_id FROM leads WHERE conversation_id IS NOT NULL AND updated_at > ?
         AND json_extract(metadata, '$.ciudadCompra') IS NOT NULL AND json_extract(metadata, '$.capacidadMensual') IS NOT NULL`,
      [now - 120 * DIA],
    )
  )
    .map((r) => r.conversation_id)
    .filter((id) => !conFila.has(id));
  const conCita = new Set((await db.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM leads WHERE intent LIKE 'Cita ·%'")).map((r) => r.conversation_id));
  const posibles = (await convsPorId(db, ids.filter((id) => !conCita.has(id)))).filter((c) => ["ycloud", "zernio"].includes(c.channel) && !descartada(c));
  const out: ConvFila[] = [];
  for (const c of posibles) if (!(await dijoQueNo(db, c.id))) out.push(c);
  return out;
}

/** ¿Ya recibió una cotización de Maricela (enlace de ViveHome en un mensaje saliente)? */
async function yaTieneCotizacion(db: Db, lead: LeadResumen): Promise<boolean> {
  const tel = ultimos9(lead.telefono);
  if (tel.length < 9) return false;
  const r = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM cotizaciones_enviadas WHERE substr(tel, -9) = ?", [tel]);
  return (r?.n ?? 0) > 0;
}

async function ultimoDelCliente(db: Db, convId: string): Promise<number | null> {
  return (await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [convId]))?.t ?? null;
}

// ─── Propuestas ──────────────────────────────────────────────────────────────

export interface Propuesta {
  estado: "propuesta" | "sin_proyectos" | null;
  tipo: "a_la_medida" | "mas_economicas" | null;
  capacidad: number | null;
  items: Elegido[];
  motivo: string;
}

/** Decide qué cotizar a un cliente con el catálogo de ViveHome. estado null = faltan datos (no se cotiza, no se guarda). */
export function proponer(lead: LeadResumen, cat: Catalogo): Propuesta {
  const m = lead.ficha.metadata;
  const cap = leerCapacidad(m.capacidadMensual, cat);
  if (!cap) return { estado: null, tipo: null, capacidad: null, items: [], motivo: `cuota mensual no clara («${m.capacidadMensual ?? ""}»)` };
  const ciudades = ciudadesBuscadas(m.ciudadCompra, [...new Set(cat.tipologias.map((t) => t.ciudad))]);
  if (!ciudades) return { estado: null, tipo: null, capacidad: cap.pesos, items: [], motivo: `ciudad no clara («${m.ciudadCompra ?? ""}»)` };
  const e = ciudades.conArea.length ? elegirProyectos(cat.tipologias, ciudades.conArea, cap.pesos) : ({ tipo: "sin_proyectos", items: [], motivo: "sin_20" } as const);
  if (e.tipo === "sin_proyectos")
    return {
      estado: "sin_proyectos",
      tipo: null,
      capacidad: cap.pesos,
      items: [],
      motivo:
        e.motivo === "muy_caro"
          ? `en «${m.ciudadCompra ?? ""}» lo más económico cuesta más de 2,5 veces su cuota (${pesos(cap.pesos)}/mes)`
          : `no hay proyectos (con cuota inicial de hasta 30 %) en ViveHome para «${m.ciudadCompra ?? ""}» ni en su área metropolitana`,
    };
  return { estado: "propuesta", tipo: e.tipo, capacidad: cap.pesos, items: e.items, motivo: "" };
}

/** Borrador del mensaje con las cifras estimadas (el definitivo usa las cifras exactas de la cotización publicada). */
export function borradorMensaje(lead: LeadResumen, p: Propuesta): string {
  const ej = [...p.items].sort((a, b) => a.mensual - b.mensual)[0];
  return textoMensaje({
    nombre: primerNombre(lead.nombre),
    tipo: p.tipo ?? "a_la_medida",
    enlace: `${URL_PUBLICA}[número]`,
    ciudades: p.items.map((i) => i.ciudad),
    ciudadCliente: ciudadDelCliente(lead, p.items),
    pcts: p.items.map((i) => i.pct ?? 20),
    n: p.items.length,
    ejemplo: { proyecto: ej?.proyecto ?? "", mensualidad: ej?.mensual ?? 0, meses: ej?.meses ?? 0 },
  });
}

// ─── Pasada principal ────────────────────────────────────────────────────────

export interface Dependencias {
  /** Envía la plantilla de WhatsApp (en el Worker: YCloud). */
  enviarPlantilla?: (env: Env, telefono: string, nombre: string) => Promise<void>;
  /** ¿Meta ya aprobó la plantilla? */
  plantillaAprobada?: (env: Env) => Promise<boolean>;
  /** Abre un navegador ya listo (en el Worker: Cloudflare Browser Rendering). */
  abrirNavegador?: (env: Env) => Promise<{ page: Pagina; cerrar: () => Promise<void> }>;
  enviar?: (env: Env, t: { conversationId: string; channel: string; channelUserId: string; text: string }, now: number) => Promise<void>;
  avisar?: (env: Env, heading: string, body: string) => Promise<void>;
  navegador?: typeof import("./navegador");
}

async function abrirNavegadorCloudflare(env: Env): Promise<{ page: Pagina; cerrar: () => Promise<void> }> {
  if (!env.BROWSER) throw new ErrorPantalla("navegador", "falta el binding BROWSER (Cloudflare Browser Rendering) en wrangler.toml");
  const { launch } = await import("@cloudflare/playwright");
  const browser = await launch(env.BROWSER as never);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } } as never);
  return { page, cerrar: () => browser.close() };
}

async function avisoEquipo(env: Env, heading: string, body: string): Promise<void> {
  const { notifyCamila } = await import("../lib/camila");
  await notifyCamila(env, { heading, body, url: `${env.DASHBOARD_BASE_URL || ""}/crm/cotizaciones` }).catch(() => false);
}

async function enviarPorDefecto(env: Env, t: { conversationId: string; channel: string; channelUserId: string; text: string }, now: number): Promise<void> {
  const { sendOutbound } = await import("../followup/send");
  await sendOutbound(env, t, now);
}

async function actualizar(db: Db, id: number, campos: Partial<Omit<FilaCola, "id">>, now: number): Promise<void> {
  const ks = Object.keys(campos);
  await db.run(`UPDATE cotizaciones_bot SET ${ks.map((k) => `${k} = ?`).join(", ")}, actualizado = ? WHERE id = ?`, [...ks.map((k) => (campos as Record<string, unknown>)[k] ?? null), now, id]);
}

/** Deja una línea en las notas de la ficha (la fila de lead más reciente que no sea de cita). */
async function anotarEnFicha(db: Db, convId: string, nota: string): Promise<void> {
  const l = await db.first<{ id: string; notes: string | null }>("SELECT id, notes FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY updated_at DESC LIMIT 1", [convId]);
  if (!l) return;
  await db.run("UPDATE leads SET notes = ? WHERE id = ?", [`${l.notes ? `${l.notes}\n` : ""}${nota}`, l.id]);
}

async function candado(db: Db, now: number): Promise<boolean> {
  const s = new SettingsRepo(db);
  const v = Number((await s.get(AJUSTE_CANDADO)) ?? 0);
  if (v && now - v < 14 * MIN) return false;
  await s.set(AJUSTE_CANDADO, String(now));
  return true;
}

export interface ResultadoPasada {
  modo: Modo;
  nuevas: number;
  creadas: number;
  enviadas: number;
  errores: number;
}

export async function runCotizacionesBot(env: Env, now = Date.now(), deps: Dependencias = {}): Promise<ResultadoPasada> {
  const db = new Db(env.DB);
  const res: ResultadoPasada = { modo: "apagado", nuevas: 0, creadas: 0, enviadas: 0, errores: 0 };
  await asegurarTablasCola(db);
  res.modo = await leerModo(db);
  if (res.modo === "apagado") return res;
  if (!(await candado(db, now))) return res;
  const settings = new SettingsRepo(db);
  const avisar = deps.avisar ?? avisoEquipo;
  try {
    await asegurarTablaCotizaciones(db);
    // Quien estaba fuera de la ventana de 24 h y volvió a escribir: vuelve a la cola.
    // Si respondió «Ahora no» a la plantilla, no se le cotiza.
    for (const f of await db.all<FilaCola>("SELECT * FROM cotizaciones_bot WHERE estado = 'pendiente_plantilla'")) {
      const u = await ultimoDelCliente(db, f.conv_id);
      if (!u || now - u >= VENTANA) continue;
      const texto = f.plantilla_en
        ? (await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ? ORDER BY created_at DESC LIMIT 1", [f.conv_id, f.plantilla_en]))?.content ?? ""
        : "";
      if (texto && RE_NO_QUIERE.test(texto)) {
        await actualizar(db, f.id, { estado: "omitida", error: `respondió «${texto.slice(0, 40)}» a la plantilla` }, now);
        await anotarEnFicha(db, f.conv_id, `[Cotización del bot] Respondió «${texto.slice(0, 40)}» a la plantilla: no se le envió cotización.`);
      } else await actualizar(db, f.id, { estado: "propuesta" }, now);
    }

    await enviarPlantillas(env, db, res.modo, now, deps).catch((e) => console.error("[cotizacionesBot] plantillas:", e));

    let cat = await catalogoGuardado(db);
    const nuevos = (await candidatos(db, res.modo, now)).slice(0, 60);
    const pedidas = await db.all<FilaCola>("SELECT * FROM cotizaciones_bot WHERE estado = 'pedida'");
    const okPiloto = new Set(lista(await settings.get(AJUSTE_PILOTO_OK)));
    const listas = async () =>
      (await db.all<FilaCola>("SELECT * FROM cotizaciones_bot WHERE estado = 'propuesta' ORDER BY creado ASC")).filter((f) => res.modo === "activo" || okPiloto.has(f.conv_id));

    const hayQueProponer = nuevos.length > 0 || pedidas.length > 0;
    const catalogoViejo = !cat || now - cat.leidoEn > CATALOGO_VIGENTE;
    const necesitaNavegador = (hayQueProponer && catalogoViejo) || (await listas()).length > 0;

    let nav: { page: Pagina; cerrar: () => Promise<void> } | null = null;
    const N = deps.navegador ?? (await import("./navegador"));
    const abrir = async () => {
      if (nav) return nav;
      nav = await (deps.abrirNavegador ?? abrirNavegadorCloudflare)(env);
      await N.entrar(nav.page, env.VIVEHOME_USER ?? "", env.VIVEHOME_PASSWORD ?? "");
      return nav;
    };

    try {
      if (necesitaNavegador && catalogoViejo) {
        const n = await abrir();
        const leido = await N.leerCatalogo(n.page);
        await guardarCatalogo(db, leido, now);
        cat = { ...leido, leidoEn: now };
      }

      // 1. Propuestas nuevas.
      if (cat && hayQueProponer) {
        const convs = [...nuevos, ...(await convsPorId(db, pedidas.map((p) => p.conv_id)))];
        const leads = await leadsDe(db, convs);
        let n = 0;
        for (const lead of leads) {
          if (n >= MAX_NUEVAS_POR_PASADA) break;
          const pedida = pedidas.find((p) => p.conv_id === lead.convId);
          if (!pedida && (await yaTieneCotizacion(db, lead))) {
            await db.run("INSERT OR IGNORE INTO cotizaciones_bot (conv_id, ronda, estado, error, creado, actualizado) VALUES (?, 1, 'omitida', ?, ?, ?)", [lead.convId, "ya tiene cotización de Maricela", now, now]);
            continue;
          }
          const p = proponer(lead, cat);
          if (!p.estado) {
            if (pedida) await actualizar(db, pedida.id, { estado: "omitida", error: p.motivo }, now);
            continue; // faltan datos: se vuelve a mirar cuando los dé
          }
          const campos = {
            estado: p.estado,
            tipo: p.tipo,
            capacidad: p.capacidad,
            capacidad_texto: lead.ficha.metadata.capacidadMensual ?? null,
            ciudad_texto: lead.ficha.metadata.ciudadCompra ?? null,
            items: JSON.stringify(p.items),
            mensaje: p.estado === "propuesta" ? borradorMensaje(lead, p) : null,
            error: p.estado === "sin_proyectos" ? p.motivo : null,
          };
          if (pedida) await actualizar(db, pedida.id, campos, now);
          else {
            await db.run(
              "INSERT OR IGNORE INTO cotizaciones_bot (conv_id, ronda, estado, tipo, capacidad, capacidad_texto, ciudad_texto, items, mensaje, error, creado, actualizado) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [lead.convId, campos.estado, campos.tipo, campos.capacidad, campos.capacidad_texto, campos.ciudad_texto, campos.items, campos.mensaje, campos.error, now, now],
            );
          }
          n++;
          res.nuevas++;
          if (p.estado === "sin_proyectos") {
            await avisar(env, "🧾 Cotización del bot: no se le pudo cotizar", `${lead.nombre}: ${p.motivo}. No se le mandó cotización.`);
          }
        }
      }

      // 2. Crear y enviar las que están listas.
      const porCrear = (await listas()).slice(0, MAX_CREAR_POR_PASADA);
      if (porCrear.length) {
        const convs = await convsPorId(db, porCrear.map((f) => f.conv_id));
        const leads = await leadsDe(db, convs);
        for (const f of porCrear) {
          const conv = convs.find((c) => c.id === f.conv_id);
          const lead = leads.find((l) => l.convId === f.conv_id);
          if (!conv || !lead) {
            await actualizar(db, f.id, { estado: "omitida", error: "la conversación ya no existe" }, now);
            continue;
          }
          if ((conv.paused_until && conv.paused_until > now) || descartada(conv)) {
            await actualizar(db, f.id, { estado: "omitida", error: "la conversación la tomó una persona o se descartó" }, now);
            continue;
          }
          const faltanBase = evaluarCalificacion(lead.ficha.metadata).faltan.filter((k) => !["reportadoDatacredito", "compraSoloOAcompanado", "puedeQuitarReporte"].includes(k));
          if (faltanBase.length) continue; // el bot todavía está haciendo las preguntas: se cotiza al terminar
          if (lead.prioridad.nivel === "frio" || (evaluarCalificacion(lead.ficha.metadata).reportado && evaluarCalificacion(lead.ficha.metadata).puedeQuitarReporte !== true)) {
            await actualizar(db, f.id, { estado: "omitida", error: "no cumple las condiciones (frío o reportado sin ponerse al día)" }, now);
            continue;
          }
          if (await dijoQueNo(db, f.conv_id)) {
            await actualizar(db, f.id, { estado: "omitida", error: "el cliente dijo que no le interesa" }, now);
            continue;
          }
          if (f.ronda === 1 && (await yaTieneCotizacion(db, lead))) {
            await actualizar(db, f.id, { estado: "omitida", error: "ya tiene cotización de Maricela" }, now);
            continue;
          }
          const u = await ultimoDelCliente(db, f.conv_id);
          if (!u || now - u >= VENTANA) {
            await actualizar(db, f.id, { estado: "pendiente_plantilla", error: "fuera de la ventana de 24 h: espera plantilla o a que el cliente escriba" }, now);
            continue;
          }
          if (!(await puedeEscribirAhora(db, conv, now))) continue; // fuera de 9–21 h del cliente: la próxima pasada

          const items = JSON.parse(f.items ?? "[]") as Elegido[];
          await actualizar(db, f.id, { estado: "creando", intentos: f.intentos + 1 }, now);
          let cotId: string | null = null;
          try {
            const n = await abrir();
            const r = await N.crearCotizacion(n.page, {
              nombre: lead.nombre.trim(),
              correo: correoParaFormulario(lead).correo,
              telefono: lead.telefono ? `+${lead.telefono.replace(/\D/g, "")}` : "",
              items: items.map((i) => ({ proyecto: i.proyecto, valor: i.valor, pct: i.pct ?? 20 })),
            });
            cotId = r.cotId;
            if (!cotId) throw new ErrorPantalla("crear", "no se obtuvo el número de la cotización");
            await actualizar(db, f.id, { estado: "creada", cot_id: cotId, error: null }, now);
            res.creadas++;
            const pub = await N.leerCotizacionPublica(n.page, cotId);
            const mensaje = mensajeFinal(lead, f, items, pub.proyectos, cotId);
            await actualizar(db, f.id, { mensaje }, now);
            await (deps.enviar ?? enviarPorDefecto)(env, { conversationId: conv.id, channel: conv.channel, channelUserId: conv.channel_user_id, text: mensaje }, now);
            await actualizar(db, f.id, { estado: "enviada", enviado_en: now }, now);
            res.enviadas++;
            const tel = lead.telefono.replace(/\D/g, "");
            if (tel) await db.run("INSERT OR IGNORE INTO cotizaciones_enviadas (msg_id, cot_id, tel, enviada_en) VALUES (?,?,?,?)", [`bot-${f.id}`, cotId, tel, now]);
            const fecha = new Date(now).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", timeZone: "Europe/Madrid" });
            await anotarEnFicha(
              db,
              f.conv_id,
              f.tipo === "mas_economicas"
                ? `[Cotización del bot] COT-${cotId} enviada el ${fecha}. NO se cotizó a la medida: su cuota (${pesos(f.capacidad ?? 0)}/mes) no alcanza; se le ${items.length === 1 ? "mandó la opción más económica" : `mandaron las ${items.length} opciones más económicas`}.`
                : `[Cotización del bot] COT-${cotId} enviada el ${fecha} (a la medida de su cuota de ${pesos(f.capacidad ?? 0)}/mes).`,
            );
          } catch (e) {
            res.errores++;
            const pantalla = e instanceof ErrorPantalla;
            const detalle = (e instanceof Error ? e.message : String(e)).slice(0, 300);
            const final = cotId ? "creada" : f.intentos + 1 >= MAX_INTENTOS ? "error" : "propuesta";
            await actualizar(db, f.id, { estado: final, error: detalle }, now);
            await registrarHallazgo(
              env,
              {
                tipo: "cotizacion_fallida",
                convId: f.conv_id,
                clave: `${f.id}-${f.intentos + 1}`,
                detalle: `${lead.nombre}: ${cotId ? `se creó COT-${cotId} pero no se le pudo enviar (${detalle})` : `no se pudo crear la cotización (${detalle})`}${final === "error" ? " · se dejó de intentar" : ""}`,
              },
              now,
            );
            if (pantalla) break; // ViveHome cambió o no responde: no seguir con los demás en esta pasada
          }
        }
      }
    } catch (e) {
      // Fallo general (entrar, catálogo, navegador): un hallazgo y se sigue en la próxima pasada.
      res.errores++;
      await registrarHallazgo(env, { tipo: "cotizacion_fallida", convId: "vivehome", clave: new Date(now).toISOString().slice(0, 13), detalle: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, now);
    } finally {
      if (nav) await (nav as { cerrar: () => Promise<void> }).cerrar().catch(() => undefined);
    }
  } finally {
    await settings.set(AJUSTE_CANDADO, "0");
  }
  return res;
}

async function plantillaAprobadaPorDefecto(env: Env): Promise<boolean> {
  const st = new SettingsRepo(new Db(env.DB));
  const marca = `${PLANTILLA_COTIZACION}_aprobada`;
  if (((await st.get(marca)) ?? "") === "si") return true;
  if (!env.YCLOUD_API_KEY) return false;
  const h = { "X-API-Key": env.YCLOUD_API_KEY };
  const numeros = (await (await fetch("https://api.ycloud.com/v2/whatsapp/phoneNumbers?limit=20", { headers: h })).json()) as { items?: Array<{ phoneNumber?: string; wabaId?: string }> };
  const mio = (numeros.items ?? []).find((n) => String(n.phoneNumber ?? "").replace(/\D/g, "") === (env.YCLOUD_WA_FROM ?? "").replace(/\D/g, "")) ?? numeros.items?.[0];
  if (!mio?.wabaId) return false;
  const t = (await (await fetch(`https://api.ycloud.com/v2/whatsapp/templates?limit=100&filter.wabaId=${encodeURIComponent(mio.wabaId)}`, { headers: h })).json()) as { items?: Array<{ name?: string; status?: string }> };
  const estado = (t.items ?? []).find((x) => x.name === PLANTILLA_COTIZACION)?.status ?? "";
  if (estado === "APPROVED") {
    await st.set(marca, "si");
    await avisoEquipo(env, "✅ Meta aprobó la plantilla de cotización", `La plantilla «${PLANTILLA_COTIZACION}» ya está APROBADA. Se enviará a los pendientes de WhatsApp solo si el ajuste ${AJUSTE_PLANTILLA} está en «activo».`);
    return true;
  }
  if (/REJECTED|PAUSED|DISABLED/.test(estado) && ((await st.get(`${marca}_aviso`)) ?? "") !== estado) {
    await st.set(`${marca}_aviso`, estado);
    await avisoEquipo(env, "⚠️ Meta NO aprobó la plantilla de cotización", `La plantilla «${PLANTILLA_COTIZACION}» quedó en estado ${estado}. No se enviará nada.`);
  }
  return false;
}

async function enviarPlantillaPorDefecto(env: Env, telefono: string, nombre: string): Promise<void> {
  const { sendYCloudTemplate } = await import("../channels/ycloud");
  await sendYCloudTemplate(env, telefono, PLANTILLA_COTIZACION, "es_ES", [nombre]);
}

/**
 * Plantilla de WhatsApp a los pendientes (ventana de 24 h cerrada): «¿Te la enviamos por aquí?». Si toca «Sí, envíamela», su ventana se abre y la
 * cotización sale en la pasada siguiente; si toca «Ahora no», no se le cotiza. Una sola vez por cliente, de 9 a 21 h de su hora, solo WhatsApp
 * (Instagram no tiene plantillas), solo con el interruptor `viventa_cotizaciones_plantilla` = activo y la plantilla aprobada por Meta.
 */
async function enviarPlantillas(env: Env, db: Db, modo: Modo, now: number, deps: Dependencias): Promise<number> {
  const st = new SettingsRepo(db);
  if (((await st.get(AJUSTE_PLANTILLA)) ?? "").trim().toLowerCase() !== "activo") return 0;
  const okPiloto = new Set(lista(await st.get(AJUSTE_PILOTO_OK)));
  const filas = (await db.all<FilaCola>("SELECT * FROM cotizaciones_bot WHERE estado = 'pendiente_plantilla' AND plantilla_en IS NULL AND conv_id LIKE 'ycloud:%' ORDER BY creado ASC")).filter(
    (f) => modo === "activo" || okPiloto.has(f.conv_id),
  );
  if (!filas.length) return 0;
  if (!(await (deps.plantillaAprobada ?? plantillaAprobadaPorDefecto)(env))) return 0;
  const convs = await convsPorId(db, filas.map((f) => f.conv_id));
  const leads = await leadsDe(db, convs);
  const conCita = new Set((await db.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM leads WHERE intent LIKE 'Cita ·%'")).map((r) => r.conversation_id));
  let n = 0;
  for (const f of filas) {
    if (n >= MAX_PLANTILLAS_POR_PASADA) break;
    const conv = convs.find((c) => c.id === f.conv_id);
    const lead = leads.find((l) => l.convId === f.conv_id);
    if (!conv || !lead || (conv.paused_until && conv.paused_until > now) || descartada(conv) || conCita.has(conv.id) || (await dijoQueNo(db, conv.id)) || (f.ronda === 1 && (await yaTieneCotizacion(db, lead)))) {
      await actualizar(db, f.id, { estado: "omitida", error: "antes de la plantilla: la tomó una persona, se descartó, agendó o ya tiene cotización" }, now);
      continue;
    }
    if (!(await puedeEscribirAhora(db, conv, now))) continue;
    const nombre = primerNombre(lead.nombre) || "👋";
    // Se marca antes de enviar: si el envío falla no se reintenta solo (cuesta dinero); queda el hallazgo.
    await actualizar(db, f.id, { plantilla_en: now }, now);
    try {
      await (deps.enviarPlantilla ?? enviarPlantillaPorDefecto)(env, conv.channel_user_id, nombre);
      const { MessagesRepo } = await import("../db/messages");
      await new MessagesRepo(db).append(conv.id, "assistant", TEXTO_PLANTILLA(nombre));
      n++;
    } catch (e) {
      await registrarHallazgo(env, { tipo: "cotizacion_fallida", convId: f.conv_id, clave: `plantilla-${f.id}`, detalle: `${lead.nombre}: no se pudo enviar la plantilla de cotización (${(e instanceof Error ? e.message : String(e)).slice(0, 160)})` }, now);
    }
  }
  return n;
}

/** Mensaje definitivo con las cifras exactas que ve el cliente en la cotización publicada. */
export function mensajeFinal(lead: LeadResumen, f: Pick<FilaCola, "tipo">, items: Elegido[], publicos: ProyectoPublico[], cotId: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
  const conCifras = items.map((i) => {
    const p = publicos.find((x) => norm(x.proyecto) === norm(i.proyecto));
    return { proyecto: i.proyecto, ciudad: i.ciudad, mensualidad: p?.mensualidad ?? i.mensual, meses: p?.meses ?? i.meses, pct: p?.pct ?? i.pct ?? 20 };
  });
  const ej = [...conCifras].sort((a, b) => a.mensualidad - b.mensualidad)[0];
  return textoMensaje({
    nombre: primerNombre(lead.nombre),
    tipo: f.tipo ?? "a_la_medida",
    enlace: `${URL_PUBLICA}${cotId}`,
    ciudades: items.map((i) => i.ciudad),
    ciudadCliente: ciudadDelCliente(lead, items),
    pcts: conCifras.map((c) => c.pct),
    n: items.length,
    ejemplo: ej,
  });
}

/** El cliente pidió otra cotización (botón de la ficha): nueva ronda que se arma en la próxima pasada. */
export async function pedirOtraCotizacion(env: Env, convId: string, now = Date.now()): Promise<boolean> {
  const db = new Db(env.DB);
  await asegurarTablasCola(db);
  const abierta = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM cotizaciones_bot WHERE conv_id = ? AND estado IN ('propuesta', 'creando', 'pedida')", [convId]);
  if ((abierta?.n ?? 0) > 0) return false;
  const r = await db.first<{ m: number | null }>("SELECT MAX(ronda) AS m FROM cotizaciones_bot WHERE conv_id = ?", [convId]);
  await db.run("INSERT INTO cotizaciones_bot (conv_id, ronda, estado, creado, actualizado) VALUES (?, ?, 'pedida', ?, ?)", [convId, (r?.m ?? 0) + 1, now, now]);
  return true;
}

export async function filasDe(env: Env, convId?: string): Promise<FilaCola[]> {
  const db = new Db(env.DB);
  await asegurarTablasCola(db);
  return convId
    ? db.all<FilaCola>("SELECT * FROM cotizaciones_bot WHERE conv_id = ? ORDER BY ronda DESC", [convId])
    : db.all<FilaCola>("SELECT * FROM cotizaciones_bot ORDER BY actualizado DESC LIMIT 500");
}
