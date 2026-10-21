// member/crm-retomar.local.ts — Envío masivo (autorizado por Brayan el 20 oct 2026) de la plantilla «viventa_retomar_interes» a los clientes de WhatsApp
// que quedaron fuera de la ventana de 24 h sin agendar: se quedaron a medias en el guion, terminaron y no eligieron día, o escribieron y nadie les contestó.
// Arranca solo cuando Meta aprueba la plantilla, de a pocos por pasada y en el horario de cada cliente. Salta a quien ya tiene cita, a quien atendió una persona
// (también desde la app de WhatsApp Business: se compara con lo que YCloud registró) y a quien ya se le mandó.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { MessagesRepo } from "../src/db/messages";
import { puedeEscribirAhora } from "../src/lib/horarioCliente";

export const AJUSTE_RETOMAR = "viventa_retomar_masivo";
export const TPL_RETOMAR = "viventa_retomar_interes";
export const TEXTO_RETOMAR =
  "Hola 😊 Hace unos días nos escribiste porque estabas interesado/a en comprar vivienda en Colombia.\n\nQuería saber si todavía te gustaría recibir información.\n\nSi quieres, podemos continuar por aquí de forma muy sencilla.\n\n¿Sigues interesado/a?\n\n[Opciones: Sí, quiero continuar · Más adelante · Ya no estoy interesado/a]";

const H = 3_600_000;
const DIA = 24 * H;
const MAX_POR_PASADA = 8;

type FetchFn = typeof fetch;

export async function estadoPlantilla(env: Env, nombre: string, f: FetchFn = fetch): Promise<string> {
  if (!env.YCLOUD_API_KEY) return "";
  try {
    const h = { "X-API-Key": env.YCLOUD_API_KEY };
    const numeros = (await (await f("https://api.ycloud.com/v2/whatsapp/phoneNumbers?limit=20", { headers: h })).json()) as { items?: Array<{ phoneNumber?: string; wabaId?: string }> };
    const mio = (numeros.items ?? []).find((n) => String(n.phoneNumber ?? "").replace(/\D/g, "") === (env.YCLOUD_WA_FROM ?? "").replace(/\D/g, "")) ?? numeros.items?.[0];
    if (!mio?.wabaId) return "";
    const t = (await (await f(`https://api.ycloud.com/v2/whatsapp/templates?limit=100&filter.wabaId=${encodeURIComponent(mio.wabaId)}`, { headers: h })).json()) as { items?: Array<{ name?: string; status?: string }> };
    return (t.items ?? []).find((x) => x.name === nombre)?.status ?? "";
  } catch (e) {
    console.error("[retomarMasivo] estado de la plantilla:", e);
    return "";
  }
}

/** Mensajes que YCloud registró hacia ese número DESPUÉS del último mensaje del cliente (sin contar los fallidos). */
async function salientesDespues(env: Env, tel: string, desde: number, f: FetchFn): Promise<number | null> {
  try {
    const r = await f(`https://api.ycloud.com/v2/whatsapp/messages?limit=30&page=1&filter.to=%2B${tel.replace(/\D/g, "")}`, { headers: { "X-API-Key": env.YCLOUD_API_KEY ?? "" } });
    if (!r.ok) return null;
    const items = ((await r.json()) as { items?: Array<{ status?: string; createTime?: string }> }).items ?? [];
    return items.filter((m) => m.status !== "failed" && Date.parse(m.createTime ?? "") > desde).length;
  } catch {
    return null;
  }
}

export async function runRetomarMasivo(env: Env, now = Date.now(), f: FetchFn = fetch): Promise<{ sent: number; omitidos: number; fallos: number }> {
  const out = { sent: 0, omitidos: 0, fallos: 0 };
  const db = new Db(env.DB);
  const st = new SettingsRepo(db);
  if (((await st.get(AJUSTE_RETOMAR)) ?? "").trim().toLowerCase() !== "activo") return out;
  if (!env.YCLOUD_API_KEY) return out;
  const estado = await estadoPlantilla(env, TPL_RETOMAR, f);
  if (estado !== "APPROVED") {
    // Aviso una sola vez cuando Meta responde (aprobada o rechazada).
    if (/REJECTED|PAUSED|DISABLED/.test(estado) && ((await st.get("viventa_retomar_aviso")) ?? "") !== estado) {
      await st.set("viventa_retomar_aviso", estado);
      try {
        const { notifyCamila } = await import("../src/lib/camila");
        await notifyCamila(env, { heading: "⚠️ Meta NO aprobó la plantilla de retomar", body: `«${TPL_RETOMAR}» quedó en estado ${estado}. No se enviará nada hasta crear otra versión.` }).catch(() => false);
      } catch {
        /* sin aviso */
      }
    }
    return out;
  }
  if (((await st.get("viventa_retomar_aviso")) ?? "") !== "APPROVED") {
    await st.set("viventa_retomar_aviso", "APPROVED");
    try {
      const { notifyCamila } = await import("../src/lib/camila");
      await notifyCamila(env, { heading: "✅ Meta aprobó la plantilla de retomar", body: "El bot empieza a escribirles a los clientes que quedaron fuera de la ventana de 24 h (de a 8 cada 15 min, de 9 a 21 h de cada cliente)." }).catch(() => false);
    } catch {
      /* sin aviso */
    }
  }

  const candidatos = await db.all<{ id: string; channel_user_id: string; display_name: string | null; ult_cli: number }>(
    `SELECT c.id, c.channel_user_id, c.display_name,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS ult_cli
       FROM conversations c
      WHERE c.channel = 'ycloud' AND c.last_message_at >= ?
        AND (c.paused_until IS NULL OR c.paused_until < ?)
        AND json_extract(COALESCE(c.metadata, '{}'), '$.viventa_retomar') IS NULL
        AND COALESCE(json_extract(c.metadata, '$.crm_etapa'), '') NOT IN ('perdido', 'cerrado')
        AND json_extract(COALESCE(c.metadata, '{}'), '$.crm_descarte') IS NULL
        AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.conversation_id = c.id AND l.intent LIKE 'Cita ·%')
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'owner')
        AND (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') < ?
      ORDER BY ult_cli DESC LIMIT 40`,
    [now - 30 * DIA, now, now - DIA],
  );
  const reactivados = new Set((await db.all<{ conv_id: string }>("SELECT conv_id FROM crm_reactiva WHERE conv_id IS NOT NULL").catch(() => [])).map((r) => r.conv_id));
  const { sendYCloudTemplate } = await import("../src/channels/ycloud");
  let seguidosFallidos = 0;
  const marca = (id: string, v: string) => db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_retomar', ?) WHERE id = ?", [v, id]);
  for (const c of candidatos) {
    if (out.sent >= MAX_POR_PASADA || seguidosFallidos >= 2) break;
    if (reactivados.has(c.id)) {
      await marca(c.id, "reactivacion");
      continue;
    }
    if (!(await puedeEscribirAhora(db, { id: c.id, channel: "ycloud", channel_user_id: c.channel_user_id }, now))) {
      out.omitidos++;
      continue;
    }
    // ¿Alguien del equipo ya le contestó desde la app de WhatsApp Business? YCloud registra más mensajes que los del bot que tenemos guardados.
    const enYCloud = await salientesDespues(env, c.channel_user_id, c.ult_cli, f);
    const guardados = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role IN ('assistant', 'owner') AND created_at > ?", [c.id, c.ult_cli]))?.n ?? 0;
    if (enYCloud != null && enYCloud > guardados) {
      await marca(c.id, "ya-atendido-desde-la-app");
      out.omitidos++;
      continue;
    }
    try {
      await sendYCloudTemplate(env, c.channel_user_id, TPL_RETOMAR, "es_ES", []);
      await new MessagesRepo(db).append(c.id, "assistant", TEXTO_RETOMAR, { createdAt: now });
      await marca(c.id, new Date(now).toISOString());
      out.sent++;
      seguidosFallidos = 0;
    } catch (e) {
      out.fallos++;
      seguidosFallidos++;
      console.error(`[retomarMasivo] ${c.id}:`, e);
    }
  }
  if (out.sent > 0 || out.fallos > 0) {
    try {
      const { notifyCamila } = await import("../src/lib/camila");
      await notifyCamila(env, {
        heading: out.fallos ? "⚠️ Retomar clientes: hubo envíos que fallaron" : "🔁 Retomar clientes",
        body: `El bot les escribió a ${out.sent} cliente(s) que estaban fuera de la ventana de 24 h (plantilla «¿Sigues interesado/a?»).${out.fallos ? ` ${out.fallos} fallaron.` : ""} Cuando respondan, el bot sigue la conversación.`,
      }).catch(() => false);
    } catch {
      /* sin aviso */
    }
  }
  return out;
}
