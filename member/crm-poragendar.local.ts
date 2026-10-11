// member/crm-poragendar.local.ts — CRM de Viventa: «Por agendar».
// TODAS las personas que todavía no tienen videollamada agendada, con el motivo:
//   🗓 propuso horario (hay que agendarla) · 💬 en conversación · 😶 sin respuesta reciente
//   ⏳ sin contactar (tiene teléfono, no hay conversación de WhatsApp) · 📵 solo Instagram, sin teléfono.
// Une a la misma persona entre Instagram y WhatsApp por el teléfono (últimos 9 dígitos): así quien ya
// recibió un WhatsApp de Maricela NO aparece como «sin contactar», y lo que respondió allí se ve aquí.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { buildXlsx } from "../src/lib/xlsx";
import { esc, ESTILO_CRM, badgeNivel, cargarCrm, hace, fechaHora, type FilaCrm } from "./crm.local";

const H = 3600_000;
const DIA = 24 * H;
const VENTANA_MSGS_DIAS = 14;
const SIN_RESPUESTA_DIAS = 3;

export type MotivoPendiente = "propuso" | "sin_contactar" | "conversando" | "sin_respuesta" | "sin_telefono";

export const MOTIVOS: Record<MotivoPendiente, { icono: string; txt: string; orden: number; accion: string }> = {
  propuso: { icono: "🗓", txt: "Propuso horario", orden: 0, accion: "Agéndale la videollamada con el horario que propuso" },
  sin_contactar: { icono: "⏳", txt: "Sin contactar", orden: 1, accion: "Escríbele por WhatsApp (tiene teléfono)" },
  conversando: { icono: "💬", txt: "En conversación", orden: 2, accion: "Está hablando; ofrécele la videollamada" },
  sin_respuesta: { icono: "😶", txt: "Sin respuesta reciente", orden: 3, accion: "Hazle seguimiento" },
  sin_telefono: { icono: "📵", txt: "Solo Instagram, sin teléfono", orden: 4, accion: "Pídele su teléfono por Instagram" },
};

/** ¿Dice el cliente un día u hora? (heurística; Maricela confirma leyendo el mensaje que se muestra). */
const PROPONE_HORARIO =
  /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|pasado ma[ñn]ana|esta (tarde|noche)|la otra semana|la pr[oó]xima semana|semana (que viene|pr[oó]xima))\b|\b\d{1,2}\s*(:\d{2}|h\b|hs\b|am\b|pm\b|a\.?\s?m\.?|p\.?\s?m\.?|de la (ma[ñn]ana|tarde|noche))|\ba las \d|\bdespu[eé]s de las?\b|\ba partir (de|del)\b|\b\d{1,2}\/\d{1,2}\b/i;

export const proponeHorario = (t: string): boolean => PROPONE_HORARIO.test(t);

const digitos = (s: string): string => s.replace(/\D/g, "");
/** Clave para reconocer el mismo teléfono con o sin prefijo, con ceros, espacios o signos. */
export const clavePhone = (s: string): string => {
  const d = digitos(s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s);
  return d.length >= 8 ? d.slice(-9) : "";
};

export type MotivoDescarte = "no_interesado" | "no_quiso" | "sin_contacto" | "mas_adelante";

export const DESCARTES: Record<MotivoDescarte, { icono: string; txt: string; perdido: boolean }> = {
  mas_adelante: { icono: "🕐", txt: "Recontactar más adelante", perdido: false },
  no_interesado: { icono: "🙅", txt: "No está interesado", perdido: true },
  no_quiso: { icono: "✋", txt: "No quiso agendar", perdido: true },
  sin_contacto: { icono: "📵", txt: "Número perdido / no responde", perdido: true },
};

export interface Descarte {
  motivo: MotivoDescarte;
  en: number;
  /** Solo «más adelante»: cuándo vuelve a la lista. */
  hasta: number | null;
}

export interface Pendiente {
  fila: FilaCrm;
  /** Todas las conversaciones de la persona (Instagram + WhatsApp). */
  convIds: string[];
  descarte?: Descarte;
  /** Estaba aplazada y ya pasó la fecha: vuelve a la lista. */
  vuelve?: boolean;
  motivo: MotivoPendiente;
  /** Último mensaje del cliente que sugiere el horario (o el último que escribió). */
  mensaje: string;
  mensajeEn: number;
  canales: string[];
  wa: string;
  ultimaActividad: number;
}

export async function cargarPorAgendar(env: Env, opts: { frios?: boolean; descartados?: boolean } = {}, now = Date.now()): Promise<Pendiente[]> {
  const db = new Db(env.DB);
  const filas = await cargarCrm(env, now);

  // 1) Quién ya tiene (o tuvo) videollamada: se excluye. Las canceladas SÍ cuentan como por agendar.
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const conLlamada = new Set<string>();
  for (const l of await cargarLlamadas(env, now)) if (l.estado !== "cancelada") conLlamada.add(l.convId);

  // 2) Etapa fijada a mano como cerrado/perdido: se excluye.
  const cerrados = new Set(
    (await db.all<{ id: string }>("SELECT id FROM conversations WHERE json_extract(metadata, '$.crm_etapa') IN ('cerrado', 'perdido') AND json_extract(metadata, '$.crm_descarte') IS NULL")).map((r) => r.id),
  );

  // 2b) Descartes hechos por el equipo (no interesado, no quiso, número perdido, más adelante).
  const descartes = new Map<string, Descarte>();
  for (const r of await db.all<{ id: string; d: string | null }>("SELECT id, json_extract(metadata, '$.crm_descarte') AS d FROM conversations WHERE json_extract(metadata, '$.crm_descarte') IS NOT NULL")) {
    try {
      const j = JSON.parse(r.d ?? "{}") as { motivo?: string; en?: number; hasta?: number | null };
      if (j.motivo && j.motivo in DESCARTES) descartes.set(r.id, { motivo: j.motivo as MotivoDescarte, en: Number(j.en) || 0, hasta: j.hasta ? Number(j.hasta) : null });
    } catch { /* ignorar */ }
  }

  // 3) Conversaciones de WhatsApp por teléfono.
  const was = await db.all<{ id: string; channel_user_id: string; last_message_at: number }>(
    "SELECT id, channel_user_id, last_message_at FROM conversations WHERE channel = 'ycloud' AND last_message_at > ? LIMIT 2000",
    [now - 120 * DIA],
  );
  const waPorTel = new Map<string, { id: string; ultimo: number }>();
  for (const w of was) {
    const k = clavePhone(w.channel_user_id);
    if (k) waPorTel.set(k, { id: w.id, ultimo: w.last_message_at });
  }

  // 4) Mensajes del cliente de los últimos días, por conversación.
  const msgs = await db.all<{ conversation_id: string; content: string; created_at: number }>(
    "SELECT conversation_id, content, created_at FROM messages WHERE role = 'user' AND created_at > ? ORDER BY created_at DESC LIMIT 6000",
    [now - VENTANA_MSGS_DIAS * DIA],
  );
  const porConv = new Map<string, Array<{ t: string; at: number }>>();
  for (const m of msgs) {
    const a = porConv.get(m.conversation_id) ?? [];
    a.push({ t: m.content, at: m.created_at });
    porConv.set(m.conversation_id, a);
  }

  // 5) Una fila por persona (mismo teléfono = misma persona, aunque tenga conversación de IG y de WhatsApp).
  const personas = new Map<string, { fila: FilaCrm; convs: Set<string> }>();
  for (const f of filas) {
    const k = clavePhone(f.lead.telefono || "") || f.lead.convId;
    const ya = personas.get(k);
    if (!ya) {
      personas.set(k, { fila: f, convs: new Set([f.lead.convId]) });
    } else {
      ya.convs.add(f.lead.convId);
      // Se queda la ficha más completa (más puntos); el resto solo suma conversaciones.
      if (f.lead.prioridad.puntos > ya.fila.lead.prioridad.puntos) ya.fila = f;
    }
  }

  const out: Pendiente[] = [];
  for (const [k, p] of personas) {
    const f = p.fila;
    const wa = k.length === 9 ? waPorTel.get(k) : undefined;
    const convs = new Set(p.convs);
    if (wa) convs.add(wa.id);
    if ([...convs].some((c) => conLlamada.has(c) || cerrados.has(c))) continue;
    if (f.lead.llamada) continue;
    const d = [...convs].map((c) => descartes.get(c)).find(Boolean);
    const descartado = !!d && (d.hasta == null || d.hasta > now);
    if (opts.descartados ? !descartado : descartado) continue;
    if (!opts.descartados && !opts.frios && f.lead.prioridad.nivel === "frio") continue;

    const suyos = [...convs].flatMap((c) => porConv.get(c) ?? []).sort((a, b) => b.at - a.at);
    const propuesta = suyos.find((m) => proponeHorario(m.t));
    const reciente = suyos[0];
    const tieneTel = !!clavePhone(f.lead.telefono || "") || !!wa;
    const canales = [...new Set([...convs].map((c) => (c.startsWith("ycloud") ? "WhatsApp" : c.startsWith("zernio") ? "Instagram" : "Otro")))];
    const ultimaActividad = Math.max(f.ultimo, wa?.ultimo ?? 0);

    let motivo: MotivoPendiente;
    // Instagram solo deja responder 24 h: si es solo Instagram, hay teléfono y su último mensaje ya pasó esa ventana,
    // la vía es WhatsApp (se considera «sin contactar»).
    const soloIgVencido = !wa && f.lead.canal === "Instagram" && tieneTel && (!reciente || now - reciente.at > 22 * H);
    if (propuesta) motivo = "propuso";
    else if (soloIgVencido) motivo = "sin_contactar";
    else if (reciente && now - reciente.at < SIN_RESPUESTA_DIAS * DIA) motivo = "conversando";
    else if (wa || f.lead.canal === "WhatsApp") motivo = "sin_respuesta";
    else if (tieneTel) motivo = "sin_contactar";
    else motivo = "sin_telefono";

    const mostrar = propuesta ?? reciente;
    out.push({ fila: f, convIds: [...convs], descarte: d, vuelve: !!d && !descartado, motivo, mensaje: mostrar?.t ?? "", mensajeEn: mostrar?.at ?? 0, canales, wa: wa?.id ?? "", ultimaActividad });
  }
  const nivel = { caliente: 0, tibio: 1, frio: 2 } as const;
  return out.sort(
    (a, b) =>
      MOTIVOS[a.motivo].orden - MOTIVOS[b.motivo].orden ||
      nivel[a.fila.lead.prioridad.nivel] - nivel[b.fila.lead.prioridad.nivel] ||
      b.ultimaActividad - a.ultimaActividad,
  );
}

// ─── Clasificar: sacar a una persona de la lista ─────────────────────────────

/** Todas las conversaciones de la misma persona (mismo teléfono): así el descarte vale para Instagram y WhatsApp. */
export async function convsDePersona(env: Env, convId: string): Promise<string[]> {
  const db = new Db(env.DB);
  const ids = new Set<string>([convId]);
  const claves = new Set<string>();
  if (convId.startsWith("ycloud:")) claves.add(clavePhone(convId.slice(7)));
  for (const r of await db.all<{ contact: string | null }>("SELECT contact FROM leads WHERE conversation_id = ? AND contact IS NOT NULL", [convId])) {
    const k = clavePhone(r.contact ?? "");
    if (k) claves.add(k);
  }
  for (const k of claves) {
    if (!k) continue;
    for (const r of await db.all<{ id: string }>("SELECT id FROM conversations WHERE channel = 'ycloud' AND channel_user_id LIKE ? LIMIT 5", [`%${k}`])) ids.add(r.id);
    for (const r of await db.all<{ conversation_id: string | null }>("SELECT DISTINCT conversation_id FROM leads WHERE contact LIKE ? AND conversation_id IS NOT NULL LIMIT 8", [`%${k}%`])) if (r.conversation_id) ids.add(r.conversation_id);
  }
  return [...ids];
}

/** «Perdido» se refleja también en el Pipeline; «más adelante» solo aplaza (vuelve a la lista en la fecha). */
export async function descartarPersona(env: Env, convId: string, motivo: string, hasta: string | null, now = Date.now()): Promise<{ ok: boolean; n: number }> {
  if (!(motivo in DESCARTES)) return { ok: false, n: 0 };
  const m = motivo as MotivoDescarte;
  let hastaMs: number | null = null;
  if (m === "mas_adelante") {
    hastaMs = hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta) ? Date.parse(`${hasta}T08:00:00Z`) : now + 7 * DIA;
    if (!(hastaMs > now)) hastaMs = now + 7 * DIA;
  }
  const db = new Db(env.DB);
  const ids = await convsDePersona(env, convId);
  const dato = JSON.stringify({ motivo: m, en: now, hasta: hastaMs });
  for (const id of ids) {
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_descarte', json(?)) WHERE id = ?", [dato, id]);
    if (DESCARTES[m].perdido) await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.crm_etapa', 'perdido') WHERE id = ?", [id]);
  }
  return { ok: true, n: ids.length };
}

export async function reactivarPersona(env: Env, convId: string): Promise<number> {
  const db = new Db(env.DB);
  const ids = await convsDePersona(env, convId);
  for (const id of ids) {
    const r = await db.first<{ d: string | null }>("SELECT json_extract(metadata, '$.crm_descarte') AS d FROM conversations WHERE id = ?", [id]);
    let perdido = false;
    try { perdido = DESCARTES[(JSON.parse(r?.d ?? "{}") as { motivo?: MotivoDescarte }).motivo as MotivoDescarte]?.perdido ?? false; } catch { /* ignorar */ }
    await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.crm_descarte') WHERE id = ?", [id]);
    if (perdido) await db.run("UPDATE conversations SET metadata = json_remove(COALESCE(metadata, '{}'), '$.crm_etapa') WHERE id = ? AND json_extract(metadata, '$.crm_etapa') = 'perdido'", [id]);
  }
  return ids.length;
}

// ─── Vista ───────────────────────────────────────────────────────────────────

const limpiarMsg = (t: string): string => t.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 220);

const fechaCorta = (ms: number): string => new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "short" }).format(new Date(ms));

function acciones(p: Pendiente, vq: string): string {
  const l = p.fila.lead;
  const cid = encodeURIComponent(l.convId);
  const tel = l.telefono.includes("/") ? l.telefono.slice(l.telefono.lastIndexOf("/") + 1).trim() : l.telefono;
  const agendar = `/crm/agendar?${new URLSearchParams({ nombre: l.nombre, tel, correo: l.correo.split(",")[0].trim(), modo: "solo_crm" }).toString()}`;
  const boton = (motivo: MotivoDescarte, extra = ""): string =>
    `<form method="POST" action="/crm/por-agendar/clasificar" style="margin:0"><input type="hidden" name="conv" value="${esc(l.convId)}"><input type="hidden" name="motivo" value="${motivo}"><input type="hidden" name="vq" value="${esc(vq)}">${extra}<button style="all:unset;cursor:pointer;display:block;padding:7px 10px;font-size:12px;color:var(--cream);width:100%;box-sizing:border-box">${DESCARTES[motivo].icono} ${DESCARTES[motivo].txt}</button></form>`;
  const manana = new Date(Date.now() + 7 * DIA).toISOString().slice(0, 10);
  return `<details style="position:relative"><summary style="cursor:pointer;font-size:11.5px;color:var(--accent);list-style:none;white-space:nowrap">Clasificar ▾</summary>
    <div style="position:absolute;right:0;z-index:5;min-width:230px;text-align:left;background:var(--panel);border:1px solid var(--line);box-shadow:0 6px 18px rgba(0,0,0,.18);margin-top:4px">
      <a href="${esc(agendar)}" style="display:block;padding:7px 10px;font-size:12px;color:var(--ok)">✅ Ya está agendada (registrarla)</a>
      <div style="border-top:1px solid var(--line)">${boton("mas_adelante", `<input type="date" name="hasta" value="${manana}" class="crm-in" style="margin:0 10px 4px;padding:3px 6px;font-size:11px;width:calc(100% - 20px)">`)}</div>
      <div style="border-top:1px solid var(--line)">${boton("no_interesado")}</div>
      <div style="border-top:1px solid var(--line)">${boton("no_quiso")}</div>
      <div style="border-top:1px solid var(--line)">${boton("sin_contacto")}</div>
      <a href="/crm/c/${cid}" style="display:block;padding:7px 10px;font-size:12px;color:var(--muted);border-top:1px solid var(--line)">Abrir la ficha</a>
    </div></details>`;
}

export async function renderCrmPorAgendar(env: Env, f: { motivo?: string; frios?: boolean } = {}, now = Date.now()): Promise<string> {
  const verDescartados = f.motivo === "descartados";
  const [activos, descartados] = await Promise.all([cargarPorAgendar(env, { frios: f.frios }, now), cargarPorAgendar(env, { descartados: true }, now)]);
  const motivo = (Object.keys(MOTIVOS) as MotivoPendiente[]).find((m) => m === f.motivo);
  const lista = verDescartados ? descartados : motivo ? activos.filter((p) => p.motivo === motivo) : activos;
  const n = (m: MotivoPendiente) => activos.filter((p) => p.motivo === m).length;
  const url = (m: string, frios = f.frios) => `/crm/por-agendar?${[m ? `motivo=${m}` : "", frios ? "frios=1" : ""].filter(Boolean).join("&")}`;
  const vq = [f.motivo ? `motivo=${f.motivo}` : "", f.frios ? "frios=1" : ""].filter(Boolean).join("&");

  const kpi = (href: string, titulo: string, num: number, on: boolean) =>
    `<a class="crm-kpi${on ? " on" : ""}" href="${href}"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${titulo}</div><div style="font-weight:700;font-size:26px">${num}</div></a>`;
  const tabs = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
    ${kpi(url(""), "Todos por agendar", activos.length, !motivo && !verDescartados)}
    ${(Object.keys(MOTIVOS) as MotivoPendiente[]).map((m) => kpi(url(m), `${MOTIVOS[m].icono} ${MOTIVOS[m].txt}`, n(m), motivo === m)).join("")}
    ${kpi(url("descartados"), "🗂 Descartados", descartados.length, verDescartados)}</div>`;

  const COLS = "150px minmax(150px,1.1fr) minmax(220px,1.8fr) 110px 150px 90px";
  const filas = lista
    .map((p) => {
      const l = p.fila.lead;
      const mo = MOTIVOS[p.motivo];
      const tel = digitos(l.telefono.includes("/") ? l.telefono.slice(l.telefono.lastIndexOf("/") + 1) : l.telefono);
      const waLink = tel.length >= 8 ? `<a href="https://wa.me/${esc(tel)}" target="_blank" rel="noopener" style="color:var(--ok);font-size:11.5px">💬 Abrir WhatsApp</a>` : "";
      const estado = verDescartados && p.descarte
        ? `<span style="font-weight:600;color:var(--cream)">${DESCARTES[p.descarte.motivo].icono} ${esc(DESCARTES[p.descarte.motivo].txt)}</span><div class="text-dim" style="font-weight:400;font-size:10.5px;margin-top:3px">${esc(fechaCorta(p.descarte.en))}${p.descarte.hasta ? ` · vuelve el ${esc(fechaCorta(p.descarte.hasta))}` : ""}</div>`
        : `<span style="font-weight:600;color:${p.motivo === "propuso" ? "var(--accent)" : "var(--cream)"}">${mo.icono} ${esc(mo.txt)}</span>${p.vuelve ? `<div style="font-size:10.5px;color:var(--info)">⏰ Pasó la fecha: vuelve a la lista</div>` : ""}<div class="text-dim" style="font-weight:400;font-size:10.5px;margin-top:3px">${esc(mo.accion)}</div>`;
      const accion = verDescartados
        ? `<form method="POST" action="/crm/por-agendar/reactivar" style="margin:0"><input type="hidden" name="conv" value="${esc(l.convId)}"><input type="hidden" name="vq" value="${esc(vq)}"><button class="ghostbtn" style="border:1px solid var(--line);padding:4px 8px;font-size:11px;color:var(--muted);background:none;cursor:pointer;font-family:inherit">↩ Reactivar</button></form>`
        : acciones(p, vq);
      return `<div class="crm-row" style="grid-template-columns:${COLS};align-items:start">
        <span>${estado}</span>
        <span><a href="/crm/c/${encodeURIComponent(l.convId)}" style="color:var(--cream);font-weight:600">${esc(l.nombre || "Sin nombre")}</a><br>${badgeNivel(l.prioridad.nivel)}<br><span class="text-dim" style="font-size:11px">${esc(p.canales.join(" + "))}</span></span>
        <span class="text-muted">${p.mensaje ? `<span class="crm-clamp">«${esc(limpiarMsg(p.mensaje))}»</span><span class="text-dim" style="font-size:10.5px">${esc(fechaHora(p.mensajeEn))}</span>` : `<span class="text-dim">Sin mensajes recientes</span>`}</span>
        <span class="text-muted" style="font-size:11.5px">${esc(l.telefono) || "—"}<br>${waLink}</span>
        <span class="text-dim" style="font-size:11.5px">Última actividad ${esc(hace(p.ultimaActividad, now))}</span>
        <span style="text-align:right">${accion}</span>
      </div>`;
    })
    .join("");

  const body = `${ESTILO_CRM}
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="text-dim" style="font-size:12.5px;flex:1;min-width:260px">Todas las personas que <b style="color:var(--cream)">todavía no tienen videollamada agendada</b>. Si alguien escribió un día u hora, aparece como «Propuso horario» con su mensaje para que lo confirmes. Usa <b style="color:var(--cream)">Clasificar</b> para sacar de la lista a quien ya no corresponde (ya agendada, no interesado, no quiso, número perdido o recontactar más adelante).</div>
      <a class="ghostbtn" href="${url(f.motivo ?? "", !f.frios)}" style="border:1px solid var(--line);padding:8px 14px;font-size:12.5px;color:var(--muted)">${f.frios ? "Ocultar fríos" : "Incluir fríos ⚪"}</a>
      <a class="ghostbtn" href="/crm/por-agendar.xlsx${f.frios ? "?frios=1" : ""}" style="border:1px solid var(--line);padding:8px 14px;font-size:12.5px;color:var(--muted)">⬇ Excel (${activos.length})</a>
    </div>
    ${tabs}
    <style>.pa-wrap{overflow-x:auto}@media (min-width:1000px){.pa-wrap{overflow:visible}}</style>
    <div class="crm-card pa-wrap"><div style="min-width:900px">
      <div class="crm-row crm-head" style="grid-template-columns:${COLS}"><span>${verDescartados ? "Motivo" : "Estado"}</span><span>Cliente</span><span>Lo último que escribió</span><span>Teléfono</span><span>Actividad</span><span></span></div>
      ${lista.length ? filas : `<div style="padding:44px 18px;text-align:center;color:var(--dim)">${verDescartados ? "No has descartado a nadie." : "No hay personas en esta lista 🎉"}</div>`}
    </div></div>
    <p class="text-dim" style="font-size:11px;margin-top:10px">Se incluyen clientes calientes y tibios con actividad en los últimos 90 días${f.frios ? " (y fríos)" : ""}. «Propuso horario» se detecta por palabras como días y horas: confirma leyendo el mensaje. Quien se descarta como no interesado, no quiso o número perdido pasa a «Perdido» en el Pipeline.</p>`;
  return crmLayout({ title: "Por agendar", activa: "poragendar", body, env });
}

export async function excelPorAgendar(env: Env, opts: { frios?: boolean } = {}, now = Date.now()): Promise<Uint8Array> {
  const todas = await cargarPorAgendar(env, opts, now);
  const rows: Array<Array<string | number>> = [["#", "Estado", "Qué hacer", "Prioridad", "Nombre", "Canales", "Teléfono", "Correo", "Ciudad de interés", "Lo último que escribió", "Fecha de ese mensaje", "Última actividad"]];
  todas.forEach((p, i) => {
    const l = p.fila.lead;
    rows.push([
      i + 1, MOTIVOS[p.motivo].txt, MOTIVOS[p.motivo].accion, l.prioridad.nivel === "caliente" ? "Caliente" : l.prioridad.nivel === "tibio" ? "Tibio" : "Frío",
      l.nombre, p.canales.join(" + "), l.telefono, l.correo, l.ficha.metadata.ciudadCompra ?? "", limpiarMsg(p.mensaje), p.mensajeEn ? fechaHora(p.mensajeEn) : "", fechaHora(p.ultimaActividad),
    ]);
  });
  return buildXlsx([{ name: "Por agendar", rows, widths: [5, 22, 44, 11, 28, 20, 18, 30, 22, 70, 18, 18] }]);
}
