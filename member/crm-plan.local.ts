// member/crm-plan.local.ts — CRM de Viventa: «Plan del día».
// Una sola pantalla con lo que hay que hacer HOY, en orden de importancia, para Maricela, Camila y Nicole:
//   🎯 en cierre · 📅 llamadas de hoy · 📌 lo prometido en llamadas (presupuestos pendientes) · 🔥 calientes sin llamada · ⏰ seguimientos vencidos de calientes · 📞 esperando un humano.
// Todo sale de lo que ya existe (pipeline, calendario, pendientes de las llamadas, Zoho); no gasta IA.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM, hace } from "./crm.local";

const H = 3_600_000;
const DIA = 24 * H;

export interface ItemPlan {
  convId: string;
  nombre: string;
  detalle: string;
  accion: string;
  telefono?: string;
}
export interface SeccionPlan {
  id: string;
  icono: string;
  titulo: string;
  ayuda: string;
  items: ItemPlan[];
}

const wa = (tel: string | undefined): string => {
  const d = (tel ?? "").replace(/\D/g, "");
  return d.length >= 9 ? `https://wa.me/${d}` : "";
};

export async function cargarPlan(env: Env, now = Date.now()): Promise<SeccionPlan[]> {
  const db = new Db(env.DB);
  const secciones: SeccionPlan[] = [];

  const { cargarPipeline } = await import("./crm-pipeline.local");
  const pipe = await cargarPipeline(env, now);
  const sinLlamada = (t: (typeof pipe)[number]) => !t.fila.lead.llamada;

  // 🎯 En cierre
  secciones.push({
    id: "cierre", icono: "🎯", titulo: "En cierre", ayuda: "Hablaron con Maricela y ya tienen el formulario de viabilidad: son los que hay que cerrar.",
    items: pipe.filter((t) => t.etapa === "cierre").sort((a, b) => b.fila.ultimo - a.fila.ultimo).slice(0, 15).map((t) => ({
      convId: t.fila.lead.convId, nombre: t.fila.lead.nombre, telefono: t.fila.lead.telefono,
      detalle: `Último mensaje ${hace(t.fila.ultimo, now)}`,
      accion: now - t.fila.ultimo > 2 * DIA ? "Lleva más de 2 días callado: escríbele para saber cómo va el formulario" : "Confirma que llenó el formulario y agenda la 2.ª videollamada con la constructora",
    })),
  });

  // 📅 Llamadas de hoy
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const ini = new Date(now); ini.setUTCHours(0, 0, 0, 0);
  const fin = ini.getTime() + DIA;
  const hoyLlamadas = (await cargarLlamadas(env, now)).filter((l) => l.estado === "agendada" && l.inicio >= now - H && l.inicio < fin + 6 * H).sort((a, b) => a.inicio - b.inicio);
  secciones.push({
    id: "llamadas", icono: "📅", titulo: "Videollamadas de hoy", ayuda: "En hora de España. Abre la ficha para ver el resumen del cliente antes de llamar.",
    items: hoyLlamadas.slice(0, 20).map((l) => ({
      convId: l.convId, nombre: l.nombre,
      detalle: `${new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(l.inicio))} · ${l.canal}${l.nivel ? ` · ${l.nivel === "caliente" ? "🔥" : l.nivel === "tibio" ? "🟡" : "⚪"}` : ""}`,
      accion: "Revisa su ficha antes de la llamada",
    })),
  });

  // 📌 Lo prometido en llamadas y aún sin hacer (presupuestos, enlaces…)
  let prometido: ItemPlan[] = [];
  try {
    const rs = await db.all<{ conversation_id: string; texto: string; cuando: string; creado: number }>(
      "SELECT conversation_id, texto, cuando, creado FROM crm_pendientes WHERE hecho = 0 AND responsable LIKE '%aricela%' AND creado > ? ORDER BY creado ASC LIMIT 40", [now - 14 * DIA]);
    const nombres = new Map(pipe.map((t) => [t.fila.lead.convId, t.fila.lead]));
    prometido = rs.map((r) => ({ convId: r.conversation_id, nombre: nombres.get(r.conversation_id)?.nombre ?? r.conversation_id.replace(/^\w+:/, ""), telefono: nombres.get(r.conversation_id)?.telefono, detalle: `${r.texto}${r.cuando ? ` (${r.cuando})` : ""}`, accion: `Prometido ${hace(r.creado, now)}: cúmplelo y márcalo como hecho en su ficha` }));
  } catch { /* la tabla aún no existe */ }
  secciones.push({ id: "prometido", icono: "📌", titulo: "Prometido en las llamadas", ayuda: "Lo que Maricela dijo que enviaría o haría y todavía no está marcado como hecho (los más viejos primero).", items: prometido.slice(0, 20) });

  // 🔥 Calientes sin llamada agendada
  secciones.push({
    id: "calientes", icono: "🔥", titulo: "Calientes sin videollamada", ayuda: "Cumplen las condiciones y todavía no tienen llamada. Ofréceles horario o envíales la cotización.",
    items: pipe.filter((t) => t.fila.lead.prioridad.nivel === "caliente" && sinLlamada(t) && ["calificado", "nuevo", "agendada"].includes(t.etapa) && now - t.fila.ultimo < 10 * DIA)
      .sort((a, b) => b.fila.ultimo - a.fila.ultimo).slice(0, 15).map((t) => ({
        convId: t.fila.lead.convId, nombre: t.fila.lead.nombre, telefono: t.fila.lead.telefono,
        detalle: `Último mensaje ${hace(t.fila.ultimo, now)} · ${t.fila.lead.canal}`,
        accion: now - t.fila.ultimo < 20 * H ? "Está dentro de las 24 h: puedes escribirle ya" : "Pasó la ventana de 24 h: usa la plantilla o espera a que escriba",
      })),
  });

  // ⏰ Seguimientos vencidos de clientes calientes o en cierre (Zoho)
  try {
    const { cargarSeguimientos } = await import("./crm-seguimientos.local");
    const { filas } = await cargarSeguimientos(env, now);
    secciones.push({
      id: "vencidas", icono: "⏰", titulo: "Seguimientos de Zoho de calientes", ayuda: "Tareas de hoy o vencidas de clientes calientes o en cierre: no se pueden enfriar.",
      items: filas.filter((x) => x.enCierre || x.nivel === "caliente").slice(0, 15).map((x) => ({
        convId: "", nombre: x.cand.nombre, telefono: x.cand.movil || x.cand.telefono,
        detalle: `${x.tarea.asunto || "Seguimiento"} · ${x.atraso > 0 ? `vencida hace ${x.atraso} día${x.atraso === 1 ? "" : "s"}` : "para hoy"}`,
        accion: "Hazla en Seguimientos (ya trae el mensaje preparado)",
      })),
    });
  } catch { secciones.push({ id: "vencidas", icono: "⏰", titulo: "Seguimientos de Zoho de calientes", ayuda: "No pude leer Zoho en este momento.", items: [] }); }

  // 📞 Esperando un humano
  try {
    const { cargarEsperandoHumano } = await import("./crm-humano.local");
    const h = await cargarEsperandoHumano(env, now);
    secciones.push({
      id: "humano", icono: "📞", titulo: "Esperando un humano", ayuda: "El bot no pudo terminar su prospección. Para Nicole: llamarlos con las preguntas del bot.",
      items: h.slice(0, 12).map((p) => ({ convId: p.convId, nombre: p.nombre, telefono: p.telefono, detalle: `${p.canal} · le faltan: ${p.faltan.length} preguntas · escribió ${hace(p.ultimoCliente, now)}`, accion: "Llámalo y retoma las preguntas" })),
    });
  } catch { /* sin esta sección */ }
  return secciones;
}

export async function renderCrmPlan(env: Env, now = Date.now()): Promise<string> {
  const secciones = await cargarPlan(env, now);
  const total = secciones.reduce((a, s) => a + s.items.length, 0);
  const bloques = secciones.map((s) => {
    const filas = s.items.map((i) => {
      const link = wa(i.telefono);
      return `<div style="display:grid;grid-template-columns:1.2fr 2fr auto;gap:12px;align-items:center;padding:9px 0;border-bottom:1px dashed var(--line)">
        <div>${i.convId ? `<a href="/crm/c/${encodeURIComponent(i.convId)}" style="font-weight:600;color:var(--cream)">${esc(i.nombre)}</a>` : `<b style="color:var(--cream)">${esc(i.nombre)}</b>`}${i.telefono ? `<div class="text-dim" style="font-size:11px">${esc(i.telefono)}</div>` : ""}</div>
        <div style="font-size:12px"><div class="text-muted">${esc(i.detalle)}</div><div class="text-dim" style="font-size:11px;margin-top:2px">➜ ${esc(i.accion)}</div></div>
        <div>${link ? `<a class="crm-in" href="${esc(link)}" target="_blank" rel="noopener" style="font-size:11px;padding:5px 9px;text-decoration:none">💬 WhatsApp</a>` : ""}</div></div>`;
    }).join("");
    return `<div class="crm-card" style="padding:16px;margin-bottom:14px"><div class="crm-sec">${s.icono} ${esc(s.titulo)} <span class="text-dim" style="font-weight:400">· ${s.items.length}</span></div>
      <div class="text-dim" style="font-size:11.5px;margin:2px 0 6px">${esc(s.ayuda)}</div>${filas || `<div class="text-dim" style="font-size:12px;padding:8px 0">Nada por aquí 🎉</div>`}</div>`;
  }).join("");
  const body = `${ESTILO_CRM}<div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Lo importante de hoy, en orden. ${total} cosas en total. Se actualiza al recargar.</div>${bloques}`;
  return crmLayout({ title: "Plan del día", activa: "plan", body, env });
}
