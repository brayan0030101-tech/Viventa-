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

/**
 * Reinyección programada de un mensaje del cliente que se perdió (ajuste `reinyectar_pendiente` = JSON {conv, text, no_antes_de}):
 * a partir de `no_antes_de` entrega ese texto al bot como si el cliente lo hubiera escrito ahora, solo si la conversación no avanzó
 * (ningún mensaje del cliente ni de una persona después), su ventana de 24 h sigue abierta y nadie la tiene pausada.
 */
async function reinyectarPendiente(env: Env, st: SettingsRepo): Promise<void> {
  const raw = ((await st.get("reinyectar_pendiente")) ?? "").trim();
  if (!raw) return;
  const p = JSON.parse(raw) as { conv: string; text: string; no_antes_de: number; nombre?: string };
  if (Date.now() < p.no_antes_de) return;
  await st.set("reinyectar_pendiente", "");
  const db = new Db(env.DB);
  const conv = await db.first<{ channel: string; channel_user_id: string; paused_until: number | null }>("SELECT channel, channel_user_id, paused_until FROM conversations WHERE id = ?", [p.conv]);
  const ult = await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [p.conv]);
  const despues = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role IN ('owner') AND created_at > ?", [p.conv, ult?.t ?? 0]);
  let resultado = "omitido";
  if (!conv || !ult?.t || Date.now() - ult.t > 23 * 3_600_000) resultado = "omitido: ventana de 24 h cerrada";
  else if ((conv.paused_until ?? 0) > Date.now() || (despues?.n ?? 0) > 0) resultado = "omitido: ya la atiende una persona";
  else {
    const { agentStub } = await import("../src/agent-stub");
    await agentStub(env, conv.channel, conv.channel_user_id).ingest({
      channel: conv.channel,
      channelUserId: conv.channel_user_id,
      displayName: p.nombre,
      text: p.text,
    });
    resultado = "reinyectado";
  }
  await st.set("ycloud_diag_resultado", JSON.stringify({ reinyeccion: resultado, conv: p.conv }));
}

/**
 * Envío programado de plantillas aprobadas a clientes sin ventana de 24 h (ajuste `plantilla_pendiente` = JSON [{conv, template, params, no_antes_de}]).
 * Cada elemento se envía a partir de `no_antes_de` solo si la ventana sigue cerrada, no hay cita agendada, nadie de la persona del equipo escribió
 * después del último mensaje del cliente y la conversación no está pausada. Deja una nota en el hilo y el resultado en `ycloud_diag_resultado`.
 */
async function plantillasPendientes(env: Env, st: SettingsRepo): Promise<void> {
  const raw = ((await st.get("plantilla_pendiente")) ?? "").trim();
  if (!raw) return;
  const lista = JSON.parse(raw) as Array<{ conv: string; template: string; params: string[]; no_antes_de: number }>;
  const ahora = Date.now();
  const resto = lista.filter((x) => ahora < x.no_antes_de);
  const listos = lista.filter((x) => ahora >= x.no_antes_de);
  if (listos.length === 0) return;
  await st.set("plantilla_pendiente", resto.length ? JSON.stringify(resto) : "");
  const db = new Db(env.DB);
  const { sendYCloudTemplate } = await import("../src/channels/ycloud");
  const { MessagesRepo } = await import("../src/db/messages");
  const resultados: Record<string, string> = {};
  for (const x of listos) {
    const conv = await db.first<{ channel_user_id: string; paused_until: number | null }>("SELECT channel_user_id, paused_until FROM conversations WHERE id = ? AND channel = 'ycloud'", [x.conv]);
    const ult = await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [x.conv]);
    const equipo = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'owner' AND created_at > ?", [x.conv, ult?.t ?? 0]);
    const cita = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE conversation_id = ? AND intent LIKE 'Cita ·%'", [x.conv]);
    if (!conv) resultados[x.conv] = "omitido: no existe";
    else if (ult?.t && ahora - ult.t < 24 * 3_600_000) resultados[x.conv] = "omitido: ventana abierta (se puede escribir normal)";
    else if ((cita?.n ?? 0) > 0) resultados[x.conv] = "omitido: ya tiene cita";
    else if ((equipo?.n ?? 0) > 0 || (conv.paused_until ?? 0) > ahora) resultados[x.conv] = "omitido: ya la atiende una persona";
    else {
      try {
        await sendYCloudTemplate(env, conv.channel_user_id, x.template, "es_ES", x.params);
        await new MessagesRepo(db).append(x.conv, "note", `📤 Plantilla enviada (${x.template}): la ventana de 24 h estaba cerrada. Cuando responda, el bot sigue la conversación.`);
        await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_retomar', ?) WHERE id = ?", [`oferta-${new Date().toISOString()}`, x.conv]); // ya recibió la oferta: no entra al envío masivo de retomar
        resultados[x.conv] = "enviada";
      } catch (e) {
        resultados[x.conv] = `error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
      }
    }
  }
  await st.set("ycloud_diag_resultado", JSON.stringify({ plantillas: resultados }));
}

export async function runYcloudDiag(env: Env): Promise<void> {
  if (!env.YCLOUD_API_KEY) return;
  const st = new SettingsRepo(new Db(env.DB));
  await reinyectarPendiente(env, st).catch((e) => console.error("reinyectar:", e));
  await plantillasPendientes(env, st).catch((e) => console.error("plantillas pendientes:", e));
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
    } else if (pedido.startsWith("cal:slots:")) {
      const [dia, fin = dia] = pedido.slice(10).split("/");
      const r = await fetch(`https://api.cal.com/v2/slots?eventTypeId=${Number(env.CALCOM_EVENT_TYPE_ID || 0)}&start=${dia}&end=${fin}&timeZone=Europe%2FMadrid`, { headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": "2024-09-04" } });
      const j: any = await r.json().catch(() => ({}));
      out = { http: r.status, dia, fin, porDia: Object.fromEntries(Object.entries(j?.data ?? {}).map(([d, v]) => [d, (v as any[]).map((x: any) => String(x?.start ?? x).slice(11, 16))])) };
    } else if (pedido === "cal:leer" || pedido.startsWith("cal:ajustar:")) {
      // Duración del evento de Cal.com (pedido de Maricela 21 oct: 45 min con una hora entre inicios). «cal:ajustar:45:60» = duración:intervalo.
      const id = Number(env.CALCOM_EVENT_TYPE_ID || 0);
      const cab = { Authorization: `Bearer ${env.CALCOM_API_KEY}`, "cal-api-version": "2024-06-14", "Content-Type": "application/json" };
      const base = `https://api.cal.com/v2/event-types/${id}`;
      const campos = (j: any) => { const d = j?.data ?? j; return { id: d?.id, titulo: d?.title, duracion: d?.lengthInMinutes ?? d?.length, intervalo: d?.slotInterval, antes: d?.beforeEventBuffer, despues: d?.afterEventBuffer, minAviso: d?.minimumBookingNotice }; };
      let cambio: unknown;
      if (pedido.startsWith("cal:ajustar:")) {
        const [, , dur, inter] = pedido.split(":");
        const r = await fetch(base, { method: "PATCH", headers: cab, body: JSON.stringify({ lengthInMinutes: Number(dur), slotInterval: Number(inter) }) });
        cambio = { http: r.status, cuerpo: r.status >= 400 ? (await r.text()).slice(0, 400) : undefined };
      }
      const r = await fetch(base, { headers: cab });
      out = { id, cambio, ahora: campos(await r.json().catch(() => ({}))), http: r.status };
    } else if (pedido === "retomar_ig") {
      // Clientes de Instagram con la ventana de 24 h cerrada que dieron su teléfono: se les escribe por WhatsApp con la plantilla de «retomar».
      // Se copia el historial a la conversación de WhatsApp para que el bot siga donde se quedaron. Idempotente: marca `viventa_retomar_ig` en la de Instagram.
      const db = new Db(env.DB);
      const { normalizarTelefono } = await import("./crm.local");
      const { TPL_RETOMAR, TEXTO_RETOMAR } = await import("./crm-retomar.local");
      const { puedeEscribirAhora } = await import("../src/lib/horarioCliente");
      const { sendYCloudTemplate } = await import("../src/channels/ycloud");
      const { ConversationsRepo } = await import("../src/db/conversations");
      const { MessagesRepo } = await import("../src/db/messages");
      const ahora = Date.now();
      const ig = await db.all<{ id: string; display_name: string | null; paused_until: number | null }>("SELECT id, display_name, paused_until FROM conversations WHERE channel = 'zernio' AND last_message_at > ? AND json_extract(COALESCE(metadata, '{}'), '$.viventa_retomar_ig') IS NULL", [ahora - 30 * 86_400_000]);
      const res: Array<{ conv: string; resultado: string }> = [];
      for (const c of ig) {
        const ult = (await db.first<{ t: number | null }>("SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'", [c.id]))?.t ?? 0;
        if (ahora - ult < 23 * 3_600_000) continue; // ventana abierta: el bot puede escribirle por Instagram
        const cita = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE conversation_id = ? AND intent LIKE 'Cita ·%'", [c.id]))?.n ?? 0;
        const persona = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'owner'", [c.id]))?.n ?? 0;
        const contactos = (await db.all<{ contact: string | null }>("SELECT contact FROM leads WHERE conversation_id = ? AND contact IS NOT NULL", [c.id])).flatMap((l) => String(l.contact).split(/[;,]+/)).filter((x) => x.trim() && !x.includes("@"));
        const tel = contactos.map((x) => normalizarTelefono(x)).filter(Boolean).pop() ?? null;
        if (!contactos.length) continue;
        if (!tel) { res.push({ conv: c.id, resultado: `omitido: teléfono dudoso (${contactos.join(" / ")})` }); continue; }
        if (cita || persona || (c.paused_until ?? 0) > ahora) { res.push({ conv: c.id, resultado: "omitido: tiene cita, lo atendió una persona o está pausado" }); continue; }
        const dig = tel.replace(/\D/g, "");
        const yaExiste = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", [`ycloud:${dig}`]))?.n ?? 0;
        if (yaExiste) { res.push({ conv: c.id, resultado: "omitido: ya tiene conversación en WhatsApp" }); continue; }
        if (!(await puedeEscribirAhora(db, { id: `ycloud:${dig}`, channel: "ycloud", channel_user_id: dig }, ahora))) { res.push({ conv: c.id, resultado: "pendiente: fuera del horario del cliente" }); continue; }
        try {
          await sendYCloudTemplate(env, dig, TPL_RETOMAR, "es_ES", []);
        } catch (e) { res.push({ conv: c.id, resultado: `falló: ${String((e as Error).message).slice(0, 80)}` }); continue; }
        const nueva = await new ConversationsRepo(db).getOrCreate("ycloud", dig, c.display_name ?? undefined);
        const hist = await db.all<{ role: string; content: string; created_at: number }>("SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 60", [c.id]);
        const repo = new MessagesRepo(db);
        for (const m of hist.reverse()) await repo.append(nueva.id, m.role as "user" | "assistant", m.content, { createdAt: m.created_at });
        await repo.append(nueva.id, "assistant", TEXTO_RETOMAR, { createdAt: ahora });
        await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_retomar', ?) WHERE id = ?", [new Date(ahora).toISOString(), nueva.id]);
        await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata, '{}'), '$.viventa_retomar_ig', ?) WHERE id = ?", [`ycloud:${dig}`, c.id]);
        res.push({ conv: c.id, resultado: `enviado a +${dig}` });
      }
      out = { retomar_ig: res };
    } else if (pedido === "rescatar_botones") {
      // Respuestas a botones de plantilla («Sí, quiero continuar») que llegaron antes de que el bot supiera leerlas: se reinyectan una vez.
      const db = new Db(env.DB);
      const filas = await db.all<{ desde: string; ts: number; crudo: string }>("SELECT desde, ts, crudo FROM entrantes_log WHERE tipo = 'button' AND producidos = 0 AND crudo IS NOT NULL ORDER BY ts DESC");
      const vistos = new Set<string>();
      const res: Array<{ conv: string; resultado: string }> = [];
      for (const f of filas) {
        if (vistos.has(f.desde)) continue;
        vistos.add(f.desde);
        let m: any = {};
        try { m = JSON.parse(f.crudo)?.whatsappInboundMessage ?? {}; } catch { /* fila rota */ }
        const dig = String(f.desde ?? "").replace(/\D/g, "");
        const conv = await db.first<{ id: string; channel: string; channel_user_id: string; paused_until: number | null; display_name: string | null }>("SELECT id, channel, channel_user_id, paused_until, display_name FROM conversations WHERE channel = 'ycloud' AND channel_user_id = ?", [dig]);
        const texto = String(m.button?.text ?? m.button?.payload ?? "").trim();
        if (!conv || !texto) { res.push({ conv: dig, resultado: "omitido: sin conversación o sin texto" }); continue; }
        const despues = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role IN ('assistant','owner') AND created_at > ?", [conv.id, f.ts]);
        if ((despues?.n ?? 0) > 0) { res.push({ conv: conv.id, resultado: "omitido: ya se le contestó" }); continue; }
        if ((conv.paused_until ?? 0) > Date.now()) { res.push({ conv: conv.id, resultado: "omitido: pausada" }); continue; }
        const { agentStub } = await import("../src/agent-stub");
        await agentStub(env, conv.channel, conv.channel_user_id).ingest({ channel: conv.channel, channelUserId: conv.channel_user_id, displayName: conv.display_name ?? undefined, text: texto });
        res.push({ conv: conv.id, resultado: `reinyectado «${texto}»` });
      }
      out = { rescate: res };
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
    } else if (pedido === "equipo") {
      // Solo lectura: cuántos destinatarios de Telegram y si hay correo tiene configurado el aviso al equipo (sin mostrar ningún dato).
      const { teamTelegramIds } = await import("../src/lib/camila");
      out = { telegramEquipo: teamTelegramIds(env).length, correoEquipo: Boolean(env.CAMILA_EMAIL), resend: Boolean(env.RESEND_API_KEY), botTelegram: Boolean(env.TELEGRAM_BOT_TOKEN), telegramDueno: Boolean(env.OWNER_TELEGRAM_CHAT_ID) };
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
    } else if (pedido.startsWith("zernio_ver:")) {
      // Solo lectura: configuración completa de UNA automatización de comentarios (mensajes, palabras, respuesta pública).
      const base = (env.ZERNIO_API_BASE || "https://zernio.com/api/v1").replace(/\/$/, "");
      const r = await fetch(`${base}/comment-automations/${encodeURIComponent(pedido.slice(11).trim())}`, { headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY ?? ""}` } });
      out = { status: r.status, respuesta: (await r.text()).slice(0, 5000) };
    } else if (pedido.startsWith("zernio_editar:")) {
      // Cambia UNA automatización de comentarios: «zernio_editar:<id>:<json>» (PATCH con el JSON). Aprobado por el dueño.
      const base = (env.ZERNIO_API_BASE || "https://zernio.com/api/v1").replace(/\/$/, "");
      const resto = pedido.slice(14);
      const i = resto.indexOf(":");
      const id = resto.slice(0, i).trim();
      const r = await fetch(`${base}/comment-automations/${encodeURIComponent(id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY ?? ""}`, "Content-Type": "application/json" }, body: resto.slice(i + 1) });
      out = { status: r.status, respuesta: (await r.text()).slice(0, 3000) };
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
    } else if (pedido.startsWith("reintentar:")) {
      // «reintentar:<conv>»: el bot vuelve a contestar el último mensaje del cliente si quedó sin respuesta (mismo mecanismo de los reintentos de IA).
      const db = new Db(env.DB);
      const c = await db.first<{ id: string; channel: string; channel_user_id: string }>("SELECT id, channel, channel_user_id FROM conversations WHERE id = ?", [pedido.slice(10)]);
      if (!c) out = { error: "conversación no encontrada" };
      else {
        const { agentStub } = await import("../src/agent-stub");
        let error = "";
        try { await agentStub(env, c.channel as never, c.channel_user_id).retryFailedTurn({ id: c.id, channel: c.channel, channelUserId: c.channel_user_id }); } catch (e) { error = e instanceof Error ? e.message : String(e); }
        const ult = await db.all<{ role: string; c: string }>("SELECT role, substr(content,1,300) AS c FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 2", [c.id]);
        const fallos = await db.all<{ message: string }>("SELECT substr(message,1,300) AS message FROM ai_fallos WHERE conversation_id = ? ORDER BY at DESC LIMIT 2", [c.id]).catch(() => []);
        out = { error, ult, fallos };
      }
    } else if (pedido.startsWith("reanudar_y_escribir:")) {
      // «reanudar_y_escribir:<conv>|<texto>»: quita la pausa del bot y le escribe al cliente (dentro de la ventana de 24 h).
      const db = new Db(env.DB);
      const [conv, ...resto] = pedido.slice(20).split("|");
      const texto = resto.join("|").trim();
      const c = await db.first<{ id: string; channel: string; channel_user_id: string }>("SELECT id, channel, channel_user_id FROM conversations WHERE id = ?", [conv]);
      if (!c || !texto) out = { error: "conversación o texto no válidos" };
      else {
        const { ConversationsRepo } = await import("../src/db/conversations");
        await new ConversationsRepo(db).setPausedUntil(c.id, null);
        const { sendOutbound } = await import("../src/followup/send");
        await sendOutbound(env, { conversationId: c.id, channel: c.channel, channelUserId: c.channel_user_id, text: texto });
        out = { ok: true, conv: c.id };
      }
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
    } else if (pedido.startsWith("cotizaciones:")) {
      // Solo lectura en YCloud: recorre los mensajes SALIENTES desde la fecha dada y guarda en `cotizaciones_enviadas` los que llevan un enlace de cotización
      // (vivehome.viventa.co/quota-information?id=N): a quién, cuándo y qué cotización. Es la base de la sección «Cotizaciones» del CRM.
      const { guardarCotizaciones } = await import("../src/followup/cotizaciones");
      const desde = Date.parse(`${pedido.slice(13).trim()}T00:00:00Z`);
      let pagina = 1;
      let revisados = 0;
      let encontrados = 0;
      let fin = false;
      let masAntiguo = "";
      while (!fin && pagina <= 70) {
        const r = await ycloud(env, `/whatsapp/messages?limit=100&page=${pagina}`);
        const items: any[] = r.json?.items ?? [];
        if (r.status !== 200 || items.length === 0) break;
        const utiles = items.filter((x) => {
          revisados++;
          masAntiguo = x.createTime ?? masAntiguo;
          if (Date.parse(x.createTime ?? "") < desde) {
            fin = true;
            return false;
          }
          return true;
        });
        encontrados += await guardarCotizaciones(env, utiles);
        pagina++;
      }
      out = { revisados, encontrados, paginas: pagina - 1, masAntiguo, completo: fin };
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
    } else if (pedido.startsWith("entrantes:")) {
      // Solo lectura: mensajes ENTRANTES recientes de un número en YCloud (tipo, hora, botón pulsado); sin más texto que el título del botón.
      const num = pedido.slice(10).replace(/\D/g, "");
      const r = await ycloud(env, `/whatsapp/inbound-messages?limit=100&page=1`);
      out = {
        status: r.status,
        total: (r.json?.items ?? []).length,
        items: (r.json?.items ?? []).filter((x: any) => String(x.from ?? "").replace(/\D/g, "") === num).map((x: any) => ({ tipo: x.type, creado: x.createTime ?? x.sendTime, boton: x.interactive?.button_reply?.title ?? x.interactive?.list_reply?.title ?? x.button?.text, texto: x.text?.body ? String(x.text.body).slice(0, 40) : undefined, contexto: x.context ? "responde a un mensaje" : undefined })),
        error: r.status >= 400 ? r.json : undefined,
      };
    } else if (pedido.startsWith("{")) {
      const p = JSON.parse(pedido) as { name: string; language: string; category: string; text: string; buttons?: string[] };
      const r = await ycloud(env, "/whatsapp/templates", {
        method: "POST",
        body: JSON.stringify({ wabaId, name: p.name, language: p.language, category: p.category, components: [{ type: "BODY", text: p.text, ...(/\{\{\d+\}\}/.test(p.text) ? { example: { body_text: [["Ana", "10:30", "Lunes"].slice(0, new Set(p.text.match(/\{\{\d+\}\}/g)).size)] } } : {}) }, ...(p.buttons?.length ? [{ type: "BUTTONS", buttons: p.buttons.map((t) => ({ type: "QUICK_REPLY", text: t })) }] : [])] }),
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
