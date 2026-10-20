/**
 * Lo que el equipo escribe desde la app de WhatsApp Business (coexistencia) no traía el texto en el webhook, así que el panel
 * no lo mostraba y Maricela y Camila escribían desde el panel para ver todo junto — y fuera de las 24 h esos mensajes no
 * llegaban (19 oct 2026). Aquí: el webhook anota el wamid del echo y cada 5 min se busca ese mensaje en la lista de YCloud
 * (que sí trae el texto) para guardarlo en el hilo como mensaje del equipo (rol owner).
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";

const DIA = 86_400_000;

async function asegurarTabla(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS ycloud_echo_pendientes (wamid TEXT PRIMARY KEY, conv_id TEXT NOT NULL, creado INTEGER NOT NULL)");
}

export async function anotarEcho(env: Env, wamid: string, convId: string, now = Date.now()): Promise<void> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  await db.run("INSERT OR IGNORE INTO ycloud_echo_pendientes (wamid, conv_id, creado) VALUES (?,?,?)", [wamid, convId, now]);
}

export async function runSincronizarApp(env: Env, now = Date.now(), f: typeof fetch = fetch): Promise<{ guardados: number }> {
  if (!env.YCLOUD_API_KEY) return { guardados: 0 };
  const db = new Db(env.DB);
  await asegurarTabla(db);
  await db.run("DELETE FROM ycloud_echo_pendientes WHERE creado < ?", [now - 2 * DIA]);
  const pendientes = await db.all<{ wamid: string; conv_id: string }>("SELECT wamid, conv_id FROM ycloud_echo_pendientes");
  if (pendientes.length === 0) return { guardados: 0 };

  let items: Array<{ wamid?: string; type?: string; text?: unknown }>;
  try {
    const res = await f("https://api.ycloud.com/v2/whatsapp/messages?limit=100&page=1", { headers: { "X-API-Key": env.YCLOUD_API_KEY } });
    if (!res.ok) {
      console.error(`[sincronizar-app] http ${res.status}`);
      return { guardados: 0 };
    }
    items = ((await res.json()) as { items?: typeof items }).items ?? [];
  } catch (e) {
    console.error("[sincronizar-app]", e);
    return { guardados: 0 };
  }
  const porWamid = new Map(items.filter((m) => m.wamid).map((m) => [m.wamid as string, m]));
  const msgs = new MessagesRepo(db);
  let guardados = 0;
  for (const p of pendientes) {
    const m = porWamid.get(p.wamid);
    if (!m) continue; // aún no aparece en la lista: se reintenta en la próxima pasada
    const t = m.text as { body?: string } | string | undefined;
    const texto = (typeof t === "string" ? t : t?.body ?? "").trim();
    if (texto) {
      await msgs.append(p.conv_id, "owner", texto);
      guardados++;
    }
    await db.run("DELETE FROM ycloud_echo_pendientes WHERE wamid = ?", [p.wamid]);
  }
  return { guardados };
}
