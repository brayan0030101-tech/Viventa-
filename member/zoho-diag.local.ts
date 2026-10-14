// member/zoho-diag.local.ts — diagnóstico de SOLO LECTURA de Zoho (temporal): cuando el ajuste `zoho_diag_pedir` trae el id de un
// candidato, el cron lee sus transiciones de Blueprint y deja el resultado en `zoho_diag_resultado` (sin datos personales: solo
// nombres de transiciones, campos y listas). Sirve para conectar los cambios de estado de Zoho, que van por transiciones.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { zohoGet, zohoListo } from "./crm-zohoapi.local";

export async function runZohoDiag(env: Env, now = Date.now()): Promise<void> {
  if (!zohoListo(env)) return;
  const st = new SettingsRepo(new Db(env.DB));
  const leadId = ((await st.get("zoho_diag_pedir")) ?? "").trim();
  if (!/^\d{6,30}$/.test(leadId)) return;
  await st.set("zoho_diag_pedir", "");
  let out: unknown;
  try {
    out = await zohoGet(env, `/Leads/${leadId}/actions/blueprint`, fetch, now);
  } catch (e) {
    out = { error: e instanceof Error ? e.message : String(e) };
  }
  await st.set("zoho_diag_resultado", JSON.stringify(out).slice(0, 60000));
}
