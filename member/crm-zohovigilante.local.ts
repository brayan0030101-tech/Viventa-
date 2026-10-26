// member/crm-zohovigilante.local.ts — vigilante de Zoho (pedido de Maricela, 27 oct 2026).
// Una regla de Zoho («asignación por ausencia de gestión comercial en los últimos 60 días») reasignó a María Cendales dos candidatos que el sistema
// había creado por error (ya eran contactos). Este vigilante revisa cada hora los candidatos que el sistema creó (últimos 30 días) o a los que
// les dejó una nota (últimos 14 días): si el dueño ya no es Maricela, lo reporta en Auditoría (y le avisa a Camila) una sola vez por cambio.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { registrarHallazgo } from "../src/followup/auditor";
import { coql, duenoZoho, notasDe, urlFichaZoho, zohoListo, type FetchFn } from "./crm-zohoapi.local";

const DIA = 86_400_000;

export interface Reasignado {
  leadId: string;
  convId: string;
  cliente: string;
  duenoId: string;
  dueno: string;
  estado: string;
}

export async function leadsVigilados(db: Db, now: number): Promise<Array<{ leadId: string; convId: string; cliente: string; avisado: string }>> {
  const creadosDesde = new Date(now - 30 * DIA).toISOString();
  const notasDesde = new Date(now - 14 * DIA).toISOString().slice(0, 10);
  const filas = await db.all<{ id: string; z: string; nm: string | null; dn: string | null; av: string | null }>(
    `SELECT c.id, json_extract(c.metadata,'$.zoho_lead_id') AS z, json_extract(c.metadata,'$.zoho_dueno_avisado') AS av, c.display_name AS dn,
            (SELECT name FROM leads l WHERE l.conversation_id = c.id AND l.intent NOT LIKE 'Cita%' ORDER BY created_at ASC LIMIT 1) AS nm
       FROM conversations c
      WHERE json_extract(c.metadata,'$.zoho_lead_id') IS NOT NULL
        AND ((json_extract(c.metadata,'$.viventa_registrado_por') IN ('bot','CRM') AND json_extract(c.metadata,'$.viventa_registrado') >= ?)
          OR json_extract(c.metadata,'$.zoho_nota_seguimiento') >= ?)`,
    [creadosDesde, notasDesde],
  );
  const vistos = new Set<string>();
  const out: Array<{ leadId: string; convId: string; cliente: string; avisado: string }> = [];
  for (const r of filas) {
    if (!/^\d{6,30}$/.test(r.z) || vistos.has(r.z)) continue;
    vistos.add(r.z);
    out.push({ leadId: r.z, convId: r.id, cliente: r.nm || r.dn || "Cliente", avisado: r.av ?? "" });
  }
  return out;
}

/** Devuelve los candidatos vigilados cuyo dueño ya no es Maricela. */
export async function buscarReasignados(env: Env, now = Date.now(), f: FetchFn = fetch): Promise<Reasignado[]> {
  const db = new Db(env.DB);
  const yo = await duenoZoho(env, f, now);
  const lista = await leadsVigilados(db, now);
  const out: Reasignado[] = [];
  for (let i = 0; i < lista.length; i += 40) {
    const lote = lista.slice(i, i + 40);
    const filas = await coql(env, `select id, Owner, Lead_Status from Leads where id in (${lote.map((x) => `'${x.leadId}'`).join(",")})`, f, now).catch(() => []);
    for (const fila of filas) {
      const o = (fila["Owner"] ?? {}) as { id?: string; name?: string };
      if (!o.id || o.id === yo.id) continue;
      const v = lote.find((x) => x.leadId === String(fila["id"]));
      if (v) out.push({ leadId: v.leadId, convId: v.convId, cliente: v.cliente, duenoId: o.id, dueno: o.name ?? "otra persona", estado: String(fila["Lead_Status"] ?? "") });
    }
  }
  return out;
}

export async function runVigilanteZoho(env: Env, now = Date.now(), f: FetchFn = fetch): Promise<number> {
  if (!zohoListo(env)) return 0;
  const db = new Db(env.DB);
  const st = new SettingsRepo(db);
  const ult = Number((await st.get("zoho_vigilante_ult")) ?? 0);
  if (now - ult < 55 * 60_000) return 0;
  await st.set("zoho_vigilante_ult", String(now));
  let nuevos = 0;
  for (const r of await buscarReasignados(env, now, f)) {
    const yaAvisado = (await db.first<{ av: string | null }>("SELECT json_extract(metadata,'$.zoho_dueno_avisado') AS av FROM conversations WHERE id = ?", [r.convId]))?.av;
    if (yaAvisado === r.duenoId) continue;
    const ns = await notasDe(env, r.leadId, 3, f, now).catch(() => []);
    const regla = ns.find((n) => /asignaci[oó]n|reactivaci[oó]n|reasign/i.test(`${n.titulo} ${n.texto}`));
    const detalle = `${r.cliente}: en Zoho ahora es de ${r.dueno} (estado «${r.estado}»).${regla ? ` Nota de Zoho: ${regla.texto.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 150)}.` : ""} ${urlFichaZoho(env, r.leadId)}`;
    await registrarHallazgo(env, { tipo: "zoho_reasignado", convId: r.convId, clave: `${r.leadId}-${r.duenoId}`, detalle }, now);
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'),'$.zoho_dueno_avisado', ?) WHERE id = ?", [r.duenoId, r.convId]);
    nuevos++;
  }
  return nuevos;
}
