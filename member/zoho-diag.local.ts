// member/zoho-diag.local.ts — diagnóstico de SOLO LECTURA de Zoho (temporal): cuando el ajuste `zoho_diag_pedir` trae el id de un
// candidato (o «auto»), el cron lee sus transiciones de Blueprint y deja el resultado en `zoho_diag_resultado` (sin datos personales:
// solo nombres de transiciones, campos y listas). Sirve para conectar los cambios de estado de Zoho, que van por transiciones.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { buscarCandidato, candidatosEnEstado, candidatosPorIds, coql, duenoZoho, tareasPendientes, zohoGet, zohoListo } from "./crm-zohoapi.local";
import { tareasDelDia } from "./crm-agenda.local";
import { hoyMadrid } from "./crm-seguimientos.local";

async function blueprintDe(env: Env, leadId: string, now: number): Promise<unknown> {
  try {
    return await zohoGet(env, `/Leads/${leadId}/actions/blueprint`, fetch, now);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runZohoDiag(env: Env, now = Date.now()): Promise<void> {
  if (!zohoListo(env)) return;
  const st = new SettingsRepo(new Db(env.DB));
  const pedido = ((await st.get("zoho_diag_pedir")) ?? "").trim();
  if (/^codigo:1000\.[0-9a-f]{20,}\.[0-9a-f]{20,}$/.test(pedido)) {
    // Cambia un código de autorización de Zoho (Self Client) por un refresh token NUEVO con los permisos pedidos. No se imprime el token.
    await st.set("zoho_diag_pedir", "");
    let res: Record<string, unknown>;
    try {
      const r = await fetch(`${(env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/+$/, "")}/oauth/v2/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: env.ZOHO_CLIENT_ID ?? "", client_secret: env.ZOHO_CLIENT_SECRET ?? "", code: pedido.slice(7) }),
      });
      const j = (await r.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; scope?: string; error?: string };
      if (r.ok && j.refresh_token) {
        await st.set("zoho_refresh_nuevo", j.refresh_token);
        await st.set("zoho_at_exp", "0");
        res = { ok: true, scope: j.scope ?? "(no informado)", conRefresh: true };
      } else {
        res = { ok: false, status: r.status, error: j.error ?? "sin detalle" };
      }
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    await st.set("zoho_diag_resultado", JSON.stringify(res));
    return;
  }
  if (pedido === "subir_nuevos") {
    // Sube a Zoho, en tandas de 8 por pasada, a todos los de la cola «Por subir» e «Incompletos» que tengan teléfono (no colombiano), en estado «Nuevo» y sin tarea.
    // Mientras queden, el pedido se mantiene y la siguiente pasada (5 min) sigue; el resultado va acumulando.
    const prev = ((await st.get("zoho_diag_resultado")) ?? "");
    let acumulado: { creados: string[]; yaExistian: string[]; noSubidos: string[] } = { creados: [], yaExistian: [], noSubidos: [] };
    try { const j = JSON.parse(prev) as { subir_nuevos?: typeof acumulado }; if (j.subir_nuevos?.creados) acumulado = j.subir_nuevos; } catch { /* primera tanda */ }
    const probados = new Set<string>(((await st.get("zoho_subir_nuevos_probados")) ?? "").split(",").filter(Boolean));
    let quedan = false;
    try {
      const { cargarZoho } = await import("./crm-zoho.local");
      const { subirCliente } = await import("./crm-zohosubida.local");
      const { esNumeroColombiano } = await import("../src/channels/ycloud");
      const cola = (await cargarZoho(env)).filter((f) => (f.estado === "pendiente" || f.estado === "incompleto") && f.lead.telefono.replace(/\D/g, "").length >= 9 && !esNumeroColombiano(f.lead.telefono.replace(/\D/g, "")) && !probados.has(f.lead.convId));
      let hechos = 0;
      for (const f of cola) {
        if (hechos >= 8) { quedan = true; break; }
        hechos++;
        probados.add(f.lead.convId);
        const r = await subirCliente(env, f.lead.convId, { manual: true, comoNuevo: true });
        if (r.estado === "creado") acumulado.creados.push(f.lead.nombre);
        else if (r.estado === "ya_existe") acumulado.yaExistian.push(f.lead.nombre);
        else acumulado.noSubidos.push(`${f.lead.nombre}: ${r.estado === "no_corresponde" ? r.motivo : r.motivo}`);
      }
    } catch (e) { acumulado.noSubidos.push(`ERROR ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)); }
    await st.set("zoho_subir_nuevos_probados", [...probados].join(","));
    await st.set("zoho_diag_resultado", JSON.stringify({ subir_nuevos: acumulado, terminado: !quedan }));
    if (!quedan) await st.set("zoho_diag_pedir", ""); // si quedan, se conserva el pedido y la próxima pasada continúa
    return;
  }
  if (pedido === "zoho_cola") {
    // Cuántos clientes hay por subir (pendientes e incompletos), con teléfono y con correo.
    await st.set("zoho_diag_pedir", "");
    let res: unknown;
    try {
      const { cargarZoho } = await import("./crm-zoho.local");
      const { esNumeroColombiano } = await import("../src/channels/ycloud");
      const filas = (await cargarZoho(env)).filter((f) => f.estado === "pendiente" || f.estado === "incompleto");
      const cuenta = (pred: (f: (typeof filas)[number]) => boolean) => filas.filter(pred).length;
      const tel = (f: (typeof filas)[number]) => f.lead.telefono.replace(/\D/g, "").length >= 9 && !esNumeroColombiano(f.lead.telefono.replace(/\D/g, ""));
      const mail = (f: (typeof filas)[number]) => /@/.test(f.lead.correo);
      const resumen = (lista: typeof filas) => ({ total: lista.length, conTelefono: lista.filter(tel).length, conTelefonoYCorreo: lista.filter((f) => tel(f) && mail(f)).length, sinTelefono: lista.filter((f) => !tel(f)).length });
      res = {
        pendientes: resumen(filas.filter((f) => f.estado === "pendiente")),
        incompletos: resumen(filas.filter((f) => f.estado === "incompleto")),
        todos: resumen(filas),
        conTelefonoPorNivel: { caliente: cuenta((f) => tel(f) && f.lead.prioridad.nivel === "caliente"), tibio: cuenta((f) => tel(f) && f.lead.prioridad.nivel === "tibio"), frio: cuenta((f) => tel(f) && f.lead.prioridad.nivel === "frio") },
      };
    } catch (e) { res = { error: e instanceof Error ? e.message : String(e) }; }
    await st.set("zoho_diag_resultado", JSON.stringify({ zoho_cola: res }));
    return;
  }
  if (pedido === "duenos_leads" || pedido === "duenos_creados") {
    // ¿Quién es hoy el dueño de los candidatos que subió/tocó el sistema? Detecta los que se reasignaron a otra persona.
    await st.set("zoho_diag_pedir", "");
    const out: unknown[] = [];
    try {
      const { coql, duenoZoho, notasDe } = await import("./crm-zohoapi.local");
      const yo = await duenoZoho(env);
      const db = new Db(env.DB);
      const ids = new Map<string, string>();
      for (const r of await db.all<{ z: string; nm: string | null; por: string | null }>("SELECT json_extract(c.metadata,'$.zoho_lead_id') AS z, (SELECT name FROM leads l WHERE l.conversation_id = c.id AND l.intent NOT LIKE 'Cita%' LIMIT 1) AS nm, json_extract(c.metadata,'$.viventa_registrado_por') AS por FROM conversations c WHERE json_extract(c.metadata,'$.zoho_lead_id') IS NOT NULL")) if (r.z) ids.set(r.z, `${r.nm ?? ""} (${r.por ?? "?"})`);
      if (pedido === "duenos_leads") for (const r of await db.all<{ lead_id: string }>("SELECT lead_id FROM crm_zoho_nuevo WHERE lead_id IS NOT NULL").catch(() => [])) if (!ids.has(r.lead_id)) ids.set(r.lead_id, "(nota y tarea)");
      if (pedido === "duenos_creados") for (const k of [...ids.keys()]) if (!/\((bot|CRM)\)$/.test(ids.get(k) ?? "")) ids.delete(k);
      const lista = [...ids.keys()].filter((x) => /^\d{6,30}$/.test(x));
      let otros = 0;
      for (let i = 0; i < lista.length; i += 40) {
        const lote = lista.slice(i, i + 40);
        const filas = await coql(env, `select id, Owner, Lead_Status, Created_Time, Modified_Time from Leads where id in (${lote.map((x) => `'${x}'`).join(",")})`).catch(() => []);
        for (const f of filas) {
          const o = (f["Owner"] ?? {}) as { id?: string; name?: string };
          if (o.id && o.id !== yo.id) {
            otros++;
            const ns = await notasDe(env, String(f["id"]), 3).catch(() => []);
            out.push({ lead: f["id"], cliente: ids.get(String(f["id"])), dueno: o.name, estado: f["Lead_Status"], creado: String(f["Created_Time"] ?? "").slice(0, 16), modificado: String(f["Modified_Time"] ?? "").slice(0, 16), notas: ns.map((n) => `${n.creada.slice(0, 16)} ${n.titulo}: ${n.texto.slice(0, 70)}`) });
          }
        }
      }
      out.push({ revisados: lista.length, deOtraPersona: otros });
    } catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
    await st.set("zoho_diag_resultado", JSON.stringify({ duenos: out }).slice(0, 12000));
    return;
  }
  if (pedido === "reasignados") {
    // Candidatos creados por el sistema cuyas notas muestran una asignación/reactivación hecha por Viventa Colombia (señal de que se reasignaron).
    await st.set("zoho_diag_pedir", "");
    const out: unknown[] = [];
    try {
      const { notasDe } = await import("./crm-zohoapi.local");
      const db = new Db(env.DB);
      const filas = await db.all<{ z: string; nm: string | null; por: string | null; t: string | null }>("SELECT DISTINCT json_extract(c.metadata,'$.zoho_lead_id') AS z, (SELECT name FROM leads l WHERE l.conversation_id = c.id AND l.intent NOT LIKE 'Cita%' LIMIT 1) AS nm, json_extract(c.metadata,'$.viventa_registrado_por') AS por, json_extract(c.metadata,'$.viventa_registrado') AS t FROM conversations c WHERE json_extract(c.metadata,'$.viventa_registrado_por') IN ('bot','CRM') AND json_extract(c.metadata,'$.zoho_lead_id') IS NOT NULL");
      const vistos = new Set<string>();
      for (const r of filas) {
        if (vistos.has(r.z)) continue;
        vistos.add(r.z);
        const ns = await notasDe(env, r.z, 20).catch(() => []);
        const raros = ns.filter((n) => /asignaci[oó]n|reactivaci[oó]n|reasign/i.test(`${n.titulo} ${n.texto}`));
        if (raros.length) out.push({ cliente: r.nm, lead: r.z, subido: String(r.t ?? "").slice(0, 16), notas: raros.map((n) => `${n.creada.slice(0, 16)} ${n.titulo}: ${n.texto.replace(/<[^>]+>/g, " ").slice(0, 160)}`) });
      }
      out.push({ revisados: vistos.size });
    } catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
    await st.set("zoho_diag_resultado", JSON.stringify({ reasignados: out }).slice(0, 12000));
    return;
  }
  if (pedido === "duplicados_contactos") {
    // De los candidatos que creó el sistema, ¿cuáles ya existían como CONTACTO en Zoho?
    await st.set("zoho_diag_pedir", "");
    const out: unknown[] = [];
    try {
      const { buscarContacto } = await import("./crm-zohoapi.local");
      const db = new Db(env.DB);
      const filas = await db.all<{ id: string; ch: string; z: string; nm: string | null; ct: string | null }>(
        "SELECT c.id, c.channel AS ch, json_extract(c.metadata,'$.zoho_lead_id') AS z, group_concat(DISTINCT l.name) AS nm, group_concat(DISTINCT l.contact) AS ct FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id AND l.intent NOT LIKE 'Cita%' WHERE json_extract(c.metadata,'$.viventa_registrado_por') = 'bot' AND json_extract(c.metadata,'$.zoho_lead_id') IS NOT NULL GROUP BY c.id",
      );
      const vistos = new Set<string>();
      for (const r of filas) {
        if (vistos.has(r.z)) continue;
        vistos.add(r.z);
        const correos = String(r.ct ?? "").match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g) ?? [];
        const tel = r.ch === "ycloud" ? r.id.slice(7) : (String(r.ct ?? "").match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? "");
        const c = await buscarContacto(env, { correos, telefono: tel }).catch(() => null);
        if (c) out.push({ cliente: r.nm, lead: r.z, contacto: c.id, nombreContacto: c.nombre, dueno: c.dueno });
      }
      out.push({ revisados: vistos.size });
    } catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
    await st.set("zoho_diag_resultado", JSON.stringify({ duplicados: out }));
    return;
  }
  if (pedido === "limpiar_bot") {
    // Quita la palabra «bot» de las notas y tareas que se subieron a Zoho antes de la regla (clientes subidos por el sistema o con «Nota y tarea»).
    await st.set("zoho_diag_pedir", "");
    const out: unknown[] = [];
    try {
      const { zohoGet, coql, sinBot, actualizarRegistro } = await import("./crm-zohoapi.local");
      const { ASUNTO_TAREA_BOT } = await import("./crm-zohosubida.local");
      const db = new Db(env.DB);
      const ids = new Set<string>();
      for (const r of await db.all<{ z: string | null }>("SELECT DISTINCT json_extract(metadata,'$.zoho_lead_id') AS z FROM conversations WHERE json_extract(metadata,'$.zoho_lead_id') IS NOT NULL")) if (r.z) ids.add(r.z);
      for (const r of await db.all<{ lead_id: string }>("SELECT lead_id FROM crm_zoho_nuevo WHERE lead_id IS NOT NULL").catch(() => [])) ids.add(r.lead_id);
      let notas = 0, tareas = 0, revisados = 0;
      const errores: string[] = [];
      for (const id of [...ids].filter((x) => /^\d{6,30}$/.test(x))) {
        revisados++;
        const j = (await zohoGet(env, `/Leads/${id}/Notes?fields=id,Note_Title,Note_Content&per_page=50`).catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
        for (const n of j?.data ?? []) {
          const c = String(n["Note_Content"] ?? ""), t = String(n["Note_Title"] ?? "");
          if (/\bbot\b/i.test(c) || /\bbot\b/i.test(t)) {
            try { await actualizarRegistro(env, `/Leads/${id}/Notes/${String(n["id"])}`, { Note_Content: sinBot(c), Note_Title: sinBot(t) }); notas++; }
            catch (e) { errores.push(`nota ${String(n["id"])}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); }
          }
        }
        const ts = await coql(env, `select id, Subject from Tasks where What_Id = '${id}' limit 50`).catch(() => []);
        for (const t of ts) {
          const sub = String(t["Subject"] ?? "");
          if (/\bbot\b/i.test(sub)) {
            try { await actualizarRegistro(env, `/Tasks/${String(t["id"])}`, { Subject: /cliente nuevo del bot/i.test(sub) ? ASUNTO_TAREA_BOT : sinBot(sub) }); tareas++; }
            catch (e) { errores.push(`tarea ${String(t["id"])}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); }
          }
        }
      }
      out.push({ revisados, notas, tareas, errores: errores.slice(0, 5), nErrores: errores.length });
    } catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
    await st.set("zoho_diag_resultado", JSON.stringify({ limpiar_bot: out }));
    return;
  }
  if (pedido.startsWith("notas:")) {
    // Últimas notas de cada candidato: «notas:<leadId>,<leadId>»
    await st.set("zoho_diag_pedir", "");
    const out: unknown[] = [];
    try {
      const { notasDe } = await import("./crm-zohoapi.local");
      for (const id of pedido.slice(6).split(",").map((x) => x.trim()).filter((x) => /^\d{6,30}$/.test(x)).slice(0, 10)) {
        out.push({ id, notas: (await notasDe(env, id, 4)).map((n) => JSON.stringify(n).slice(0, 220)) });
      }
    } catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
    await st.set("zoho_diag_resultado", JSON.stringify({ notas: out }));
    return;
  }
  if (pedido.startsWith("tareas_bot:")) {
    // Deja las tareas de los candidatos creados por el bot con el título fijo y fecha de hoy. «tareas_bot:[AAAA-MM-DD:]<conv>,<conv>»
    await st.set("zoho_diag_pedir", "");
    const out: unknown[] = [];
    try {
      const { coql, cambiarAsuntoYFechaTarea } = await import("./crm-zohoapi.local");
      const { ASUNTO_TAREA_BOT } = await import("./crm-zohosubida.local");
      const { hoyMadrid } = await import("./crm-seguimientos.local");
      const db = new Db(env.DB);
      const fechaPedida = /^tareas_bot:(\d{4}-\d{2}-\d{2}):/.exec(pedido)?.[1];
      for (const conv of pedido.replace(/^tareas_bot:(\d{4}-\d{2}-\d{2}:)?/, "").split(",").map((x) => x.trim()).filter(Boolean)) {
        const m = await db.first<{ z: string | null }>("SELECT json_extract(metadata,'$.zoho_lead_id') AS z FROM conversations WHERE id = ?", [conv]);
        const leadId = m?.z ?? "";
        if (!/^\d{6,30}$/.test(leadId)) { out.push({ conv, error: "sin zoho_lead_id" }); continue; }
        const filas = await coql(env, `select id, Subject, Due_Date from Tasks where (What_Id = '${leadId}' or Who_Id = '${leadId}') limit 20`);
        for (const t of filas) { await cambiarAsuntoYFechaTarea(env, String(t["id"]), ASUNTO_TAREA_BOT, fechaPedida ?? hoyMadrid(Date.now())); out.push({ conv, tarea: t["id"], antes: `${t["Subject"]} / ${t["Due_Date"]}` }); }
      }
    } catch (e) { out.push({ error: e instanceof Error ? e.message : String(e) }); }
    await st.set("zoho_diag_resultado", JSON.stringify({ tareas_bot: out }));
    return;
  }
  if (pedido === "subida_listar" || pedido.startsWith("subida_ver:")) {
    // Solo lectura: qué clientes se subirían a Zoho (y por qué no los demás), o lo que se mandaría para UN cliente. No escribe nada.
    await st.set("zoho_diag_pedir", "");
    try {
      const { armarPlan } = await import("./crm-zohosubida.local");
      if (pedido.startsWith("subida_ver:")) {
        const r = await armarPlan(env, pedido.slice(11), fetch, now);
        await st.set("zoho_diag_resultado", JSON.stringify({ subida_ver: r.plan ? { nombre: r.plan.nombre, nivel: r.plan.nivel, datos: { ...r.plan.datos, Email: r.plan.correo ? "(tiene correo)" : undefined, Mobile: r.plan.telefono ? "(tiene teléfono)" : undefined }, tarea: r.plan.tarea, nota: r.plan.nota } : { no: r.motivoNo } }));
      } else {
        const db = new Db(env.DB);
        const ids = (await db.all<{ id: string }>("SELECT id FROM conversations WHERE channel IN ('ycloud','zernio') AND last_message_at > ? ORDER BY last_message_at DESC LIMIT 120", [now - 20 * 86_400_000])).map((r) => r.id);
        const motivos: Record<string, number> = {};
        const elegibles: Array<{ conv: string; nombre: string; nivel: string }> = [];
        for (const id of ids) {
          const r = await armarPlan(env, id, fetch, now).catch((e) => ({ plan: undefined, motivoNo: `error: ${e instanceof Error ? e.message.slice(0, 40) : "?"}` }));
          if (r.plan) elegibles.push({ conv: id, nombre: r.plan.nombre, nivel: r.plan.nivel });
          else { const k = (r.motivoNo ?? "").replace(/\(.*\)/, "").trim(); motivos[k] = (motivos[k] ?? 0) + 1; }
        }
        await st.set("zoho_diag_resultado", JSON.stringify({ revisadas: ids.length, elegibles: elegibles.length, lista: elegibles.slice(0, 15), porQueNo: motivos }));
      }
    } catch (e) {
      await st.set("zoho_diag_resultado", JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
    return;
  }
  if (pedido === "pruebas_bot") {
    // Corre las conversaciones de prueba del bot (≈ 0,40 USD) y deja un resumen. Lo mismo que el botón de CRM → «Probar el bot».
    await st.set("zoho_diag_pedir", "");
    try {
      const { correrPruebas } = await import("./crm-pruebas.local");
      const id = await correrPruebas(env, now);
      const fila = await new Db(env.DB).first<{ resultados: string }>("SELECT resultados FROM pruebas_bot WHERE id = ?", [id]);
      const res = JSON.parse(fila?.resultados ?? "[]") as Array<{ id: string; ok: boolean; respuesta: string; checks: Array<{ que: string; ok: boolean }>; error?: string }>;
      await st.set("zoho_diag_resultado", JSON.stringify({ pruebas_bot: { bien: res.filter((r) => r.ok).length, total: res.length, fallos: res.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error, respuesta: r.respuesta.slice(0, 260), mal: r.checks.filter((c) => !c.ok).map((c) => c.que) })) } }));
    } catch (e) {
      await st.set("zoho_diag_resultado", JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
    return;
  }
  if (pedido === "seg_prueba") {
    // Solo lectura: carga la lista de seguimientos como la ve Maricela y resume el orden (calientes y en cierre primero) y las fechas.
    await st.set("zoho_diag_pedir", "");
    try {
      const { cargarSeguimientos } = await import("./crm-seguimientos.local");
      const r = await cargarSeguimientos(env, now);
      const por = { enCierre: 0, calientes: 0, otros: 0 };
      for (const x of r.filas) { if (x.enCierre) por.enCierre++; else if (x.nivel === "caliente") por.calientes++; else por.otros++; }
      let orden = true; let visto = 0;
      for (const x of r.filas) { const p = x.enCierre ? 0 : x.nivel === "caliente" ? 1 : 2; if (p < visto) orden = false; visto = Math.max(visto, p); }
      await st.set("zoho_diag_resultado", JSON.stringify({ seg_prueba: { tareas: r.filas.length, vencidas: r.filas.filter((x) => x.atraso > 0).length, ...por, ordenCorrecto: orden, primeras: r.filas.slice(0, 8).map((x) => ({ nivel: x.nivel ?? "sin dato", enCierre: !!x.enCierre, atraso: x.atraso, estado: x.cand.estado })) } }));
    } catch (e) {
      await st.set("zoho_diag_resultado", JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
    return;
  }
  if (pedido.startsWith("transiciones:")) {
    await st.set("zoho_diag_pedir", "");
    const id = pedido.slice(13).trim();
    try {
      const j = (await zohoGet(env, `/Leads/${id}/actions/blueprint`, fetch, now)) as { blueprint?: { process_info?: Record<string, unknown>; transitions?: Array<Record<string, any>> } };
      await st.set("zoho_diag_resultado", JSON.stringify({ proceso: j.blueprint?.process_info, transiciones: (j.blueprint?.transitions ?? []).map((t) => ({ id: t.id, nombre: t.name, siguiente: t.next_field_value, campos: (t.fields ?? []).map((c: any) => ({ api: c.api_name, tipo: c.data_type, obligatorio: !!c.mandatory, valores: Array.isArray(c.pick_list_values) ? c.pick_list_values.map((v: any) => v.display_value).slice(0, 12) : undefined })) })) }));
    } catch (e) {
      await st.set("zoho_diag_resultado", JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
    return;
  }
  if (pedido.startsWith("prospectar:")) {
    // Pasa a «En Prospección» a los candidatos que el bot creó y quedaron en «Nuevo» (ids separados por coma). Después lee su estado.
    await st.set("zoho_diag_pedir", "");
    const { pasarAProspeccion } = await import("./crm-zohosubida.local");
    const res: Array<{ id: string; como?: string; error?: string; estado?: string }> = [];
    for (const id of pedido.slice(11).split(",").map((x) => x.trim()).filter((x) => /^\d{6,30}$/.test(x)).slice(0, 5)) {
      try {
        const como = await pasarAProspeccion(env, id, fetch, now);
        const j = (await zohoGet(env, `/Leads/${id}?fields=Lead_Status`, fetch, now)) as { data?: Array<{ Lead_Status?: string }> };
        res.push({ id, como, estado: j.data?.[0]?.Lead_Status });
      } catch (e) {
        res.push({ id, error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
      }
    }
    await st.set("zoho_diag_resultado", JSON.stringify({ prospectar: res }));
    return;
  }
  if (pedido === "campos_leads") {
    // Solo lectura: campos del módulo de Candidatos (nombre de API, tipo, obligatorio, opciones) y qué campos trae un candidato reciente (solo los nombres y valores de listas).
    await st.set("zoho_diag_pedir", "");
    try {
      const j = (await zohoGet(env, "/settings/fields?module=Leads", fetch, now)) as { fields?: Array<Record<string, any>> };
      const campos = (j.fields ?? []).filter((x) => x.visible !== false).map((x) => ({ api: x.api_name, etiqueta: x.field_label, tipo: x.data_type, obligatorio: !!x.system_mandatory, opciones: Array.isArray(x.pick_list_values) ? x.pick_list_values.slice(0, 30).map((o: any) => o.display_value) : undefined }));
      const { duenoZoho } = await import("./crm-zohoapi.local");
      const dueno = await duenoZoho(env, fetch, now);
      const rec = (await coql(env, `select id, Lead_Status, Lead_Source, Created_Time from Leads where Owner = '${dueno.id}' order by Created_Time desc limit 3`, fetch, now)) as Array<Record<string, any>>;
      const detalle: Array<{ creado: unknown; estado: unknown; fuente: unknown; camposConValor: string[] }> = [];
      for (const r of rec) {
        const full = (await zohoGet(env, `/Leads/${r.id}`, fetch, now)) as { data?: Array<Record<string, any>> };
        const d = full.data?.[0] ?? {};
        detalle.push({ creado: r.Created_Time, estado: r.Lead_Status, fuente: r.Lead_Source, camposConValor: Object.entries(d).filter(([, v]) => v !== null && v !== "" && v !== false).map(([k, v]) => (typeof v === "string" && v.length <= 24 && !/@|\d{6}/.test(v) ? `${k}=${v}` : k)) });
      }
      await st.set("zoho_diag_resultado", JSON.stringify({ dueno: dueno.nombre, campos: campos.filter((c) => c.obligatorio || /status|source|city|country|ciudad|pais|mobile|phone|email|name|desc|interes|origen|canal/i.test(`${c.api} ${c.etiqueta}`)), recientes: detalle }));
    } catch (e) {
      await st.set("zoho_diag_resultado", JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
    return;
  }
  if (pedido === "permiso_crear") {
    // Sin crear nada: manda un registro VACÍO a Leads. Si el permiso existe, Zoho contesta «campo obligatorio»; si no, «sin permiso de escritura».
    await st.set("zoho_diag_pedir", "");
    try {
      const { tokenZoho } = await import("./crm-zohoapi.local");
      const tk = await tokenZoho(env, now);
      const base = (env.ZOHO_API_URL || "https://www.zohoapis.com").replace(/\/+$/, "");
      const r = await fetch(`${base}/crm/v2/Leads`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${tk}`, "Content-Type": "application/json" }, body: JSON.stringify({ data: [{}] }) });
      const j = (await r.json().catch(() => ({}))) as { data?: Array<{ code?: string; message?: string; details?: unknown }>; code?: string; message?: string };
      await st.set("zoho_diag_resultado", JSON.stringify({ permiso_crear: { http: r.status, codigo: j.data?.[0]?.code ?? j.code, mensaje: j.data?.[0]?.message ?? j.message, detalle: j.data?.[0]?.details } }));
    } catch (e) {
      await st.set("zoho_diag_resultado", JSON.stringify({ permiso_crear: { error: e instanceof Error ? e.message.slice(0, 120) : String(e) } }));
    }
    return;
  }
  if (pedido.startsWith("buscar:")) {
    // Solo lectura: busca palabras en las notas de Zoho (ej. «impuestos») y dice a qué candidato pertenecen. Para ubicar un cliente que Maricela no encuentra.
    await st.set("zoho_diag_pedir", "");
    const palabras = pedido.slice(7).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6);
    const hallados = new Map<string, { parent: string; creada: string; trozo: string; palabra: string }>();
    const errores: string[] = [];
    for (const palabra of palabras) {
      for (let pagina = 1; pagina <= 3; pagina++) {
        try {
          const r = (await zohoGet(env, `/Notes/search?word=${encodeURIComponent(palabra)}&fields=Note_Content,Note_Title,Parent_Id,Created_Time&per_page=200&page=${pagina}`, fetch, now)) as { data?: Array<Record<string, any>>; info?: { more_records?: boolean } } | null;
          for (const n of r?.data ?? []) {
            const txt = String(n["Note_Content"] ?? "").replace(/\s+/g, " ");
            const i = Math.max(0, txt.toLowerCase().indexOf(palabra.toLowerCase()));
            hallados.set(`${n["Parent_Id"]?.id}|${n["Created_Time"]}`, { parent: String(n["Parent_Id"]?.id ?? ""), creada: String(n["Created_Time"] ?? ""), trozo: txt.slice(Math.max(0, i - 140), i + 220), palabra });
          }
          if (!r?.info?.more_records) break;
        } catch (e) {
          errores.push(`${palabra}:${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
          break;
        }
      }
    }
    const padres = [...new Set([...hallados.values()].map((h) => h.parent).filter(Boolean))];
    const cands = padres.length ? await candidatosPorIds(env, padres.slice(0, 100), fetch, now) : new Map();
    await st.set("zoho_diag_resultado", JSON.stringify({
      buscado: palabras,
      encontrados: [...hallados.values()].sort((a, b) => b.creada.localeCompare(a.creada)).slice(0, 25).map((h) => ({ cliente: cands.get(h.parent)?.nombre ?? "(no es candidato)", movil: cands.get(h.parent)?.movil || cands.get(h.parent)?.telefono || "", estado: cands.get(h.parent)?.estado ?? "", creada: h.creada.slice(0, 16), palabra: h.palabra, trozo: h.trozo })),
      errores: errores.slice(0, 3),
    }));
    return;
  }
  if (!/^\d{6,30}$/.test(pedido) && pedido !== "auto" && pedido !== "estados" && pedido !== "agenda" && pedido !== "futuro" && pedido !== "reactivacion" && pedido !== "modulos" && pedido !== "deals" && pedido !== "oportunidades" && pedido !== "tareas" && pedido !== "madrid" && pedido !== "cotizaciones") return;
  await st.set("zoho_diag_pedir", "");
  let out: unknown;
  if (pedido === "oportunidades") {
    // Prueba en vivo (solo lectura, sin datos personales) del tablero y de las tareas de oportunidades.
    try {
      const { cargarOportunidades, tareasDeOportunidades, columnasEtapas } = await import("./crm-oportunidades.local");
      const { ops, contactos } = await cargarOportunidades(env, now);
      const tareas = await tareasDeOportunidades(env, now);
      out = {
        ops: ops.length,
        sv: ops.filter((o) => o.rama === "SV").length,
        vc: ops.filter((o) => o.rama === "VC").length,
        contactos,
        conNombreDeContacto: ops.filter((o) => o.contacto).length,
        conTelefono: ops.filter((o) => o.telefono).length,
        conTareas: ops.filter((o) => o.tareas.length).length,
        tareasPendientesTotal: ops.reduce((n, o) => n + o.tareas.length, 0),
        tareasVencidasOHoy: tareas.length,
        columnas: columnasEtapas(ops),
      };
    } catch (e) {
      out = { error: e instanceof Error ? e.message : String(e) };
    }
  } else if (pedido === "deals") {
    // Solo lectura, sin datos personales: etapas por rama y qué campos trae un Deal vía COQL.
    try {
      const dueno = await duenoZoho(env, fetch, now);
      const filas: Array<Record<string, unknown>> = [];
      for (let off = 0; off < 1000; off += 200) {
        const r = await coql(env, `select id, Deal_Name, Stage, Type, Pipeline, Created_Time, Modified_Time, Last_Activity_Time, Contact_Name, Link_Oportunidad_SV, Link_Oportunidad_Vivecasa from Deals where Owner = '${dueno.id}' limit ${off}, 200`, fetch, now);
        filas.push(...r);
        if (r.length < 200) break;
      }
      const porRama: Record<string, Record<string, number>> = {};
      for (const f of filas) {
        const rama = String(f["Pipeline"] ?? "") === "Standard (Vivecasa)" ? "VC" : "SV";
        const e = String(f["Stage"] ?? "(vacío)");
        (porRama[rama] ??= {})[e] = ((porRama[rama] ??= {})[e] ?? 0) + 1;
      }
      const ej = filas[0] ?? {};
      out = { total: filas.length, porRama, formaContacto: typeof ej["Contact_Name"] === "object" ? Object.keys(ej["Contact_Name"] as object) : typeof ej["Contact_Name"], conContacto: filas.filter((f) => f["Contact_Name"]).length, conLinkSV: filas.filter((f) => f["Link_Oportunidad_SV"]).length, conLinkVC: filas.filter((f) => f["Link_Oportunidad_Vivecasa"]).length, masReciente: filas.map((f) => String(f["Modified_Time"] ?? "")).sort().pop() };
    } catch (e) {
      out = { error: e instanceof Error ? e.message : String(e) };
    }
  } else if (pedido === "modulos") {
    // Solo lectura, sin datos personales: módulos, etapas, ramas SV/VC y a qué módulo pertenecen las tareas pendientes de Maricela.
    const paso = async <T,>(f: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await f();
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    const dueno = await duenoZoho(env, fetch, now);
    const mods = await paso(async () => {
      const j = (await zohoGet(env, "/settings/modules", fetch, now)) as { modules?: Array<{ api_name?: string; plural_label?: string; generated_type?: string; visible?: boolean }> };
      return (j.modules ?? []).filter((m) => m.visible !== false && m.generated_type !== "subform").map((m) => `${m.api_name}|${m.plural_label}|${m.generated_type}`);
    });
    const camposDe = async (modulo: string) =>
      paso(async () => {
        const j = (await zohoGet(env, `/settings/fields?module=${modulo}`, fetch, now)) as { fields?: Array<{ api_name?: string; field_label?: string; data_type?: string; pick_list_values?: Array<{ display_value?: string }> }> };
        return (j.fields ?? [])
          .filter((x) => /stage|etapa|pipeline|servicio|vive|sv|vc|tipo|estado|status|lead_source|origen|viabilidad/i.test(`${x.api_name} ${x.field_label}`))
          .map((x) => `${x.api_name}|${x.field_label}|${x.data_type}${x.pick_list_values?.length ? `|${x.pick_list_values.slice(0, 14).map((v) => v.display_value).join("/")}` : ""}`);
      });
    const cuenta = async (modulo: string, campo: string) =>
      paso(async () => {
        const t = new Map<string, number>();
        for (let off = 0; off < 2000; off += 200) {
          const filas = await coql(env, `select ${campo} from ${modulo} where Owner = '${dueno.id}' limit ${off}, 200`, fetch, now);
          for (const r of filas) t.set(String(r[campo] ?? "(vacío)"), (t.get(String(r[campo] ?? "(vacío)")) ?? 0) + 1);
          if (filas.length < 200) break;
        }
        return Object.fromEntries(t);
      });
    const tareasPorModulo = await paso(async () => {
      const t = new Map<string, number>();
      for (let off = 0; off < 2000; off += 200) {
        const filas = await coql(env, `select $se_module from Tasks where (Owner = '${dueno.id}' and Status not in ('Completa','Completed')) limit ${off}, 200`, fetch, now);
        for (const r of filas) t.set(String(r["$se_module"] ?? "(sin)"), (t.get(String(r["$se_module"] ?? "(sin)")) ?? 0) + 1);
        if (filas.length < 200) break;
      }
      return Object.fromEntries(t);
    });
    void mods; void camposDe;
    out = {
      etapasOportunidades: await cuenta("Deals", "Stage"),
      tipoOportunidades: await cuenta("Deals", "Type"),
      pipelineOportunidades: await cuenta("Deals", "Pipeline"),
      tareasPendientesPorModulo: tareasPorModulo,
      contactosTotal: await paso(async () => {
        let n = 0;
        for (let off = 0; off < 5000; off += 200) {
          const filas = await coql(env, `select id from Contacts where Owner = '${dueno.id}' limit ${off}, 200`, fetch, now);
          n += filas.length;
          if (filas.length < 200) break;
        }
        return n;
      }),
      camposVC: await paso(async () => {
        const j = (await zohoGet(env, "/settings/fields?module=Deals", fetch, now)) as { fields?: Array<{ api_name?: string; field_label?: string; data_type?: string }> };
        return (j.fields ?? []).filter((x) => /vive|casa|vc|sv|servicio/i.test(`${x.api_name} ${x.field_label}`)).map((x) => `${x.api_name}|${x.field_label}|${x.data_type}`);
      }),
      camposContactoRamas: await paso(async () => {
        const j = (await zohoGet(env, "/settings/fields?module=Contacts", fetch, now)) as { fields?: Array<{ api_name?: string; field_label?: string; data_type?: string }> };
        return (j.fields ?? []).filter((x) => /vivecasa|vivecasam|vc\b|servicio_viventa|^sv|asesor|reasign/i.test(`${x.api_name} ${x.field_label}`)).map((x) => `${x.api_name}|${x.field_label}|${x.data_type}`);
      }),
    };
  } else if (pedido === "reactivacion") {
    // Prueba en vivo (solo lectura, sin datos personales) de la lista de reactivación.
    try {
      const { cargarReactivacion } = await import("./crm-reactivacion.local");
      const { telefonoInternacional } = await import("./crm-reactivacion.local");
      const filas = await cargarReactivacion(env, now);
      const cuenta: Record<string, number> = {};
      for (const f of filas) cuenta[f.fase] = (cuenta[f.fase] ?? 0) + 1;
      out = {
        total: filas.length,
        porFase: cuenta,
        conTelefonoUtil: filas.filter((f) => telefonoInternacional(f.cand.movil, f.cand.telefono, f.cand.pais)).length,
        diasMinMax: filas.length ? [filas[filas.length - 1]!.dias, filas[0]!.dias] : null,
        ejemploTarea: filas[0] ? { dias: filas[0].dias, vence: filas[0].vence, estado: filas[0].cand.estado } : null,
      };
    } catch (e) {
      out = { error: e instanceof Error ? e.message : String(e) };
    }
  } else if (pedido === "futuro") {
    // Solo lectura, sin datos personales: campos de fecha del candidato y, para algunos «Revisar en el futuro», cuándo se movieron y qué tareas tienen.
    const paso = async <T,>(f: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await f();
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    const dueno = await duenoZoho(env, fetch, now);
    const campos = await paso(async () => {
      const j = (await zohoGet(env, "/settings/fields?module=Leads", fetch, now)) as { fields?: Array<{ api_name?: string; field_label?: string; data_type?: string }> };
      return (j.fields ?? []).filter((x) => /date|fecha|time|futuro|revis|motivo|pr[oó]xim|asesor|owner/i.test(`${x.api_name} ${x.field_label}`)).map((x) => `${x.api_name}|${x.field_label}|${x.data_type}`);
    });
    const filas = await paso(() => coql(env, `select id, Created_Time, Modified_Time, Last_Activity_Time, Fecha_cambio_de_estado, Fecha_de_Reactivacion, Fecha_Asignado, Fecha_reasignaci_n, Fecha_contacto_1, Fecha_contacto_2 from Leads where (Owner = '${dueno.id}' and Lead_Status = 'Revisar en el futuro') order by Fecha_cambio_de_estado asc limit 12`, fetch, now));
    const muestra = Array.isArray(filas) ? filas : [];
    const detalle: unknown[] = [];
    for (const r of muestra.slice(0, 10)) {
      const id = String(r["id"]);
      detalle.push({
        creado: r["Created_Time"],
        modificado: r["Modified_Time"],
        cambioEstado: r["Fecha_cambio_de_estado"],
        reactivacion: r["Fecha_de_Reactivacion"],
        asignado: r["Fecha_Asignado"],
        reasignacion: r["Fecha_reasignaci_n"],
        contacto1: r["Fecha_contacto_1"],
        contacto2: r["Fecha_contacto_2"],
        tareas: await paso(async () => (await coql(env, `select Subject, Due_Date, Status, Created_Time from Tasks where What_Id = '${id}' order by Created_Time desc limit 5`, fetch, now)).map((t) => `${t["Created_Time"]} | vence ${t["Due_Date"]} | ${t["Status"]} | ${String(t["Subject"] ?? "").slice(0, 50)}`)),
        notas: await paso(async () => ((await zohoGet(env, `/Leads/${id}/Notes?fields=Created_Time,Note_Title&per_page=5`, fetch, now)) as { data?: Array<Record<string, unknown>> }).data?.map((n) => `${n["Created_Time"]} | ${String(n["Note_Title"] ?? "").slice(0, 40)}`)),
      });
    }
    out = { total: Array.isArray(filas) ? filas.length : filas, detalle: detalle.map((d) => ({ ...(d as object), tareas: undefined, notas: undefined })) };
  } else if (pedido === "madrid") {
    // Solo lectura en Zoho: candidatos cuya ciudad o provincia es Madrid o su comunidad; se guardan en la tabla temporal `tmp_madrid_zoho` (borrar al terminar).
    const { coql, duenoZoho } = await import("./crm-zohoapi.local");
    const dueno = await duenoZoho(env, fetch, now);
    const db = new Db(env.DB);
    await db.run("DROP TABLE IF EXISTS tmp_madrid_zoho");
    await db.run("CREATE TABLE IF NOT EXISTS tmp_madrid_zoho (id TEXT PRIMARY KEY, nombre TEXT, movil TEXT, telefono TEXT, correo TEXT, ciudad TEXT, provincia TEXT, estado TEXT, creado TEXT, propietario TEXT)");
    const TERMINOS = ["Madrid", "Leganés", "Móstoles", "Getafe", "Alcalá de Henares", "Fuenlabrada", "Alcorcón", "Parla", "Torrejón", "Pozuelo", "Majadahonda", "Las Rozas", "Rivas", "Coslada", "Alcobendas", "Aranjuez", "Valdemoro", "Pinto", "San Sebastián de los Reyes", "Boadilla"];
    const errores: string[] = [];
    for (const campo of ["City", "State"]) {
      for (const t of TERMINOS) {
        try {
          for (let off = 0; off < 600; off += 200) {
            const filas = await coql(env, `select id, First_Name, Last_Name, Mobile, Phone, Email, City, State, Lead_Status, Created_Time from Leads where (Owner = '${dueno.id}' and ${campo} like '%${t.replace(/'/g, "")}%') limit ${off}, 200`, fetch, now);
            for (const x of filas as Array<Record<string, unknown>>) {
              const nombre = [x["First_Name"], x["Last_Name"]].filter(Boolean).join(" ") || "Sin nombre";
              await db.run("INSERT OR REPLACE INTO tmp_madrid_zoho (id, nombre, movil, telefono, correo, ciudad, provincia, estado, creado, propietario) VALUES (?,?,?,?,?,?,?,?,?,?)", [String(x["id"]), nombre, String(x["Mobile"] ?? ""), String(x["Phone"] ?? ""), String(x["Email"] ?? ""), String(x["City"] ?? ""), String(x["State"] ?? ""), String(x["Lead_Status"] ?? ""), String(x["Created_Time"] ?? ""), ""]);
            }
            if (filas.length < 200) break;
          }
        } catch (e) {
          errores.push(`${campo}:${t}:${e instanceof Error ? e.message.slice(0, 70) : String(e)}`);
        }
      }
    }
    out = { errores: errores.slice(0, 4), filasUnicas: (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM tmp_madrid_zoho"))?.n };
  } else if (pedido === "cotizaciones") {
    // Solo lectura, agregados sin datos personales: notas de Zoho que hablan de cotizaciones y enlaces de la página de cotizaciones.
    const { zohoGet, candidatosPorIds } = await import("./crm-zohoapi.local");
    const notas: Array<{ parent: string; texto: string; creada: string }> = [];
    const errores: string[] = [];
    for (const palabra of ["quota-information", "cotizacion", "cotización", "cotizaciones"]) {
      for (let pagina = 1; pagina <= 3; pagina++) {
        try {
          const r = (await zohoGet(env, `/Notes/search?word=${encodeURIComponent(palabra)}&fields=Note_Content,Parent_Id,Created_Time&per_page=200&page=${pagina}`, fetch, now)) as { data?: Array<Record<string, any>>; info?: { more_records?: boolean } } | null;
          for (const n of r?.data ?? []) notas.push({ parent: String(n["Parent_Id"]?.id ?? ""), texto: String(n["Note_Content"] ?? ""), creada: String(n["Created_Time"] ?? "") });
          if (!r?.info?.more_records) break;
        } catch (e) {
          errores.push(`${palabra}:${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
          break;
        }
      }
    }
    const unicas = new Map(notas.map((n) => [n.parent + n.creada, n]));
    const conEnlace = [...unicas.values()].filter((n) => /quota-information/i.test(n.texto));
    const ids = conEnlace.flatMap((n) => [...n.texto.matchAll(/quota-information\?id=(\d+)/gi)].map((m) => m[1]));
    const padres = [...new Set([...unicas.values()].map((n) => n.parent).filter(Boolean))];
    const cands = padres.length ? await candidatosPorIds(env, padres.slice(0, 200), fetch, now) : new Map();
    const porEstado: Record<string, number> = {};
    for (const p of padres) porEstado[cands.get(p)?.estado ?? "(no es candidato)"] = (porEstado[cands.get(p)?.estado ?? "(no es candidato)"] ?? 0) + 1;
    out = {
      notas: unicas.size,
      conEnlaceDeCotizacion: conEnlace.length,
      idsDeEjemplo: [...new Set(ids)].slice(0, 12),
      candidatosDistintos: padres.length,
      porEstado,
      ejemplosDeTexto: [...unicas.values()].slice(0, 4).map((n) => n.texto.replace(/\s+/g, " ").slice(0, 110)),
      errores: errores.slice(0, 3),
    };
  } else if (pedido === "tareas") {
    // Solo lectura, agregados sin datos personales: cuántas tareas vencidas o de hoy hay, de qué tipo, de qué estado y cuán atrasadas.
    const { tareasPendientes, candidatosPorIds } = await import("./crm-zohoapi.local");
    const hoy = hoyMadrid(now);
    const ts = await tareasPendientes(env, hoy, fetch, now, 600);
    const cands = await candidatosPorIds(env, [...new Set(ts.map((t) => t.leadId))], fetch, now);
    const cuenta = (xs: string[]) => Object.entries(xs.reduce((m: Record<string, number>, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 14);
    const dias = (v: string) => Math.max(0, Math.round((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${v}T00:00:00Z`)) / 86_400_000));
    const porLead = cuenta(ts.map((t) => t.leadId));
    out = {
      hoy,
      total: ts.length,
      deHoy: ts.filter((t) => t.vence === hoy).length,
      atraso: { "1-3 días": ts.filter((t) => dias(t.vence) >= 1 && dias(t.vence) <= 3).length, "4-7 días": ts.filter((t) => dias(t.vence) >= 4 && dias(t.vence) <= 7).length, "8-14 días": ts.filter((t) => dias(t.vence) >= 8 && dias(t.vence) <= 14).length, "más de 14": ts.filter((t) => dias(t.vence) > 14).length },
      porAsunto: cuenta(ts.map((t) => t.asunto.toLowerCase().replace(/[^a-záéíóúñ ]/g, "").trim().slice(0, 40))),
      porEstado: cuenta(ts.map((t) => cands.get(t.leadId)?.estado ?? "(sin candidato)")),
      candidatosDistintos: porLead.length ? new Set(ts.map((t) => t.leadId)).size : 0,
      conVariasTareas: porLead.filter(([, n]) => n > 1).length,
    };
  } else if (pedido === "agenda") {
    // Prueba en vivo (solo lectura, sin datos personales) de las consultas de prospección, carga por día y búsqueda por teléfono/correo.
    const paso = async <T,>(f: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await f();
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    const dueno = await duenoZoho(env, fetch, now);
    const hoy = hoyMadrid(now);
    const campos = ["id", "First_Name", "Last_Name", "Mobile", "Phone", "Email", "Lead_Status", "Created_Time"];
    const porCampo: Record<string, unknown> = {};
    for (const c of campos) porCampo[c] = await paso(async () => (await coql(env, `select ${c} from Leads where Owner = '${dueno.id}' limit 1`, fetch, now)).length);
    const lista = await paso(() => candidatosEnEstado(env, "En Prospección", fetch, now));
    const ok = Array.isArray(lista) ? lista : [];
    const prueba = ok.find((c) => (c.movil || c.telefono).replace(/\D/g, "").length >= 8 && c.correo);
    out = {
      campos: porCampo,
      prospeccion: Array.isArray(lista) ? lista.length : lista,
      masAntiguo: ok[0]?.creado,
      masReciente: ok[ok.length - 1]?.creado,
      tareasHoy: await paso(() => tareasDelDia(env, hoy, fetch, now)),
      formaTelefono: prueba ? (prueba.movil || prueba.telefono).replace(/\d/g, "d") : null,
      consultaLike: prueba
        ? await paso(async () => {
            const dig = (prueba.movil || prueba.telefono).replace(/\D/g, "");
            const filas = await coql(env, `select id, Mobile, Phone from Leads where (Mobile like '%${dig.slice(-3)}' or Phone like '%${dig.slice(-3)}') limit 200`, fetch, now);
            return { filas: filas.length, coincide: filas.filter((r) => [r["Mobile"], r["Phone"]].some((t) => String(t ?? "").replace(/\D/g, "").endsWith(dig.slice(-9)))).length };
          })
        : null,
      buscarPorTelefonoEncuentra: prueba ? (await paso(() => buscarCandidato(env, { correos: [], telefono: prueba.movil || prueba.telefono }, fetch, now)) as { id?: string } | null)?.id === prueba.id : null,
      buscarPorCorreoEncuentra: prueba ? (await paso(() => buscarCandidato(env, { correos: [prueba.correo], telefono: "" }, fetch, now)) as { id?: string } | null)?.id === prueba.id : null,
    };
  } else if (pedido === "estados") {
    // Cuántos candidatos hay por estado y el más antiguo de cada uno (sin datos personales).
    try {
      const dueno = await duenoZoho(env, fetch, now);
      const tally = new Map<string, { n: number; masAntiguo: string; masReciente: string }>();
      for (let off = 0; off < 2000; off += 200) {
        const filas = await coql(env, `select Lead_Status, Created_Time from Leads where Owner = '${dueno.id}' order by Created_Time asc limit ${off}, 200`, fetch, now);
        for (const r of filas) {
          const k = String(r["Lead_Status"] ?? "(vacío)");
          const t = String(r["Created_Time"] ?? "");
          const e = tally.get(k) ?? { n: 0, masAntiguo: t, masReciente: t };
          e.n++;
          if (t && (!e.masAntiguo || t < e.masAntiguo)) e.masAntiguo = t;
          if (t && t > e.masReciente) e.masReciente = t;
          tally.set(k, e);
        }
        if (filas.length < 200) break;
      }
      out = Object.fromEntries(tally);
    } catch (e) {
      out = { error: e instanceof Error ? e.message : String(e) };
    }
  } else if (pedido === "auto") {
    // Un candidato por cada estado distinto entre los que tienen tarea pendiente (máx. 4).
    const arr: Array<{ estado: string; blueprint: unknown }> = [];
    try {
      const tareas = await tareasPendientes(env, hoyMadrid(now), fetch, now);
      const cands = await candidatosPorIds(env, tareas.map((t) => t.leadId), fetch, now);
      const vistos = new Set<string>();
      for (const c of cands.values()) {
        if (vistos.has(c.estado) || arr.length >= 4) continue;
        vistos.add(c.estado);
        arr.push({ estado: c.estado, blueprint: await blueprintDe(env, c.id, now) });
      }
    } catch (e) {
      arr.push({ estado: "error", blueprint: { error: e instanceof Error ? e.message : String(e) } });
    }
    out = arr;
  } else {
    out = await blueprintDe(env, pedido, now);
  }
  await st.set("zoho_diag_resultado", JSON.stringify(out).slice(0, 60000));
}
