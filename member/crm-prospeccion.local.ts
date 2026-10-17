// member/crm-prospeccion.local.ts — CRM de Viventa: «Prospección».
// Lista de los candidatos de Maricela que están en el estado «En Prospección» de Zoho, con su fecha de creación. Regla de Maricela:
// nadie puede pasar más de un mes en ese estado, así que se marca en rojo a quien ya lo pasó y en ámbar a quien está por pasarlo.
import type { Env } from "../src/env";
import { buildXlsx } from "../src/lib/xlsx";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";
import { ZohoError, candidatosEnEstado, zohoListo, type CandidatoLista, type FetchFn } from "./crm-zohoapi.local";

export const ESTADO_PROSPECCION = "En Prospección";
export const DIAS_LIMITE = 30;
export const DIAS_AVISO = 21;
const DIA = 86_400_000;

export type Semaforo = "vencido" | "por_vencer" | "ok";

export interface FilaProspeccion {
  c: CandidatoLista;
  dias: number;
  semaforo: Semaforo;
  /** YYYY-MM-DD de creación (España). */
  creado: string;
}

const ymdMadrid = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** Días completos desde la creación y semáforo. «Más de un mes» = más de 30 días. */
export function clasificar(c: CandidatoLista, now: number): FilaProspeccion {
  const t = Date.parse(c.creado);
  const dias = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DIA)) : 0;
  return { c, dias, semaforo: dias > DIAS_LIMITE ? "vencido" : dias >= DIAS_AVISO ? "por_vencer" : "ok", creado: Number.isFinite(t) ? ymdMadrid(t) : "—" };
}

export async function cargarProspeccion(env: Env, now = Date.now(), f?: FetchFn): Promise<FilaProspeccion[]> {
  return (await candidatosEnEstado(env, ESTADO_PROSPECCION, f, now)).map((c) => clasificar(c, now)).sort((a, b) => b.dias - a.dias);
}

const ETIQ: Record<Semaforo, { txt: string; color: string }> = {
  vencido: { txt: "🔴 Más de un mes", color: "var(--bad)" },
  por_vencer: { txt: "🟠 Por cumplir el mes", color: "var(--accent-2)" },
  ok: { txt: "🟢 Dentro del plazo", color: "var(--ok)" },
};

export async function renderProspeccion(env: Env, opts: { ver?: string } = {}, now = Date.now(), f?: FetchFn): Promise<string> {
  let cuerpo: string;
  if (!zohoListo(env)) {
    cuerpo = `<div class="crm-card" style="padding:28px;text-align:center;color:var(--dim)">Zoho todavía no está conectado.</div>`;
  } else {
    try {
      const todas = await cargarProspeccion(env, now, f);
      const venc = todas.filter((x) => x.semaforo === "vencido").length;
      const por = todas.filter((x) => x.semaforo === "por_vencer").length;
      const ver = opts.ver === "vencidos" || opts.ver === "por_vencer" ? opts.ver : "todos";
      const filas = ver === "vencidos" ? todas.filter((x) => x.semaforo === "vencido") : ver === "por_vencer" ? todas.filter((x) => x.semaforo === "por_vencer") : todas;
      const COLS = "minmax(170px,1.2fr) 150px minmax(170px,1.2fr) 110px 110px 70px 150px";
      const fila = (x: FilaProspeccion) => {
        const e = ETIQ[x.semaforo];
        return `<div class="crm-row" style="grid-template-columns:${COLS};align-items:center">
          <span><b style="color:var(--cream)">${esc(x.c.nombre)}</b></span>
          <span class="text-muted" style="font-size:12px">${esc(x.c.movil || x.c.telefono || "—")}</span>
          <span class="text-muted" style="font-size:12px;word-break:break-all">${esc(x.c.correo || "—")}</span>
          <span class="text-dim" style="font-size:12px">${esc(x.c.pais || "—")}</span>
          <span class="text-dim" style="font-size:12px">${esc(x.creado)}</span>
          <span style="font-weight:700;color:${e.color}">${x.dias}</span>
          <span style="font-size:12px;color:${e.color}">${e.txt}</span></div>`;
      };
      const kpi = (t: string, n: number, v: string, color?: string) =>
        `<a class="crm-kpi${ver === v ? " on" : ""}" href="/crm/prospeccion?ver=${v}"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${t}</div><div style="font-weight:700;font-size:26px;${color ? `color:${color}` : ""}">${n}</div></a>`;
      cuerpo = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px">
          ${kpi("En prospección", todas.length, "todos")}
          ${kpi("🔴 Más de un mes", venc, "vencidos", "var(--bad)")}
          ${kpi("🟠 Por cumplir el mes", por, "por_vencer", "var(--accent-2)")}</div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><a class="bigbtn" style="font-size:12px;padding:7px 14px" href="/crm/prospeccion.xlsx">⬇ Excel de esta lista</a></div>
        <div class="crm-card"><div style="overflow-x:auto"><div style="min-width:900px">
          <div class="crm-row crm-head" style="grid-template-columns:${COLS}"><span>Candidato</span><span>Teléfono</span><span>Correo</span><span>País</span><span>Creado</span><span>Días</span><span>Plazo</span></div>
          ${filas.length ? filas.map(fila).join("") : `<div style="padding:40px;text-align:center;color:var(--dim)">No hay candidatos en esta lista 🎉</div>`}
        </div></div></div>`;
    } catch (e) {
      console.error("[crm-prospeccion]", e);
      cuerpo = `<div class="crm-card" style="padding:24px;color:var(--bad)">${e instanceof ZohoError ? esc(e.message) : "No pude leer Zoho ahora. Inténtalo en unos minutos."}</div>`;
    }
  }
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Candidatos de Maricela en el estado «${ESTADO_PROSPECCION}» de Zoho, del que lleva más tiempo al más reciente. <b style="color:var(--cream)">Nadie debe pasar más de un mes</b> en este estado: en rojo los que ya lo pasaron (más de ${DIAS_LIMITE} días desde su creación) y en naranja los que están por cumplirlo (${DIAS_AVISO} días o más).</div>
    ${cuerpo}`;
  return crmLayout({ title: "Prospección", activa: "prospeccion", body, env });
}

export async function excelProspeccion(env: Env, now = Date.now(), f?: FetchFn): Promise<Uint8Array> {
  const filas = await cargarProspeccion(env, now, f);
  const rows: Array<Array<string | number | null>> = [["#", "Candidato", "Teléfono", "Correo", "País", "Creado", "Días en prospección", "Plazo"]];
  filas.forEach((x, i) => rows.push([i + 1, x.c.nombre, x.c.movil || x.c.telefono, x.c.correo, x.c.pais, x.creado, x.dias, x.semaforo === "vencido" ? "Más de un mes" : x.semaforo === "por_vencer" ? "Por cumplir el mes" : "Dentro del plazo"]));
  return buildXlsx([{ name: "Prospección", rows, widths: [5, 32, 18, 34, 14, 12, 12, 22] }]);
}
