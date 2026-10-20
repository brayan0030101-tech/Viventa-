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
    } else if (pedido.startsWith("msgs:")) {
      // Mensajes recientes de YCloud hacia un número (solo metadatos: tipo, estado, hora, campos extra; nunca el texto).
      const num = pedido.slice(5).replace(/\D/g, "");
      const r = await ycloud(env, `/whatsapp/messages?limit=15&page=1&filter.to=%2B${num}`);
      out = {
        status: r.status,
        claves: Object.keys(r.json?.items?.[0] ?? {}),
        items: (r.json?.items ?? []).map((x: any) => ({ tipo: x.type, estado: x.status, creado: x.createTime, enviado: x.sendTime, entregado: x.deliverTime, leido: x.readTime, origen: x.bizType ?? x.source ?? x.channel, conTexto: typeof x.text === "string" ? x.text.length : x.text?.body ? String(x.text.body).length : 0, error: x.errorCode ?? x.whatsappApiError?.code })),
        error: r.status >= 400 ? r.json : undefined,
      };
    } else if (pedido.startsWith("reenviar:")) {
      // Reenvía la última respuesta del bot (ya guardada en el hilo) a clientes cuyo envío falló por saldo de YCloud agotado.
      const { pickAdapter } = await import("../src/replies/sender");
      const { MessagesRepo } = await import("../src/db/messages");
      const db = new Db(env.DB);
      const hechos: Record<string, string> = {};
      for (const id of pedido.slice(9).split(",").map((x) => x.trim()).filter(Boolean)) {
        const conv = await db.first<{ channel: string; channel_user_id: string }>("SELECT channel, channel_user_id FROM conversations WHERE id = ?", [id]);
        const ult = await db.first<{ role: string; content: string }>("SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant','owner') ORDER BY created_at DESC LIMIT 1", [id]);
        if (!conv || !ult || ult.role !== "assistant") {
          hechos[id] = "omitido: la última palabra no es del bot";
          continue;
        }
        try {
          await pickAdapter(conv.channel as never).sendReply({ channel: conv.channel as never, channelUserId: conv.channel_user_id, chunks: [ult.content], interChunkDelayMs: 0 }, env, { strict: true });
          await new MessagesRepo(db).append(id, "note", "✔ Reenviado: el mensaje anterior no había llegado por saldo agotado en YCloud; ya se mandó.");
          hechos[id] = "reenviado";
        } catch (e) {
          hechos[id] = `error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
        }
      }
      out = { reenvio: hechos };
    } else if (pedido.startsWith("recordar:")) {
      // Recordatorio del guion (mismo texto que el automático) a clientes cuyo envío falló por saldo agotado y cuya ventana de 24 h sigue abierta.
      const { enviarACliente } = await import("../src/followup/sistemaViventa");
      const db = new Db(env.DB);
      const hechos: Record<string, string> = {};
      for (const par of pedido.slice(9).split(",").map((x) => x.trim()).filter(Boolean)) {
        const [id, nombre = ""] = par.split("|");
        const conv = await db.first<{ id: string; channel: string; channel_user_id: string; display_name: string | null }>("SELECT id, channel, channel_user_id, display_name FROM conversations WHERE id = ?", [id]);
        const ult = await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [id]);
        if (!conv || !ult?.t || Date.now() - ult.t > 23.5 * 3600_000) {
          hechos[id] = "omitido: sin ventana de 24 h";
          continue;
        }
        try {
          const texto = `Hola${nombre ? ` ${nombre}` : ""} 😊 ¿Seguimos con las preguntas? Me faltan pocas para que el equipo comercial de Maricela pueda orientarte mejor.`;
          await enviarACliente(env, db, conv, texto, null, ult.t, Date.now());
          hechos[id] = "enviado";
        } catch (e) {
          hechos[id] = `error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
        }
      }
      out = { recordatorios: hechos };
    } else if (pedido === "zernio") {
      // Solo lectura: cuentas conectadas y automatizaciones de comentarios existentes en Zernio.
      const base = (env.ZERNIO_API_BASE || "https://zernio.com/api/v1").replace(/\/$/, "");
      const get = async (ruta: string) => {
        const r = await fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY ?? ""}` } });
        const t = await r.text();
        let j: any = t.slice(0, 300);
        try {
          j = JSON.parse(t);
        } catch {
          /* texto */
        }
        return { status: r.status, j };
      };
      const cuentas = await get("/accounts");
      const autos = await get("/comment-automations");
      const lista = (x: any): any[] => x?.accounts ?? x?.items ?? x?.automations ?? x?.data ?? (Array.isArray(x) ? x : []);
      out = {
        cuentas: { status: cuentas.status, items: lista(cuentas.j).map((a: any) => ({ id: a._id ?? a.id, plataforma: a.platform, usuario: a.username ?? a.displayName, perfil: a.profileId?._id ?? a.profileId })), crudo: cuentas.status >= 400 ? cuentas.j : undefined },
        automatizaciones: { status: autos.status, items: lista(autos.j).map((a: any) => ({ id: a._id ?? a.id, nombre: a.name, activa: a.isActive, palabras: a.keywords, stats: a.stats })), crudo: autos.status >= 400 ? autos.j : undefined },
      };
    } else if (pedido.startsWith("zernio_crear:")) {
      // Crea UNA automatización de comentarios en Zernio con el cuerpo JSON recibido (aprobado por el dueño).
      const base = (env.ZERNIO_API_BASE || "https://zernio.com/api/v1").replace(/\/$/, "");
      const r = await fetch(`${base}/comment-automations`, { method: "POST", headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY ?? ""}`, "Content-Type": "application/json" }, body: pedido.slice(13) });
      const t = await r.text();
      out = { status: r.status, respuesta: t.slice(0, 2500) };
    } else if (pedido === "comentarios") {
      // Solo lectura: comentarios de Instagram de los últimos 7 días, clasificados con el mismo filtro de la automatización.
      const base = (env.ZERNIO_API_BASE || "https://zernio.com/api/v1").replace(/\/$/, "");
      const acc = "6ac47c954467c71397881810";
      const get = async (ruta: string) => {
        const r = await fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY ?? ""}` } });
        const t = await r.text();
        try {
          return { status: r.status, j: JSON.parse(t) as any };
        } catch {
          return { status: r.status, j: { raw: t.slice(0, 200) } as any };
        }
      };
      const INTERES = ["info", "información", "informacion", "precio", "cuánto", "cuanto", "costo", "valor", "quiero", "interesa", "interesad", "invertir", "inversión", "inversion", "comprar", "compra", "apartamento", "apto", "proyecto", "vivienda", "cuota", "financi", "crédito", "credito", "ahorro", "detalles", "dm", "privado", "me interesa"];
      const EXCLUIR = ["estafa", "estafador", "fraude", "ladrón", "ladron", "mentira", "basura", "mierda", "puta", "puto", "gonorrea", "malparido", "hijueputa", "idiota", "imbecil", "imbécil", "estupid", "estúpid", "pendejo", "robo", "engaño", "engano", "spam"];
      const posts = await get(`/inbox/comments?platform=instagram&accountId=${acc}&limit=50&sortBy=date`);
      const lista: any[] = posts.j?.data ?? [];
      const ahora = Date.now();
      const filas: any[] = [];
      const clases = { interes: 0, excluido: 0, sin_interes: 0, propios: 0, fuera_7d: 0, con_respuesta: 0 };
      let leidos = 0;
      for (const p of lista.filter((x) => (x.commentCount ?? 0) > 0).slice(0, 40)) {
        const c = await get(`/inbox/comments/${encodeURIComponent(p.id)}?accountId=${acc}&limit=100`);
        for (const m of c.j?.comments ?? []) {
          leidos++;
          if (m.from?.isOwner) {
            clases.propios++;
            continue;
          }
          const dias = (ahora - Date.parse(m.createdTime ?? "")) / 86_400_000;
          if (dias > 6.8) {
            clases.fuera_7d++;
            continue;
          }
          const txt = String(m.message ?? "").toLowerCase();
          const cls = EXCLUIR.some((k) => txt.includes(k)) ? "excluido" : INTERES.some((k) => txt.includes(k)) ? "interes" : "sin_interes";
          clases[cls as "interes" | "excluido" | "sin_interes"]++;
          if ((m.replyCount ?? 0) > 0) clases.con_respuesta++;
          filas.push({ p: p.id, c: m.id, d: Math.round(dias * 10) / 10, u: m.from?.username, r: m.replyCount ?? 0, k: cls, m: String(m.message ?? "").replace(/\s+/g, " ").slice(0, 70) });
        }
      }
      out = { postsStatus: posts.status, posts: lista.length, conComentarios: lista.filter((x) => (x.commentCount ?? 0) > 0).length, leidos, clases, filas: filas.slice(0, 45), error: posts.status >= 400 ? posts.j : undefined };
    } else if (pedido.startsWith("responder:")) {
      // Responde comentarios pendientes de Instagram (mensaje privado y/o respuesta pública) con los textos aprobados por el dueño.
      const base = (env.ZERNIO_API_BASE || "https://zernio.com/api/v1").replace(/\/$/, "");
      const acc = "6ac47c954467c71397881810";
      const lista = JSON.parse(pedido.slice(10)) as Array<{ p: string; c: string; dm: string; pub?: string }>;
      const hechos: Record<string, unknown> = {};
      for (const x of lista) {
        const h: Record<string, unknown> = {};
        const post = async (ruta: string, cuerpo: unknown) => {
          const r = await fetch(`${base}${ruta}`, { method: "POST", headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY ?? ""}`, "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
          return `${r.status}${r.ok ? "" : " " + (await r.text()).slice(0, 160)}`;
        };
        h.privado = await post(`/inbox/comments/${encodeURIComponent(x.p)}/${encodeURIComponent(x.c)}/private-reply`, { accountId: acc, message: x.dm });
        if (x.pub && String(h.privado).startsWith("200")) h.publico = await post(`/inbox/comments/${encodeURIComponent(x.p)}`, { accountId: acc, commentId: x.c, message: x.pub });
        hechos[x.c] = h;
        await new Promise((r) => setTimeout(r, 4000));
      }
      out = { respondidos: hechos };
    } else if (pedido.startsWith("fallidos:")) {
      // Solo lectura en YCloud: recorre los mensajes enviados desde la fecha dada y guarda los fallidos en la tabla `ycloud_fallidos_listado` (sin tocar nada más).
      const desde = Date.parse(`${pedido.slice(9).trim()}T00:00:00Z`);
      const db = new Db(env.DB);
      await db.run("CREATE TABLE IF NOT EXISTS ycloud_fallidos_listado (id TEXT PRIMARY KEY, destino TEXT, creado TEXT, codigo TEXT, error TEXT, texto TEXT)");
      let pagina = 1;
      let revisados = 0;
      let fallidos = 0;
      let fin = false;
      let masAntiguo = "";
      while (!fin && pagina <= 45) {
        const r = await ycloud(env, `/whatsapp/messages?limit=100&page=${pagina}`);
        const items: any[] = r.json?.items ?? [];
        if (r.status !== 200 || items.length === 0) break;
        for (const x of items) {
          revisados++;
          masAntiguo = x.createTime ?? masAntiguo;
          if (Date.parse(x.createTime ?? "") < desde) {
            fin = true;
            continue;
          }
          if (x.status === "failed") {
            fallidos++;
            const texto = typeof x.text === "string" ? x.text : (x.text?.body ?? x.template?.name ?? x.type ?? "");
            await db.run("INSERT OR REPLACE INTO ycloud_fallidos_listado (id, destino, creado, codigo, error, texto) VALUES (?,?,?,?,?,?)", [x.id, String(x.to ?? "").replace(/\D/g, ""), x.createTime, String(x.errorCode ?? ""), String(x.errorMessage ?? "").slice(0, 120), String(texto).slice(0, 4000)]);
          }
        }
        pagina++;
      }
      out = { revisados, fallidos, paginas: pagina - 1, masAntiguo, completo: fin };
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
