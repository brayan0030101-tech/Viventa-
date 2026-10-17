// member/zoho-diag.local.ts — diagnóstico de SOLO LECTURA de Zoho (temporal): cuando el ajuste `zoho_diag_pedir` trae el id de un
// candidato (o «auto»), el cron lee sus transiciones de Blueprint y deja el resultado en `zoho_diag_resultado` (sin datos personales:
// solo nombres de transiciones, campos y listas). Sirve para conectar los cambios de estado de Zoho, que van por transiciones.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { candidatosPorIds, coql, duenoZoho, tareasPendientes, zohoGet, zohoListo } from "./crm-zohoapi.local";
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
  if (!/^\d{6,30}$/.test(pedido) && pedido !== "auto" && pedido !== "estados") return;
  await st.set("zoho_diag_pedir", "");
  let out: unknown;
  if (pedido === "estados") {
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
