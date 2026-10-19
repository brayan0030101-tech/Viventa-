/**
 * Mensajes que YCloud ACEPTÓ pero WhatsApp RECHAZÓ después.
 * `sendDirectly` contesta 200 en cuanto YCloud recibe el mensaje; si Meta lo rechaza (típico: 131047, pasaron más de
 * 24 h desde que el cliente escribió) el fallo llega minutos después solo como estado `failed`. El panel ya había
 * guardado el mensaje como enviado y nadie se enteraba de que el cliente nunca lo recibió (19 oct 2026).
 * Cada pasada de 5 min mira los últimos mensajes de YCloud; por cada uno fallado y nuevo deja una nota en el hilo
 * y avisa al equipo una sola vez.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { MessagesRepo } from "../db/messages";

const DIA = 86_400_000;
const MAX_VISTOS = 300;

interface MsgYCloud {
  id?: string;
  status?: string;
  from?: string;
  to?: string;
  errorCode?: string | number;
  errorMessage?: string;
  createTime?: string;
}

const soloDigitos = (s: string | undefined | null): string => (s ?? "").replace(/\D/g, "");

export function motivoFallo(codigo: string, detalle: string): string {
  if (codigo === "131047") return "pasaron más de 24 horas desde que el cliente escribió: WhatsApp solo deja mandar una plantilla aprobada o escribirle desde la app de WhatsApp Business";
  if (codigo === "131026") return "ese número no tiene WhatsApp o no pudo recibirlo";
  if (codigo === "131049") return "WhatsApp frenó el envío para proteger al cliente de mensajes de marketing (límite por cliente)";
  return detalle ? detalle.slice(0, 140) : `código ${codigo || "desconocido"}`;
}

export async function runFallosYCloud(env: Env, now = Date.now(), f: typeof fetch = fetch): Promise<{ nuevos: number }> {
  if (!env.YCLOUD_API_KEY) return { nuevos: 0 };
  let items: MsgYCloud[];
  try {
    const res = await f("https://api.ycloud.com/v2/whatsapp/messages?limit=50&page=1", { headers: { "X-API-Key": env.YCLOUD_API_KEY } });
    if (!res.ok) {
      console.error(`[fallos-ycloud] http ${res.status}`);
      return { nuevos: 0 };
    }
    items = ((await res.json()) as { items?: MsgYCloud[] }).items ?? [];
  } catch (e) {
    console.error("[fallos-ycloud]", e);
    return { nuevos: 0 };
  }
  const mio = soloDigitos(env.YCLOUD_WA_FROM);
  const fallados = items.filter((m) => m.status === "failed" && m.id && soloDigitos(m.from) === mio && now - Date.parse(m.createTime ?? "") < 3 * DIA);
  if (fallados.length === 0) return { nuevos: 0 };

  const db = new Db(env.DB);
  const settings = new SettingsRepo(db);
  let vistos: string[] = [];
  try {
    vistos = JSON.parse((await settings.get("ycloud_fallos_vistos")) ?? "[]") as string[];
  } catch {
    /* se reinicia */
  }
  const nuevos = fallados.filter((m) => !vistos.includes(m.id as string));
  if (nuevos.length === 0) return { nuevos: 0 };
  await settings.set("ycloud_fallos_vistos", JSON.stringify([...nuevos.map((m) => m.id as string), ...vistos].slice(0, MAX_VISTOS)));

  const msgs = new MessagesRepo(db);
  const lineas: string[] = [];
  for (const m of nuevos) {
    const tel = soloDigitos(m.to);
    const motivo = motivoFallo(String(m.errorCode ?? ""), m.errorMessage ?? "");
    const conv = await db.first<{ id: string; display_name: string | null }>("SELECT id, display_name FROM conversations WHERE channel = 'ycloud' AND channel_user_id = ? LIMIT 1", [tel]);
    if (conv) await msgs.append(conv.id, "note", `⚠️ NO LLEGÓ al cliente: WhatsApp rechazó un mensaje enviado ${m.createTime ? `el ${new Date(m.createTime).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""} — ${motivo}.`).catch(() => {});
    lineas.push(`• ${conv?.display_name || "Cliente"} (+${tel})`);
  }
  try {
    const { notifyCamila } = await import("../lib/camila");
    await notifyCamila(env, {
      heading: `⚠️ ${nuevos.length} mensaje${nuevos.length === 1 ? "" : "s"} NO llegó al cliente`,
      body: `WhatsApp rechazó estos envíos (lo más común: pasaron más de 24 h desde que el cliente escribió). Escríbeles desde la app de WhatsApp Business o con una plantilla aprobada:\n${lineas.slice(0, 10).join("\n")}${lineas.length > 10 ? `\n… y ${lineas.length - 10} más` : ""}`,
      url: `${env.DASHBOARD_BASE_URL || ""}/admin`,
    }).catch(() => false);
  } catch (e) {
    console.error("[fallos-ycloud] aviso:", e);
  }
  return { nuevos: nuevos.length };
}
