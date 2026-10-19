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
  if (!/^\d{6,30}$/.test(pedido) && pedido !== "auto" && pedido !== "estados" && pedido !== "agenda" && pedido !== "futuro" && pedido !== "reactivacion") return;
  await st.set("zoho_diag_pedir", "");
  let out: unknown;
  if (pedido === "reactivacion") {
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
