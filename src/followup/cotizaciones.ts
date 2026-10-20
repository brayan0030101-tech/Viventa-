/**
 * Cotizaciones enviadas por WhatsApp. Maricela arma las cotizaciones en ViveHome (vivehome.viventa.co, «COT-2398») y las manda a los clientes con un
 * enlace `quota-information?id=2398` (el id es el número de la cotización). Cada pasada de 15 min mira los últimos mensajes salientes de YCloud (los que
 * escribe el equipo desde la app y los del bot) y guarda los que llevan ese enlace en `cotizaciones_enviadas`: a quién, cuándo y cuál. Alimenta
 * CRM → Cotizaciones.
 */
import type { Env } from "../env";
import { Db } from "../db/client";

const RE_COT = /quota-information\?id=(\d+)/gi;

export async function asegurarTablaCotizaciones(db: Db): Promise<void> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS cotizaciones_enviadas (msg_id TEXT NOT NULL, cot_id TEXT NOT NULL, tel TEXT NOT NULL, enviada_en INTEGER NOT NULL, PRIMARY KEY (msg_id, cot_id))",
  );
  await db.run("CREATE INDEX IF NOT EXISTS idx_cot_tel ON cotizaciones_enviadas (tel, enviada_en)");
}

interface MsgSaliente {
  id?: string;
  wamid?: string;
  to?: string;
  status?: string;
  createTime?: string;
  text?: unknown;
}

/** Guarda las cotizaciones que aparezcan en estos mensajes; devuelve cuántas filas nuevas. */
export async function guardarCotizaciones(env: Env, items: MsgSaliente[]): Promise<number> {
  const db = new Db(env.DB);
  await asegurarTablaCotizaciones(db);
  let nuevas = 0;
  for (const m of items) {
    if (m.status === "failed") continue;
    const t = m.text as { body?: string } | string | undefined;
    const texto = typeof t === "string" ? t : t?.body ?? "";
    if (!texto.includes("quota-information")) continue;
    const tel = String(m.to ?? "").replace(/\D/g, "");
    const cuando = Date.parse(m.createTime ?? "");
    if (!tel || !Number.isFinite(cuando)) continue;
    for (const g of texto.matchAll(RE_COT)) {
      const r = await db.run("INSERT OR IGNORE INTO cotizaciones_enviadas (msg_id, cot_id, tel, enviada_en) VALUES (?,?,?,?)", [String(m.wamid ?? m.id ?? `${tel}-${cuando}`), g[1], tel, cuando]);
      nuevas += (r as { meta?: { changes?: number } }).meta?.changes ?? 0;
    }
  }
  return nuevas;
}

export async function runCotizaciones(env: Env, f: typeof fetch = fetch): Promise<{ nuevas: number }> {
  if (!env.YCLOUD_API_KEY) return { nuevas: 0 };
  try {
    const r = await f("https://api.ycloud.com/v2/whatsapp/messages?limit=100&page=1", { headers: { "X-API-Key": env.YCLOUD_API_KEY } });
    if (!r.ok) return { nuevas: 0 };
    return { nuevas: await guardarCotizaciones(env, ((await r.json()) as { items?: MsgSaliente[] }).items ?? []) };
  } catch (e) {
    console.error("[cotizaciones]", e);
    return { nuevas: 0 };
  }
}
