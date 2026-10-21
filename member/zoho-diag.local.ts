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
        const ids = (await db.all<{ id: string }>("SELECT id FROM conversations WHERE channel IN ('ycloud','zernio') AND last_message_at > ? ORDER BY last_message_at DESC LIMIT 400", [now - 20 * 86_400_000])).map((r) => r.id);
        const motivos: Record<string, number> = {};
        const elegibles: Array<{ conv: string; nombre: string; nivel: string }> = [];
        for (const id of ids) {
          const r = await armarPlan(env, id, fetch, now);
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
