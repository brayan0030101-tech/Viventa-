// member/ycloud-diag.local.ts — utilidad TEMPORAL para gestionar las plantillas de WhatsApp en YCloud sin sacar la llave del Worker.
//  · ajuste `ycloud_diag_pedir` = «listar»  → guarda en `ycloud_diag_resultado` el WABA y las plantillas (nombre, idioma, categoría, estado).
//  · ajuste `ycloud_diag_pedir` = JSON {name, language, category, text} → crea esa plantilla (solo cuerpo) y deja la respuesta.
// No guarda datos personales. Quitar cuando ya no haga falta.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";

const BASE = "https://api.ycloud.com/v2";

async function ycloud(env: Env, ruta: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${ruta}`, { ...init, headers: { "Content-Type": "application/json", "X-API-Key": env.YCLOUD_API_KEY ?? "", ...(init.headers ?? {}) } });
  const texto = await res.text();
  let json: any = texto;
  try {
    json = JSON.parse(texto);
  } catch {
    /* texto plano */
  }
  return { status: res.status, json };
}

export async function runYcloudDiag(env: Env): Promise<void> {
  if (!env.YCLOUD_API_KEY) return;
  const st = new SettingsRepo(new Db(env.DB));
  const pedido = ((await st.get("ycloud_diag_pedir")) ?? "").trim();
  if (!pedido) return;
  await st.set("ycloud_diag_pedir", "");
  let out: unknown;
  try {
    const numeros = await ycloud(env, "/whatsapp/phoneNumbers?limit=20");
    const mio = (numeros.json?.items ?? []).find((n: any) => String(n.phoneNumber ?? "").replace(/\D/g, "") === (env.YCLOUD_WA_FROM ?? "").replace(/\D/g, ""));
    const wabaId = mio?.wabaId ?? numeros.json?.items?.[0]?.wabaId ?? "";
    if (pedido === "listar") {
      const t = await ycloud(env, `/whatsapp/templates?limit=100&filter.wabaId=${encodeURIComponent(wabaId)}`);
      out = {
        wabaId,
        numero: mio ? { estado: mio.status, calidad: mio.qualityRating, limite: mio.messagingLimit } : null,
        status: t.status,
        plantillas: (t.json?.items ?? []).map((x: any) => ({ name: x.name, language: x.language, category: x.category, status: x.status, reason: x.reason, cuerpo: String(x.components?.find((c: any) => c.type === "BODY")?.text ?? "").slice(0, 120) })),
        error: t.status >= 400 ? t.json : undefined,
      };
    } else if (pedido.startsWith("{")) {
      const p = JSON.parse(pedido) as { name: string; language: string; category: string; text: string };
      const r = await ycloud(env, "/whatsapp/templates", {
        method: "POST",
        body: JSON.stringify({ wabaId, name: p.name, language: p.language, category: p.category, components: [{ type: "BODY", text: p.text }] }),
      });
      out = { wabaId, status: r.status, respuesta: r.json };
    } else {
      out = { error: "pedido no reconocido" };
    }
  } catch (e) {
    out = { error: e instanceof Error ? e.message : String(e) };
  }
  await st.set("ycloud_diag_resultado", JSON.stringify(out).slice(0, 8000));
}
