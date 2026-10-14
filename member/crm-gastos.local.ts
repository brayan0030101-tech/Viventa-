// member/crm-gastos.local.ts — CRM de Viventa: «Gastos ChatBot».
// Libro simple de lo que cuesta el chatbot (Forja, API de Claude, YCloud, Cloudflare…). Montos en pesos colombianos (COP).
// Los 6 gastos iniciales se cargan una sola vez (ids fijos «ini-N»; si se borran, no vuelven a aparecer).
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { crmLayout } from "./crm-shell.local";
import { esc, ESTILO_CRM } from "./crm.local";

export const CATEGORIAS = ["Forja", "API (Claude)", "YCloud", "Cloudflare", "Otro"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export interface Gasto {
  id: string;
  fecha: string; // YYYY-MM-DD
  categoria: string;
  detalle: string;
  monto: number; // pesos enteros (COP)
}

const INICIALES: Array<Omit<Gasto, "id">> = [
  { fecha: "2026-10-14", categoria: "Forja", detalle: "Licencia / implementación Forja", monto: 211000 },
  { fecha: "2026-10-14", categoria: "API (Claude)", detalle: "Recarga de créditos", monto: 67000 },
  { fecha: "2026-10-14", categoria: "API (Claude)", detalle: "Recarga de créditos", monto: 35000 },
  { fecha: "2026-10-14", categoria: "API (Claude)", detalle: "Recarga de créditos", monto: 50000 },
  { fecha: "2026-10-14", categoria: "YCloud", detalle: "Saldo de WhatsApp", monto: 50000 },
  { fecha: "2026-10-14", categoria: "Cloudflare", detalle: "Plan / hosting del bot", monto: 17000 },
];

export const cop = (n: number): string => `$${Math.round(n).toLocaleString("es-CO")}`;

async function asegurar(db: Db): Promise<void> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_gastos (
       id TEXT PRIMARY KEY, fecha TEXT NOT NULL, categoria TEXT NOT NULL, detalle TEXT NOT NULL DEFAULT '', monto INTEGER NOT NULL, creado INTEGER NOT NULL
     )`,
  );
  const st = new SettingsRepo(db);
  if ((await st.get("crm_gastos_cargados")) === "1") return;
  for (let i = 0; i < INICIALES.length; i++) {
    const g = INICIALES[i]!;
    await db.run("INSERT OR IGNORE INTO crm_gastos (id, fecha, categoria, detalle, monto, creado) VALUES (?, ?, ?, ?, ?, ?)", [`ini-${i + 1}`, g.fecha, g.categoria, g.detalle, g.monto, Date.now() + i]);
  }
  await st.set("crm_gastos_cargados", "1");
}

export async function listarGastos(env: Env): Promise<Gasto[]> {
  const db = new Db(env.DB);
  await asegurar(db);
  return db.all<Gasto>("SELECT id, fecha, categoria, detalle, monto FROM crm_gastos ORDER BY fecha DESC, creado DESC");
}

export function validarGasto(e: { fecha?: string; categoria?: string; detalle?: string; monto?: string }): { ok: true; g: Omit<Gasto, "id"> } | { ok: false; error: string } {
  const fecha = (e.fecha ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T12:00:00Z`))) return { ok: false, error: "La fecha no es válida." };
  const monto = Number(String(e.monto ?? "").replace(/[.\s$]/g, "").replace(",", "."));
  if (!Number.isFinite(monto) || monto <= 0 || monto > 1e10) return { ok: false, error: "El monto no es válido (escribe solo números, por ejemplo 50000)." };
  const categoria = (CATEGORIAS as readonly string[]).includes(e.categoria ?? "") ? (e.categoria as string) : "Otro";
  return { ok: true, g: { fecha, categoria, detalle: (e.detalle ?? "").trim().slice(0, 200), monto: Math.round(monto) } };
}

export async function agregarGasto(env: Env, e: { fecha?: string; categoria?: string; detalle?: string; monto?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const v = validarGasto(e);
  if (!v.ok) return v;
  const db = new Db(env.DB);
  await asegurar(db);
  await db.run("INSERT INTO crm_gastos (id, fecha, categoria, detalle, monto, creado) VALUES (?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), v.g.fecha, v.g.categoria, v.g.detalle, v.g.monto, Date.now()]);
  return { ok: true };
}

export async function borrarGasto(env: Env, id: string): Promise<void> {
  const db = new Db(env.DB);
  await asegurar(db);
  await db.run("DELETE FROM crm_gastos WHERE id = ?", [id]);
}

export async function renderGastos(env: Env, opts: { hoy?: string; error?: string; ok?: boolean } = {}): Promise<string> {
  const gastos = await listarGastos(env);
  const hoy = opts.hoy ?? new Date().toISOString().slice(0, 10);
  const total = gastos.reduce((s, g) => s + g.monto, 0);
  const porCat = new Map<string, number>();
  for (const g of gastos) porCat.set(g.categoria, (porCat.get(g.categoria) ?? 0) + g.monto);
  const kpis = [...porCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, m]) => `<div class="crm-kpi"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">${esc(c)}</div><div style="font-weight:700;font-size:20px">${cop(m)}</div></div>`)
    .join("");
  const COLS = "100px 150px minmax(160px,1fr) 130px 90px";
  const filas = gastos
    .map(
      (g) => `<div class="crm-row" style="grid-template-columns:${COLS};align-items:center">
        <span class="text-dim" style="font-size:12px">${esc(g.fecha)}</span><span><b style="color:var(--cream)">${esc(g.categoria)}</b></span>
        <span class="text-muted" style="font-size:12.5px">${esc(g.detalle || "—")}</span><span style="text-align:right;font-weight:700">${cop(g.monto)}</span>
        <span style="text-align:right"><form method="POST" action="/crm/gastos/${esc(g.id)}/borrar" onsubmit="return confirm('¿Borrar este gasto de ${esc(cop(g.monto))}?')" style="margin:0"><button class="bigbtn" style="cursor:pointer;padding:4px 10px;font-size:11px;background:none;border:1px solid var(--line);color:var(--bad)">Borrar</button></form></span>
      </div>`,
    )
    .join("");
  const campo = "background:var(--panel,transparent);border:1px solid var(--line);color:var(--cream);padding:8px 10px;font-size:13px;font-family:inherit";
  const body = `${ESTILO_CRM}
    <div class="text-dim" style="font-size:12.5px;margin-bottom:14px">Lo que cuesta mantener el chatbot. Montos en pesos colombianos (COP).</div>
    ${opts.error ? `<div style="background:rgba(255,122,138,.12);border:1px solid var(--bad);color:var(--bad);padding:9px 12px;font-size:12.5px;margin-bottom:14px">${esc(opts.error)}</div>` : ""}
    ${opts.ok ? `<div style="color:var(--ok);font-size:12.5px;margin-bottom:12px">✔ Gasto guardado.</div>` : ""}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
      <div class="crm-kpi"><div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)">Total</div><div style="font-weight:700;font-size:26px">${cop(total)}</div></div>${kpis}</div>
    <div class="crm-card" style="padding:14px 16px;margin-bottom:16px"><form method="POST" action="/crm/gastos" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
      <label style="font-size:12px;color:var(--muted)">Fecha<br><input name="fecha" type="date" value="${esc(hoy)}" required style="${campo}"></label>
      <label style="font-size:12px;color:var(--muted)">Tipo<br><select name="categoria" style="${campo}">${CATEGORIAS.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
      <label style="font-size:12px;color:var(--muted);flex:1;min-width:160px">Detalle<br><input name="detalle" maxlength="200" placeholder="Opcional" style="${campo};width:100%;box-sizing:border-box"></label>
      <label style="font-size:12px;color:var(--muted)">Monto (COP)<br><input name="monto" inputmode="numeric" required placeholder="50000" style="${campo};width:130px"></label>
      <button class="bigbtn" style="cursor:pointer;padding:9px 16px">Agregar gasto</button></form></div>
    <div class="crm-card"><div style="overflow-x:auto"><div style="min-width:640px">
      <div class="crm-row crm-head" style="grid-template-columns:${COLS}"><span>Fecha</span><span>Tipo</span><span>Detalle</span><span style="text-align:right">Monto</span><span></span></div>
      ${gastos.length ? filas : `<div style="padding:34px 18px;text-align:center;color:var(--dim)">Todavía no hay gastos.</div>`}
    </div></div></div>`;
  return crmLayout({ title: "Gastos ChatBot", activa: "gastos", body, env });
}
