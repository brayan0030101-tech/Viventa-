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
