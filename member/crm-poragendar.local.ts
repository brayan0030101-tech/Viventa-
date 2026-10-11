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

export interface Pendiente {
  fila: FilaCrm;
  motivo: MotivoPendiente;
  /** Último mensaje del cliente que sugiere el horario (o el último que escribió). */
  mensaje: string;
  mensajeEn: number;
  canales: string[];
  wa: string;
  ultimaActividad: number;
}

export async function cargarPorAgendar(env: Env, opts: { frios?: boolean } = {}, now = Date.now()): Promise<Pendiente[]> {
  const db = new Db(env.DB);
  const filas = await cargarCrm(env, now);

  // 1) Quién ya tiene (o tuvo) videollamada: se excluye. Las canceladas SÍ cuentan como por agendar.
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const conLlamada = new Set<string>();
  for (const l of await cargarLlamadas(env, now)) if (l.estado !== "cancelada") conLlamada.add(l.convId);

  // 2) Etapa fijada a mano como cerrado/perdido: se excluye.
  const cerrados = new Set(
    (await db.all<{ id: string }>("SELECT id FROM conversations WHERE json_extract(metadata, '$.crm_etapa') IN ('cerrado', 'perdido')")).map((r) => r.id),
  );

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
    if (!opts.frios && f.lead.prioridad.nivel === "frio") continue;

    const suyos = [...convs].flatMap((c) => porConv.get(c) ?? []).sort((a, b) => b.at - a.at);
    const propuesta = suyos.find((m) => proponeHorario(m.t));
    const reciente = suyos[0];
    const tieneTel = !!clavePhone(f.lead.telefono || "") || !!wa;
    const canales = [...new Set([...convs].map((c) => (c.startsWith("ycloud") ? "WhatsApp" : c.startsWith("zernio") ? "Instagram" : "Otro")))];
    const ultimaActividad = Math.max(f.ultimo, wa?.ultimo ?? 0);

    let motivo: MotivoPendiente;
    if (propuesta) motivo = "propuso";
    else if (reciente && now - reciente.at < SIN_RESPUESTA_DIAS * DIA) motivo = "conversando";
    else if (wa || f.lead.canal === "WhatsApp") motivo = "sin_respuesta";
    else if (tieneTel) motivo = "sin_contactar";
    else motivo = "sin_telefono";

    const mostrar = propuesta ?? reciente;
    out.push({ fila: f, motivo, mensaje: mostrar?.t ?? "", mensajeEn: mostrar?.at ?? 0, canales, wa: wa?.id ?? "", ultimaActividad });
  }
  const nivel = { caliente: 0, tibio: 1, frio: 2 } as const;
  return out.sort(
    (a, b) =>
      MOTIVOS[a.motivo].orden - MOTIVOS[b.motivo].orden ||
      nivel[a.fila.lead.prioridad.nivel] - nivel[b.fila.lead.prioridad.nivel] ||
      b.ultimaActividad - a.ultimaActividad,
  );
}

// ─── Vista ───────────────────────────────────────────────────────────────────

const limpiarMsg = (t: string): string => t.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 220);

export async function renderCrmPorAgendar(env: Env, f: { motivo?: string; frios?: boolean } = {}, now = Date.now()): Promise<string> {
  const todas = await cargarPorAgendar(env, { frios: f.frios }, now);
  const motivo = (Object.keys(MOTIVOS) as MotivoPendiente[]).find((m) => m === f.motivo);
  const lista = motivo ? todas.filter((p) => p.motivo === motivo) : todas;
  const n = (m: MotivoPendiente) => todas.filter((p) => p.motivo === m).length;
  const url = (m: string, frios = f.frios) => `/crm/por-agendar?${[m ? `motivo=${m}` : "", frios ? "frios=1" : ""].filter(Boolean).join("&")}`;

  const tabs = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
    <a class="crm-kpi${!motivo ? " on" : ""}" href="${url("")}"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">Todos por agendar</div><div style="font-weight:700;font-size:26px">${todas.length}</div></a>
    ${(Object.keys(MOTIVOS) as MotivoPendiente[])
      .map(
        (m) => `<a class="crm-kpi${motivo === m ? " on" : ""}" href="${url(m)}"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${MOTIVOS[m].icono} ${MOTIVOS[m].txt}</div><div style="font-weight:700;font-size:26px">${n(m)}</div></a>`,
      )
      .join("")}</div>`;

  const filas = lista
    .map((p) => {
      const l = p.fila.lead;
      const mo = MOTIVOS[p.motivo];
      const tel = digitos(l.telefono.includes("/") ? l.telefono.slice(l.telefono.lastIndexOf("/") + 1) : l.telefono);
      const waLink = tel.length >= 8 ? `<a href="https://wa.me/${esc(tel)}" target="_blank" rel="noopener" style="color:var(--ok);font-size:11.5px">💬 Abrir WhatsApp</a>` : "";
      return `<div class="crm-row" style="grid-template-columns:150px minmax(150px,1.1fr) minmax(220px,1.8fr) 110px 150px;align-items:start">
        <span style="font-weight:600;color:${p.motivo === "propuso" ? "var(--accent)" : "var(--cream)"}">${mo.icono} ${esc(mo.txt)}<div class="text-dim" style="font-weight:400;font-size:10.5px;margin-top:3px">${esc(mo.accion)}</div></span>
        <span><a href="/crm/c/${encodeURIComponent(l.convId)}" style="color:var(--cream);font-weight:600">${esc(l.nombre || "Sin nombre")}</a><br>${badgeNivel(l.prioridad.nivel)}<br><span class="text-dim" style="font-size:11px">${esc(p.canales.join(" + "))}</span></span>
        <span class="text-muted">${p.mensaje ? `<span class="crm-clamp">«${esc(limpiarMsg(p.mensaje))}»</span><span class="text-dim" style="font-size:10.5px">${esc(fechaHora(p.mensajeEn))}</span>` : `<span class="text-dim">Sin mensajes recientes</span>`}</span>
        <span class="text-muted" style="font-size:11.5px">${esc(l.telefono) || "—"}<br>${waLink}</span>
        <span class="text-dim" style="font-size:11.5px">Última actividad ${esc(hace(p.ultimaActividad, now))}</span>
      </div>`;
    })
    .join("");

  const body = `${ESTILO_CRM}
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="text-dim" style="font-size:12.5px;flex:1;min-width:260px">Todas las personas que <b style="color:var(--cream)">todavía no tienen videollamada agendada</b>. Si alguien escribió un día u hora, aparece como «Propuso horario» con su mensaje para que lo confirmes. Une Instagram y WhatsApp por el teléfono.</div>
      <a class="ghostbtn" href="${url("", !f.frios)}" style="border:1px solid var(--line);padding:8px 14px;font-size:12.5px;color:var(--muted)">${f.frios ? "Ocultar fríos" : "Incluir fríos ⚪"}</a>
      <a class="ghostbtn" href="/crm/por-agendar.xlsx${f.frios ? "?frios=1" : ""}" style="border:1px solid var(--line);padding:8px 14px;font-size:12.5px;color:var(--muted)">⬇ Excel (${todas.length})</a>
    </div>
    ${tabs}
    <div class="crm-card" style="overflow-x:auto"><div style="min-width:860px">
      <div class="crm-row crm-head" style="grid-template-columns:150px minmax(150px,1.1fr) minmax(220px,1.8fr) 110px 150px"><span>Estado</span><span>Cliente</span><span>Lo último que escribió</span><span>Teléfono</span><span>Actividad</span></div>
      ${lista.length ? filas : `<div style="padding:44px 18px;text-align:center;color:var(--dim)">No hay personas en esta lista 🎉</div>`}
    </div></div>
    <p class="text-dim" style="font-size:11px;margin-top:10px">Se incluyen clientes calientes y tibios con actividad en los últimos 90 días${f.frios ? " (y fríos)" : ""}. «Propuso horario» se detecta por palabras como días y horas: confirma leyendo el mensaje.</p>`;
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
