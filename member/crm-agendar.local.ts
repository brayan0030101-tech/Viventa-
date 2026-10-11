// member/crm-agendar.local.ts — CRM de Viventa: «Agendar llamada manual».
// Para las videollamadas que Maricela ya acordó por su cuenta y el bot no tiene: se registran en Cal.com
// (bloquea el horario y crea el evento con Meet en su Google Calendar) y en el CRM (calendario, pipeline,
// «Por agendar»). Antes de crear nada se muestra un resumen (hora en España y Colombia, disponibilidad real
// en Cal.com, cliente encontrado) y se confirma con un botón.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { LeadsRepo } from "../src/db/leads";
import { calcomConfigured, calcomTimeZone, resolveEventTypeId, getAvailableSlots } from "../src/integrations/calcom";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";
import { clavePhone } from "./crm-poragendar.local";
import { ESTILO_CAMPO, ESTILO_BOTON } from "./crm-shell.local";

export type ModoAgenda = "relleno" | "cliente" | "solo_crm";
export type ZonaEntrada = "madrid" | "colombia";
const TZ: Record<ZonaEntrada, string> = { madrid: "Europe/Madrid", colombia: "America/Bogota" };
const SERVICIO = "Videollamada Viventa";

export interface EntradaAgenda {
  nombre: string;
  correo: string;
  tel: string;
  fecha: string; // YYYY-MM-DD
  hora: string; // HH:MM
  zona: ZonaEntrada;
  modo: ModoAgenda;
  /** No eligió modo: se propone según la disponibilidad (libre → Cal.com; ocupada → solo CRM). */
  modoAuto: boolean;
  /** Enlace de Meet que el cliente ya tiene (opcional; solo para «solo CRM»). */
  meet: string;
}

export function leerEntrada(q: Record<string, string | undefined>): EntradaAgenda {
  const zona: ZonaEntrada = q["zona"] === "colombia" ? "colombia" : "madrid";
  const modo: ModoAgenda = q["modo"] === "cliente" ? "cliente" : q["modo"] === "solo_crm" ? "solo_crm" : "relleno";
  return {
    nombre: (q["nombre"] ?? "").trim().slice(0, 120),
    correo: (q["correo"] ?? "").trim().toLowerCase().slice(0, 160),
    tel: (q["tel"] ?? "").trim().slice(0, 40),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(q["fecha"] ?? "") ? q["fecha"]! : "",
    hora: /^\d{1,2}:\d{2}$/.test(q["hora"] ?? "") ? q["hora"]!.padStart(5, "0") : "",
    zona,
    modo,
    modoAuto: !q["modo"],
    meet: /^https:\/\/meet\.google\.com\/[\w-]+/.test((q["meet"] ?? "").trim()) ? (q["meet"] ?? "").trim().slice(0, 200) : "",
  };
}

/** Instante UTC (ms) de una fecha y hora «de pared» en una zona horaria. */
export function utcDesdeLocal(fecha: string, hora: string, tz: string): number {
  const [y, m, d] = fecha.split("-").map(Number);
  const [hh, mm] = hora.split(":").map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (t: number): number => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]), Number(p["minute"]), Number(p["second"])) - t;
  };
  let t = base - offset(base);
  t = base - offset(t);
  return t;
}

const cuando = (ms: number, tz: string): string =>
  new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

const digitos = (s: string): string => s.replace(/\D/g, "");

/** Teléfono con prefijo para crear una conversación nueva si hace falta (sin prefijo se asume España). */
function telCompleto(tel: string): string {
  const d = digitos(tel);
  return d.length === 9 ? `34${d}` : d.replace(/^00/, "");
}

export interface ClienteEncontrado {
  convId: string;
  nombre: string;
  canales: string[];
  yaTieneLlamada: string;
}

/** Busca al cliente en el CRM por teléfono o correo. Prefiere la conversación que tiene su ficha. */
export async function buscarCliente(env: Env, tel: string, correo: string, now = Date.now()): Promise<ClienteEncontrado | null> {
  const db = new Db(env.DB);
  const k = clavePhone(tel);
  const ids = new Set<string>();
  if (k) {
    for (const r of await db.all<{ id: string }>("SELECT id FROM conversations WHERE channel = 'ycloud' AND channel_user_id LIKE ? LIMIT 5", [`%${k}`])) ids.add(r.id);
    for (const r of await db.all<{ conversation_id: string | null }>("SELECT DISTINCT conversation_id FROM leads WHERE contact LIKE ? AND conversation_id IS NOT NULL LIMIT 8", [`%${k}%`])) if (r.conversation_id) ids.add(r.conversation_id);
  }
  if (correo.includes("@")) {
    for (const r of await db.all<{ conversation_id: string | null }>("SELECT DISTINCT conversation_id FROM leads WHERE lower(contact) LIKE ? AND conversation_id IS NOT NULL LIMIT 8", [`%${correo}%`])) if (r.conversation_id) ids.add(r.conversation_id);
  }
  if (ids.size === 0) return null;
  const lista = [...ids];
  const conFicha = await db.all<{ conversation_id: string; n: number }>(
    `SELECT conversation_id, COUNT(*) AS n FROM leads WHERE intent NOT LIKE 'Cita ·%' AND conversation_id IN (${lista.map(() => "?").join(",")}) GROUP BY conversation_id`,
    lista,
  );
  const mejor = conFicha.sort((a, b) => b.n - a.n)[0]?.conversation_id ?? lista[0];
  const conv = await db.first<{ display_name: string | null }>("SELECT display_name FROM conversations WHERE id = ?", [mejor]);
  const lead = await db.first<{ name: string | null }>("SELECT name FROM leads WHERE conversation_id = ? AND name IS NOT NULL AND intent NOT LIKE 'Cita ·%' ORDER BY created_at DESC LIMIT 1", [mejor]);
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const llamadas = (await cargarLlamadas(env, now)).filter((l) => lista.includes(l.convId) && l.estado === "agendada");
  return {
    convId: mejor,
    nombre: lead?.name ?? conv?.display_name ?? "",
    canales: [...new Set(lista.map((c) => (c.startsWith("ycloud") ? "WhatsApp" : c.startsWith("zernio") ? "Instagram" : "Otro")))],
    yaTieneLlamada: llamadas[0] ? cuando(llamadas[0].inicio, "Europe/Madrid") : "",
  };
}

export interface Vista {
  entrada: EntradaAgenda;
  completo: boolean;
  ms: number;
  madrid: string;
  colombia: string;
  disponible: boolean | null; // null = no se pudo comprobar
  slotIso: string;
  cliente: ClienteEncontrado | null;
  aviso: string;
  /** Modo propuesto (el elegido, o según disponibilidad si no eligió). */
  modo: ModoAgenda;
  /** Horarios libres de ese día en Cal.com (HH:MM, hora de España). */
  libres: string[];
  /** Llamadas que ya hay ese día en el CRM (hora de España). */
  delDia: Array<{ hm: string; nombre: string }>;
  /** Otra llamada del CRM que choca con esta hora. */
  choque: string;
}

export async function previsualizar(env: Env, entrada: EntradaAgenda, now = Date.now()): Promise<Vista> {
  const completo = !!(entrada.nombre && entrada.fecha && entrada.hora && (entrada.tel || entrada.correo));
  const base: Vista = { entrada, completo, ms: 0, madrid: "", colombia: "", disponible: null, slotIso: "", cliente: null, aviso: "", modo: entrada.modo, libres: [], delDia: [], choque: "" };
  const hmMadrid = (ms: number): string => new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  const diaMadridDe = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  // Solo la fecha: se muestran los horarios libres de ese día para elegir uno (y no pisar otra llamada).
  if (entrada.fecha && !entrada.hora && calcomConfigured(env)) {
    const etId = resolveEventTypeId(env, SERVICIO);
    if (etId) {
      const r = await getAvailableSlots(env, etId, entrada.fecha, calcomTimeZone(env));
      if (r.ok) base.libres = r.slots.map((x) => hmMadrid(Date.parse(x)));
    }
  }
  if (entrada.fecha) {
    const { cargarLlamadas } = await import("./crm-calendario.local");
    base.delDia = (await cargarLlamadas(env, now))
      .filter((l) => l.estado === "agendada" && diaMadridDe(l.inicio) === entrada.fecha)
      .sort((a, b) => a.inicio - b.inicio)
      .map((l) => ({ hm: hmMadrid(l.inicio), nombre: l.nombre }));
  }
  if (!entrada.fecha || !entrada.hora) return base;
  const ms = utcDesdeLocal(entrada.fecha, entrada.hora, TZ[entrada.zona]);
  base.ms = ms;
  base.madrid = cuando(ms, "Europe/Madrid");
  base.colombia = cuando(ms, "America/Bogota");
  if (ms < now) base.aviso = "Esa fecha y hora ya pasaron.";
  base.cliente = await buscarCliente(env, entrada.tel, entrada.correo, now);
  {
    // ¿Choca con otra llamada del CRM (30 min de duración)? Siempre se bloquea: así no se cruzan los horarios.
    const { cargarLlamadas } = await import("./crm-calendario.local");
    const otra = (await cargarLlamadas(env, now)).find((l) => l.estado === "agendada" && l.convId !== base.cliente?.convId && Math.abs(l.inicio - ms) < 30 * 60_000);
    if (otra) base.choque = `${otra.nombre} a las ${hmMadrid(otra.inicio)}`;
  }
  if (calcomConfigured(env)) {
    const etId = resolveEventTypeId(env, SERVICIO);
    if (etId) {
      // Cal.com da los slots del día en SU zona; se pide el día de Madrid (la agenda de Maricela).
      const diaMadrid = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
      const r = await getAvailableSlots(env, etId, diaMadrid, calcomTimeZone(env));
      if (r.ok) {
        const s = r.slots.find((x) => Date.parse(x) === ms);
        base.disponible = !!s;
        base.slotIso = s ?? "";
      }
    }
  }
  if (entrada.modoAuto) base.modo = base.disponible === false ? "solo_crm" : "relleno";
  return base;
}

export type Resultado = { ok: true; mensaje: string; convId: string; enlace?: string } | { ok: false; error: string };

export async function crearCitaManual(env: Env, entrada: EntradaAgenda, now = Date.now()): Promise<Resultado> {
  const v = await previsualizar(env, entrada, now);
  if (!v.completo) return { ok: false, error: "Faltan datos: nombre, fecha, hora y teléfono o correo." };
  if (v.aviso) return { ok: false, error: v.aviso };
  if (v.choque) return { ok: false, error: `Ese horario choca con otra llamada del CRM: ${v.choque}. Elige otro horario.` };
  if (v.cliente?.yaTieneLlamada) return { ok: false, error: `Este cliente ya tiene una videollamada agendada (${v.cliente.yaTieneLlamada}). Cancélala primero si es un cambio.` };
  const db = new Db(env.DB);

  // Conversación: la del cliente si ya existe; si no, se crea la de WhatsApp con su teléfono.
  let convId = v.cliente?.convId ?? "";
  if (!convId) {
    const t = telCompleto(entrada.tel);
    if (t.length < 8) return { ok: false, error: "No encontré al cliente en el CRM y para crearlo necesito su teléfono." };
    convId = (await new ConversationsRepo(db).getOrCreate("ycloud", t, entrada.nombre)).id;
  }
  const nombre = entrada.nombre;
  const suprimir = { viventa_avisada: "1", ...(entrada.modo !== "cliente" ? { viventa_confirmada: "1", viventa_r24: "1", viventa_r1: "1" } : {}) };

  let leadId = "";
  let enlace: string | undefined;
  let estado = "";
  if (entrada.modo === "solo_crm") {
    // Mismo estado que una reserva de Cal.com para que el bot, «Por agendar» y los informes la cuenten como agendada; `soloCrm` la distingue.
    estado = "Reservada (Cal.com)";
    leadId = await new LeadsRepo(db, env).create({
      conversationId: convId, channelUserId: null, name: nombre, contact: entrada.tel || entrada.correo,
      intent: `Cita · ${SERVICIO} · ${entrada.fecha} ${entrada.hora}`.slice(0, 300),
      notes: "Agendada manualmente por el equipo (solo CRM, no está en Cal.com)",
      metadata: { servicio: SERVICIO, fecha: entrada.fecha, hora: entrada.hora, calStart: new Date(v.ms).toISOString(), estado, soloCrm: "1", ...(entrada.meet ? { calMeetingUrl: entrada.meet } : {}), ...suprimir },
    });
  } else {
    if (!v.slotIso) return { ok: false, error: v.disponible === false ? "Ese horario no está disponible en Cal.com (Maricela no lo tiene abierto o ya está ocupado). Puedes guardarla solo en el CRM." : "No pude comprobar la disponibilidad en Cal.com. Inténtalo de nuevo." };
    const correoCal = entrada.modo === "cliente" && entrada.correo.includes("@") ? entrada.correo : `sin-correo-${digitos(entrada.tel) || Date.now()}@correo-no-proporcionado.invalid`;
    const { agendarCitaTool } = await import("../src/tools/servicios");
    const t = agendarCitaTool(env, () => convId) as unknown as { execute: (a: Record<string, unknown>, o: unknown) => Promise<{ citaId?: string; booked?: boolean; enlace?: string; message?: string }> };
    const r = await t.execute(
      { nombre, servicio: SERVICIO, fecha: entrada.fecha, hora: entrada.hora, startTime: v.slotIso, email: correoCal, contacto: entrada.tel || undefined, notas: "Agendada manualmente por el equipo (ya acordada con el cliente)" },
      {},
    );
    if (!r?.booked || !r.citaId) return { ok: false, error: `Cal.com no pudo reservar ese horario. ${r?.message ?? ""}`.trim() };
    leadId = r.citaId;
    enlace = r.enlace;
    for (const [k, val] of Object.entries(suprimir)) await db.run("UPDATE leads SET metadata = json_set(COALESCE(metadata, '{}'), ?, ?) WHERE id = ?", [`$.${k}`, val, leadId]);
    estado = "Reservada (Cal.com)";
  }
  return {
    ok: true,
    convId,
    enlace,
    mensaje:
      entrada.modo === "solo_crm"
        ? `Guardada en el CRM para ${v.madrid} (hora de España). No está en Cal.com ni en Google Calendar: no bloquea el horario.`
        : `Reservada en Cal.com y en el calendario de Maricela para ${v.madrid} (hora de España).${entrada.modo === "cliente" ? " Cal.com le envía la invitación al correo del cliente." : " No se le envió ninguna invitación al cliente."}`,
  };
}

// ─── Vistas ──────────────────────────────────────────────────────────────────

const campo = (nombre: string, titulo: string, valor: string, extra = ""): string =>
  `<label style="display:block;font-size:12px;color:var(--muted);margin-bottom:10px">${titulo}<input name="${nombre}" value="${esc(valor)}" ${extra} style="${ESTILO_CAMPO}"></label>`;

export async function renderAgendar(env: Env, entrada: EntradaAgenda, opts: { resultado?: Resultado } = {}, now = Date.now()): Promise<string> {
  const v = await previsualizar(env, entrada, now);
  const r = opts.resultado;
  const urlHora = (hm: string): string => `/crm/agendar?${new URLSearchParams({ nombre: entrada.nombre, tel: entrada.tel, correo: entrada.correo, fecha: entrada.fecha, hora: hm, zona: entrada.zona, ...(entrada.meet ? { meet: entrada.meet } : {}) }).toString()}`;
  const delDia = v.delDia.length
    ? `<div style="font-size:12px;margin:8px 0;color:var(--muted)">📅 Ya hay ${v.delDia.length} llamada(s) ese día en el CRM: ${v.delDia.map((x) => `<b style="color:var(--cream)">${esc(x.hm)}</b> ${esc(x.nombre)}`).join(" · ")}</div>`
    : entrada.fecha ? `<div class="text-dim" style="font-size:12px;margin:8px 0">📅 No hay otras llamadas ese día en el CRM.</div>` : "";
  const libres = v.libres.length
    ? `<div style="margin:8px 0"><div class="text-dim" style="font-size:11.5px;margin-bottom:6px">Horarios libres en Cal.com ese día (hora de España). Toca uno para elegirlo:</div><div style="display:flex;flex-wrap:wrap;gap:6px">${v.libres.map((hm) => `<a href="${esc(urlHora(hm))}" class="ghostbtn" style="border:1px solid var(--line);padding:5px 10px;font-size:12px;color:var(--cream)">${esc(hm)}</a>`).join("")}</div></div>`
    : "";
  const resumen = !entrada.fecha || !entrada.hora
    ? `<div class="text-dim" style="font-size:12.5px">${entrada.fecha ? "Elige la hora para ver el resumen." : "Rellena los datos y revisa el resumen antes de confirmar."}</div>${delDia}${libres}`
    : `<div style="font-size:13px;line-height:1.8">${delDia}${v.choque ? `<div style="color:var(--bad);font-weight:600">⛔ Choca con otra llamada del CRM: ${esc(v.choque)}. Elige otro horario.</div>` : ""}
        <div>📅 <b style="color:var(--cream)">${esc(v.madrid)}</b> · hora de España</div>
        <div class="text-dim">🇨🇴 ${esc(v.colombia)} · hora de Colombia</div>
        <div>${v.disponible === true ? `<span style="color:var(--ok)">✔ Disponible en Cal.com</span>` : v.disponible === false ? `<span style="color:var(--bad)">✖ No disponible en Cal.com (cerrado o ocupado)</span>` : `<span class="text-dim">No pude comprobar la disponibilidad</span>`}</div>
        <div>${v.cliente ? `👤 Cliente encontrado en el CRM: <a href="/crm/c/${encodeURIComponent(v.cliente.convId)}" style="color:var(--accent)">${esc(v.cliente.nombre || "ver ficha")}</a> (${esc(v.cliente.canales.join(" + "))})` : `<span class="text-dim">👤 No lo encontré en el CRM: se crea su conversación de WhatsApp con el teléfono</span>`}</div>
        ${v.cliente?.yaTieneLlamada ? `<div style="color:var(--bad)">⚠ Ya tiene una videollamada agendada: ${esc(v.cliente.yaTieneLlamada)}</div>` : ""}
        ${v.aviso ? `<div style="color:var(--bad)">⚠ ${esc(v.aviso)}</div>` : ""}
      </div>`;
  const radio = (valor: ModoAgenda, titulo: string, ayuda: string, recomendada = false): string =>
    `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);margin-bottom:8px;cursor:pointer"><input type="radio" name="modo" value="${valor}" ${v.modo === valor ? "checked" : ""} style="margin-top:3px;accent-color:var(--accent)"><span style="font-size:12.5px;color:var(--cream)"><b>${titulo}</b>${recomendada ? ` <span style="color:var(--ok);font-size:11px">recomendada</span>` : ""}<br><span class="text-dim">${ayuda}</span></span></label>`;
  const body = `${ESTILO_CRM}
    <div style="max-width:760px">
      <a href="/crm/calendario" style="font-size:12px">← Volver al calendario</a>
      <h2 style="font-weight:700;font-size:20px;margin:10px 0 6px">Agendar llamada manual</h2>
      <p class="text-dim" style="font-size:12.5px;margin:0 0 16px">Para llamadas que Maricela acordó por su cuenta. <b>Si el horario está libre</b>, se crea en Cal.com y queda en su Google Calendar y en el CRM. <b>Si ya la tiene en su Google Calendar</b>, Cal.com lo ve ocupado y se guarda solo en el CRM.</p>
      ${r ? (r.ok
        ? `<div class="crm-card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--ok)"><b style="color:var(--ok)">✔ Listo</b><div style="font-size:13px;margin-top:6px">${esc(r.mensaje)}</div>${r.enlace ? `<div style="font-size:12.5px;margin-top:6px">Enlace de Meet: <a href="${esc(r.enlace)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(r.enlace)}</a></div>` : ""}<div style="margin-top:10px;display:flex;gap:10px"><a class="ghostbtn" href="/crm/c/${encodeURIComponent(r.convId)}" style="border:1px solid var(--line);padding:7px 14px;font-size:12px">Ver ficha</a><a class="ghostbtn" href="/crm/calendario" style="border:1px solid var(--line);padding:7px 14px;font-size:12px">Ver calendario</a><a class="ghostbtn" href="/crm/agendar" style="border:1px solid var(--line);padding:7px 14px;font-size:12px">Agendar otra</a></div></div>`
        : `<div class="crm-card" style="padding:14px;margin-bottom:16px;border-left:4px solid var(--bad);color:var(--bad);font-size:13px">✖ ${esc(r.error)}</div>`) : ""}
      ${r?.ok ? "" : `<form method="POST" action="/crm/agendar" class="crm-card" style="padding:18px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">
          ${campo("nombre", "Nombre completo", entrada.nombre, "required")}
          ${campo("tel", "Teléfono (con prefijo)", entrada.tel)}
          ${campo("correo", "Correo del cliente", entrada.correo, 'type="email"')}
          <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:10px">Hora indicada en<select name="zona" style="${ESTILO_CAMPO}"><option value="madrid"${entrada.zona === "madrid" ? " selected" : ""}>España (la del calendario de Maricela)</option><option value="colombia"${entrada.zona === "colombia" ? " selected" : ""}>Colombia</option></select></label>
          ${campo("fecha", "Día", entrada.fecha, 'type="date" required')}
          ${campo("hora", "Hora de inicio", entrada.hora, 'type="time" required')}
        </div>
        ${campo("meet", "Enlace de Meet que el cliente ya tiene (opcional)", entrada.meet, 'type="url" placeholder="https://meet.google.com/…"')}
        <div class="crm-sec" style="margin-top:6px">Resumen</div>
        <div style="margin-bottom:14px">${resumen}</div>
        <div class="crm-sec">¿Cómo registrarla?</div>
        ${radio("relleno", "En Cal.com SIN avisar al cliente", "Bloquea el horario y la deja en el calendario y el CRM. El cliente no recibe una segunda invitación: conserva el enlace de Meet que ya tiene.", true)}
        ${radio("cliente", "En Cal.com y avisar al cliente", "Cal.com le envía la invitación con su propio enlace de Meet al correo del cliente (puede confundirse si ya tenía otra).")}
        ${radio("solo_crm", "Solo en el CRM", "No toca Cal.com ni Google Calendar. Úsala si la llamada ya está en el Google Calendar de Maricela (Cal.com ya ve ese horario ocupado, así que el bot no se lo ofrece a nadie).")}
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
          <button type="submit" name="accion" value="ver" class="ghostbtn" style="border:1px solid var(--line);padding:9px 16px;font-size:12.5px;color:var(--muted);background:none;cursor:pointer;font-family:inherit">Actualizar resumen</button>
          <button type="submit" name="accion" value="confirmar" style="${ESTILO_BOTON}" ${v.completo && !v.choque ? "" : "disabled"}>Confirmar y agendar</button>
        </div>
      </form>`}
    </div>`;
  return crmLayout({ title: "Agendar llamada", activa: "calendario", body, env });
}
