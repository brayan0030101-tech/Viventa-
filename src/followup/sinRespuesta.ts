/**
 * Avisa al equipo cuando un cliente escribió algo que parece una pregunta o un pedido real y nadie le ha respondido en 10 minutos
 * (ni el bot ni una persona). El 19 oct 2026 una clienta preguntó si su hermano podía ir a ver el proyecto y el bot abrió un ticket
 * pero no le contestó; nadie se enteró hasta el día siguiente. No avisa por «vale / gracias / ok», ni en conversaciones pausadas
 * (ya las atiende una persona), ni dos veces por el mismo mensaje.
 */
import type { Env } from "../env";
import { Db } from "../db/client";

const MIN = 60_000;
const H = 3_600_000;

const CORTESIAS = new Set([
  "vale", "ok", "okey", "okay", "gracias", "muchas", "perfecto", "listo", "genial", "excelente", "bueno", "entendido", "dale", "claro",
  "super", "súper", "bien", "si", "sí", "no", "ya", "hola", "buenas", "buenos", "dias", "días", "tardes", "noches", "de", "nada", "por", "favor",
  "muy", "amable", "te", "lo", "agradezco", "quedo", "atento", "atenta", "pendiente", "saludos", "adios", "adiós", "chao", "hasta", "luego",
]);

/** «Vale», «Gracias 🙏», «Vale perfecto muchas gracias»: no necesitan respuesta. */
export function esCortesia(texto: string): boolean {
  const palabras = texto.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return true; // solo emojis o signos
  return !texto.includes("?") && palabras.every((p) => CORTESIAS.has(p));
}

export async function runSinRespuesta(env: Env, now = Date.now()): Promise<{ avisados: number }> {
  const db = new Db(env.DB);
  const ult = await db.all<{ conversation_id: string; created_at: number; content: string }>(
    "SELECT conversation_id, created_at, content FROM messages WHERE role = 'user' AND created_at BETWEEN ? AND ? ORDER BY created_at ASC",
    [now - 3 * H, now - 10 * MIN],
  );
  if (ult.length === 0) return { avisados: 0 };
  // Solo el último mensaje del cliente en cada conversación.
  const porConv = new Map<string, { created_at: number; content: string }>();
  for (const m of ult) porConv.set(m.conversation_id, { created_at: m.created_at, content: m.content });

  const pendientes: Array<{ id: string; nombre: string; texto: string; creado: number }> = [];
  for (const [id, m] of porConv) {
    if (esCortesia(m.content)) continue;
    const despues = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND created_at > ? AND role IN ('assistant', 'owner')", [id, m.created_at]);
    if ((despues?.n ?? 0) > 0) continue;
    const conv = await db.first<{ display_name: string | null; channel: string; paused_until: number | null; avisado: string | null }>(
      "SELECT display_name, channel, paused_until, json_extract(COALESCE(metadata, '{}'), '$.viventa_sinresp') AS avisado FROM conversations WHERE id = ?",
      [id],
    );
    if (!conv || !["ycloud", "zernio"].includes(conv.channel)) continue;
    if (conv.paused_until && conv.paused_until > now) continue; // ya la atiende una persona
    if (conv.avisado && Number(conv.avisado) >= m.created_at) continue;
    pendientes.push({ id, nombre: conv.display_name || "Cliente", texto: m.content.replace(/\s+/g, " ").slice(0, 90), creado: m.created_at });
  }
  if (pendientes.length === 0) return { avisados: 0 };

  for (const p of pendientes) {
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_sinresp', ?) WHERE id = ?", [p.creado, p.id]);
  }
  try {
    const { notifyCamila } = await import("../lib/camila");
    await notifyCamila(env, {
      heading: `💬 ${pendientes.length === 1 ? "Un cliente escribió y nadie le ha respondido" : `${pendientes.length} clientes escribieron y nadie les ha respondido`}`,
      body: pendientes.slice(0, 8).map((p) => `• ${p.nombre}: «${p.texto}»`).join("\n") + "\n\nRevisa el panel y respóndeles.",
      url: `${env.DASHBOARD_BASE_URL || ""}/admin`,
    }).catch(() => false);
  } catch (e) {
    console.error("[sin-respuesta] aviso:", e);
  }
  return { avisados: pendientes.length };
}

/**
 * Buenos perfiles (ticket «Lead calificado») que 2 h después siguen sin videollamada agendada: aviso al equipo para que los
 * retome a mano antes de que se les cierre la ventana de 24 h (19 oct 2026: dos clientas con buen perfil se quedaron sin agendar).
 * Una sola vez por conversación; no avisa si ya hay cita o si una persona atiende la conversación.
 */
export async function runCalificadosSinCita(env: Env, now = Date.now()): Promise<{ avisados: number }> {
  const db = new Db(env.DB);
  const tickets = await db.all<{ conversation_id: string; summary: string; created_at: number }>(
    "SELECT conversation_id, summary, created_at FROM tickets WHERE summary LIKE '[Lead calificado%' AND created_at BETWEEN ? AND ?",
    [now - 22 * H, now - 2 * H],
  );
  if (tickets.length === 0) return { avisados: 0 };
  const ids = [...new Set(tickets.map((t) => t.conversation_id))];
  const conCita = new Set(
    (await db.all<{ conversation_id: string }>("SELECT DISTINCT conversation_id FROM leads WHERE intent LIKE 'Cita ·%' AND created_at > ?", [now - 24 * H])).map((r) => r.conversation_id),
  );
  const lista: Array<{ id: string; nombre: string; resumen: string }> = [];
  for (const id of ids) {
    if (conCita.has(id)) continue;
    const conv = await db.first<{ display_name: string | null; paused_until: number | null; marca: string | null; channel: string }>(
      "SELECT display_name, paused_until, channel, json_extract(COALESCE(metadata, '{}'), '$.viventa_calif_sincita') AS marca FROM conversations WHERE id = ?",
      [id],
    );
    if (!conv || conv.marca || !["ycloud", "zernio"].includes(conv.channel)) continue;
    if (conv.paused_until && conv.paused_until > now) continue;
    const t = tickets.find((x) => x.conversation_id === id)!;
    lista.push({ id, nombre: conv.display_name || "Cliente", resumen: t.summary.replace(/^\[Lead calificado[^\]]*\]\s*/, "").slice(0, 110) });
  }
  if (lista.length === 0) return { avisados: 0 };
  for (const l of lista) await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_calif_sincita', ?) WHERE id = ?", [new Date(now).toISOString(), l.id]);
  try {
    const { notifyCamila } = await import("../lib/camila");
    await notifyCamila(env, {
      heading: `🎯 ${lista.length === 1 ? "Un buen perfil lleva 2 h sin agendar videollamada" : `${lista.length} buenos perfiles llevan 2 h sin agendar videollamada`}`,
      body: lista.slice(0, 8).map((l) => `• ${l.nombre}: ${l.resumen}`).join("\n") + "\n\nRetómalos hoy (llamada o WhatsApp) antes de que se cierre su ventana de 24 h.",
      url: `${env.DASHBOARD_BASE_URL || ""}/admin`,
    }).catch(() => false);
  } catch (e) {
    console.error("[calificados-sin-cita] aviso:", e);
  }
  return { avisados: lista.length };
}
