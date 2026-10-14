// member/crm-zohoapi.local.ts — conexión de solo lectura (por ahora) con el Zoho CRM de Maricela.
// Usa el «Self Client» de api-console.zoho.com (secretos ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET /
// ZOHO_REFRESH_TOKEN). El token de acceso dura 1 h y se guarda en `settings` para no pedir uno nuevo
// en cada visita (Zoho limita cuántos se pueden pedir). Solo hay CANDIDATOS (módulo Leads): los
// clientes que ya reservaron están en Oportunidades y no se tocan.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";

const K_TOKEN = "zoho_at";
const K_EXP = "zoho_at_exp";
const K_OWNER = "zoho_owner_id";
const K_OWNER_NOMBRE = "zoho_owner_nombre";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function zohoListo(env: Env): boolean {
  return !!(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN);
}
const cuentas = (env: Env): string => (env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/+$/, "");
const api = (env: Env): string => (env.ZOHO_API_URL || "https://www.zohoapis.com").replace(/\/+$/, "");

export class ZohoError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/** Token de acceso vigente (lo reutiliza hasta 2 min antes de vencer). */
export async function tokenZoho(env: Env, now = Date.now(), f: FetchFn = fetch): Promise<string> {
  if (!zohoListo(env)) throw new ZohoError("Zoho no está conectado todavía.");
  const st = new SettingsRepo(new Db(env.DB));
  const exp = Number((await st.get(K_EXP)) ?? 0);
  const guardado = await st.get(K_TOKEN);
  if (guardado && exp - 120_000 > now) return guardado;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID!,
    client_secret: env.ZOHO_CLIENT_SECRET!,
    refresh_token: env.ZOHO_REFRESH_TOKEN!,
  });
  const r = await f(`${cuentas(env)}/oauth/v2/token`, { method: "POST", body });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!r.ok || !j.access_token) throw new ZohoError(`Zoho no dio acceso (${j.error ?? r.status}).`, r.status);
  await st.set(K_TOKEN, j.access_token);
  await st.set(K_EXP, String(now + (j.expires_in ?? 3600) * 1000));
  return j.access_token;
}

async function llamar(env: Env, ruta: string, init: RequestInit = {}, f: FetchFn = fetch, now = Date.now()): Promise<unknown> {
  for (let intento = 0; intento < 2; intento++) {
    const token = await tokenZoho(env, now, f);
    const r = await f(`${api(env)}/crm/v6${ruta}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } });
    if (r.status === 401 && intento === 0) {
      // Token vencido o revocado: se descarta el guardado y se pide uno nuevo una vez.
      const st = new SettingsRepo(new Db(env.DB));
      await st.set(K_EXP, "0");
      continue;
    }
    if (r.status === 204) return {};
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (j["code"] === "OAUTH_SCOPE_MISMATCH") throw new ZohoError(`A la conexión con Zoho le falta un permiso para ${ruta.split("?")[0]}: hay que generar un código nuevo con más permisos.`, r.status);
    if (!r.ok) {
      const d0 = (j["data"] as Array<Record<string, unknown>> | undefined)?.[0];
      throw new ZohoError(`Zoho respondió ${r.status}: ${String(d0?.["message"] ?? j["message"] ?? j["code"] ?? "error")}`, r.status);
    }
    return j;
  }
  throw new ZohoError("Zoho no aceptó el acceso.", 401);
}

export async function coql(env: Env, consulta: string, f: FetchFn = fetch, now = Date.now()): Promise<Array<Record<string, unknown>>> {
  const j = (await llamar(env, "/coql", { method: "POST", body: JSON.stringify({ select_query: consulta }) }, f, now)) as { data?: Array<Record<string, unknown>> };
  return j.data ?? [];
}

// ─── Dueña de las tareas ─────────────────────────────────────────────────────

/** Usuario de Zoho que autorizó la conexión (Maricela). Se puede fijar a mano con el ajuste `zoho_owner_id`. */
export async function duenoZoho(env: Env, f: FetchFn = fetch, now = Date.now()): Promise<{ id: string; nombre: string }> {
  const st = new SettingsRepo(new Db(env.DB));
  const id = await st.get(K_OWNER);
  if (id) return { id, nombre: (await st.get(K_OWNER_NOMBRE)) ?? "" };
  const j = (await llamar(env, "/users?type=CurrentUser", {}, f, now)) as { users?: Array<{ id?: string; full_name?: string }> };
  const u = j.users?.[0];
  if (!u?.id) throw new ZohoError("No pude saber quién es el usuario de Zoho.");
  await st.set(K_OWNER, u.id);
  await st.set(K_OWNER_NOMBRE, u.full_name ?? "");
  return { id: u.id, nombre: u.full_name ?? "" };
}

// ─── Tareas pendientes de Maricela ───────────────────────────────────────────

export interface TareaZoho {
  id: string;
  asunto: string;
  vence: string; // YYYY-MM-DD
  estado: string;
  leadId: string;
  descripcion: string;
}

/** «Completa» (y su versión en inglés) es la única tarea hecha; todo lo demás está pendiente. */
export const ESTADOS_HECHOS = ["Completa", "Completed"];

const refId = (v: unknown): string => (v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id ?? "") : "");

/** Tareas de Maricela con fecha de hoy o anterior que no están completas, ligadas a un candidato. */
export async function tareasPendientes(env: Env, hoy: string, f: FetchFn = fetch, now = Date.now(), tope = 400): Promise<TareaZoho[]> {
  const dueno = await duenoZoho(env, f, now);
  const out: TareaZoho[] = [];
  for (let off = 0; off < tope; off += 200) {
    const filas = await coql(
      env,
      `select id, Subject, Due_Date, Status, Who_Id, What_Id, $se_module, Description from Tasks where (Owner = '${dueno.id}' and Due_Date <= '${hoy}') and (Status not in ('Completa','Completed')) order by Due_Date asc limit ${off}, 200`,
      f,
      now,
    );
    for (const r of filas) {
      const modulo = String(r["$se_module"] ?? "");
      // Una tarea de un candidato lleva al candidato en Who_Id (o en What_Id con módulo Leads).
      const leadId = modulo === "Leads" ? refId(r["What_Id"]) || refId(r["Who_Id"]) : refId(r["Who_Id"]);
      if (!leadId) continue;
      out.push({ id: String(r["id"]), asunto: String(r["Subject"] ?? ""), vence: String(r["Due_Date"] ?? ""), estado: String(r["Status"] ?? ""), leadId, descripcion: String(r["Description"] ?? "") });
    }
    if (filas.length < 200) break;
  }
  return out;
}

export async function tareaPorId(env: Env, id: string, f: FetchFn = fetch, now = Date.now()): Promise<TareaZoho | null> {
  if (!/^\d{6,30}$/.test(id)) return null;
  const filas = await coql(env, `select id, Subject, Due_Date, Status, Who_Id, What_Id, $se_module, Description from Tasks where id = '${id}'`, f, now);
  const r = filas[0];
  if (!r) return null;
  const modulo = String(r["$se_module"] ?? "");
  const leadId = modulo === "Leads" ? refId(r["What_Id"]) || refId(r["Who_Id"]) : refId(r["Who_Id"]);
  return { id: String(r["id"]), asunto: String(r["Subject"] ?? ""), vence: String(r["Due_Date"] ?? ""), estado: String(r["Status"] ?? ""), leadId, descripcion: String(r["Description"] ?? "") };
}

// ─── Candidatos y notas ──────────────────────────────────────────────────────

export interface CandidatoZoho {
  id: string;
  nombre: string;
  movil: string;
  telefono: string;
  correo: string;
  pais: string;
  estado: string;
}

const candidatoDe = (r: Record<string, unknown>): CandidatoZoho => ({
  id: String(r["id"] ?? ""),
  nombre: String(r["Full_Name"] ?? ([r["First_Name"], r["Last_Name"]].filter(Boolean).join(" ") || "Sin nombre")),
  movil: String(r["Mobile"] ?? ""),
  telefono: String(r["Phone"] ?? ""),
  correo: String(r["Email"] ?? ""),
  pais: String(r["Country"] ?? ""),
  estado: String(r["Lead_Status"] ?? ""),
});

/** Candidatos por id (Zoho deja pedir hasta 100 a la vez). Los que no existan en el módulo Leads no aparecen. */
export async function candidatosPorIds(env: Env, ids: string[], f: FetchFn = fetch, now = Date.now()): Promise<Map<string, CandidatoZoho>> {
  const mapa = new Map<string, CandidatoZoho>();
  const unicos = [...new Set(ids.filter((i) => /^\d{6,30}$/.test(i)))];
  for (let i = 0; i < unicos.length; i += 100) {
    const lote = unicos.slice(i, i + 100);
    const j = (await llamar(env, `/Leads?ids=${lote.join(",")}&fields=First_Name,Last_Name,Full_Name,Mobile,Phone,Email,Country,Lead_Status`, {}, f, now)) as { data?: Array<Record<string, unknown>> };
    for (const r of j.data ?? []) mapa.set(String(r["id"]), candidatoDe(r));
  }
  return mapa;
}

export interface NotaZoho {
  titulo: string;
  texto: string;
  creada: string;
}

/** Últimas notas del candidato (la más reciente primero): ahí Maricela deja en qué quedó cada contacto. */
export async function notasDe(env: Env, leadId: string, n = 8, f: FetchFn = fetch, now = Date.now()): Promise<NotaZoho[]> {
  if (!/^\d{6,30}$/.test(leadId)) return [];
  const j = (await llamar(env, `/Leads/${leadId}/Notes?fields=Note_Title,Note_Content,Created_Time&sort_by=Created_Time&sort_order=desc&per_page=${Math.min(Math.max(n, 1), 20)}`, {}, f, now)) as { data?: Array<Record<string, unknown>> };
  return (j.data ?? []).map((r) => ({ titulo: String(r["Note_Title"] ?? ""), texto: String(r["Note_Content"] ?? ""), creada: String(r["Created_Time"] ?? "") }));
}

// ─── Escritura (fase 2) ──────────────────────────────────────────────────────
// Solo se completan tareas, se agregan notas/tareas y se cambia el estado de UN candidato. Nunca se borra nada.

async function escribir(env: Env, ruta: string, metodo: "POST" | "PUT", dato: Record<string, unknown>, f: FetchFn, now: number): Promise<string> {
  const j = (await llamar(env, ruta, { method: metodo, body: JSON.stringify({ data: [dato] }) }, f, now)) as { data?: Array<{ status?: string; message?: string; details?: { id?: string } }> };
  const r = j.data?.[0];
  if (!r || r.status !== "success") throw new ZohoError(`Zoho no guardó el cambio: ${r?.message ?? "sin respuesta"}`);
  return r.details?.id ?? "";
}

const idValido = (id: string): boolean => /^\d{6,30}$/.test(id);

/** Marca una tarea como «Completa». */
export async function completarTarea(env: Env, tareaId: string, f: FetchFn = fetch, now = Date.now()): Promise<void> {
  if (!idValido(tareaId)) throw new ZohoError("Tarea no válida.");
  await escribir(env, `/Tasks/${tareaId}`, "PUT", { Status: "Completa" }, f, now);
}

/** Agrega una nota al candidato. */
export async function crearNota(env: Env, leadId: string, texto: string, f: FetchFn = fetch, now = Date.now()): Promise<string> {
  if (!idValido(leadId)) throw new ZohoError("Candidato no válido.");
  return escribir(env, `/Leads/${leadId}/Notes`, "POST", { Note_Title: "Seguimiento", Note_Content: texto.slice(0, 3000) }, f, now);
}

/** Crea la siguiente tarea del candidato, a nombre de Maricela y «En Proceso». */
export async function crearTarea(env: Env, a: { leadId: string; asunto: string; fecha: string; ownerId: string }, f: FetchFn = fetch, now = Date.now()): Promise<string> {
  if (!idValido(a.leadId) || !/^\d{4}-\d{2}-\d{2}$/.test(a.fecha)) throw new ZohoError("Datos de la tarea no válidos.");
  return escribir(env, "/Tasks", "POST", { Subject: a.asunto.slice(0, 255), Due_Date: a.fecha, Status: "En Proceso", Owner: { id: a.ownerId }, What_Id: { id: a.leadId }, $se_module: "Leads" }, f, now);
}

/** Cambia el estado de UN candidato (p. ej. «Revisar en el futuro»). */
export async function cambiarEstadoCandidato(env: Env, leadId: string, estado: string, f: FetchFn = fetch, now = Date.now(), extra: Record<string, string> = {}): Promise<void> {
  if (!idValido(leadId)) throw new ZohoError("Candidato no válido.");
  await escribir(env, `/Leads/${leadId}`, "PUT", { Lead_Status: estado, ...extra }, f, now);
}

/** Lectura genérica de la API de Zoho (solo GET): para diagnósticos y para leer las transiciones de un candidato. */
export async function zohoGet(env: Env, ruta: string, f: FetchFn = fetch, now = Date.now()): Promise<unknown> {
  return llamar(env, ruta, {}, f, now);
}
