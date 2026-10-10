// member/crm-app.local.ts — el CRM de Viventa como aplicación PROPIA (/crm): su propio acceso
// (usuarios y contraseñas distintos a los del panel de Forja), su propio diseño y sus propias
// rutas. Comparte solo la base de datos del bot (los leads, las conversaciones y las llamadas).
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { BASE, conUsuario, crmLayout, paginaSimple, reBase, modoValido, esEmbebido, ESTILO_CAMPO, ESTILO_BOTON, type ModoCrm } from "./crm-shell.local";
import { LOGO_SVG } from "./crm-logo.local";

// ─── Usuarios y sesiones (propios del CRM) ───────────────────────────────────

export type RolCrm = "admin" | "equipo";
export interface UsuarioCrm {
  id: string;
  correo: string;
  nombre: string;
  rol: RolCrm;
}

const COOKIE = "crm_sesion";
const TTL_SESION = 14 * 24 * 3600_000;
const TTL_INVITACION = 7 * 24 * 3600_000;
const ITERACIONES = 100_000;
const MAX_FALLOS = 5;
const BLOQUEO = 15 * 60_000;

const esc = (v: string | null | undefined): string =>
  (v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hashClave(clave: string, sal: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(sal), iterations: ITERACIONES }, k, 256));
}

async function hmac(clave: string, dato: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(dato)));
}

function iguales(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function token(n = 32): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => abc[b % abc.length]).join("");
}

/** La llave de las sesiones del CRM es propia (CRM_SESSION_SECRET); sin ella el CRM no abre. */
const llaveSesion = (env: Env): string | null => {
  const s = (env as unknown as { CRM_SESSION_SECRET?: string }).CRM_SESSION_SECRET;
  return s && s.length >= 16 ? `crm-session|${s}` : null;
};

let tablaLista = false;
export async function asegurarUsuarios(db: Db): Promise<void> {
  if (tablaLista) return;
  await db.run(
    `CREATE TABLE IF NOT EXISTS crm_users (
       id TEXT PRIMARY KEY, correo TEXT NOT NULL UNIQUE, nombre TEXT, rol TEXT NOT NULL DEFAULT 'equipo',
       pass_hash TEXT, sal TEXT, invite_token TEXT, invite_expires INTEGER,
       fallos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta INTEGER, version INTEGER NOT NULL DEFAULT 1,
       creado INTEGER NOT NULL, ultimo_acceso INTEGER
     )`,
  );
  tablaLista = true;
}
export function __reiniciarTabla(): void {
  tablaLista = false;
}

export async function emitirSesion(env: Env, id: string, version: number, now = Date.now()): Promise<string | null> {
  const k = llaveSesion(env);
  if (!k) return null;
  const exp = now + TTL_SESION;
  return `${id}.${exp}.${version}.${await hmac(k, `${id}.${exp}.${version}`)}`;
}

export async function usuarioDeSesion(env: Env, valor: string | undefined, now = Date.now()): Promise<UsuarioCrm | null> {
  const k = llaveSesion(env);
  if (!k || !valor) return null;
  const p = valor.split(".");
  if (p.length !== 4) return null;
  const [id, expRaw, verRaw, firma] = p;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return null;
  if (!iguales(firma, await hmac(k, `${id}.${exp}.${verRaw}`))) return null;
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  const r = await db.first<{ id: string; correo: string; nombre: string | null; rol: string; version: number; pass_hash: string | null }>(
    "SELECT id, correo, nombre, rol, version, pass_hash FROM crm_users WHERE id = ?",
    [id],
  );
  if (!r || !r.pass_hash || String(r.version) !== verRaw) return null; // «cerrar sesión en todos lados» sube la versión
  return { id: r.id, correo: r.correo, nombre: r.nombre ?? "", rol: r.rol === "admin" ? "admin" : "equipo" };
}

export async function crearInvitacion(env: Env, input: { correo: string; nombre?: string; rol: RolCrm }, now = Date.now()): Promise<{ ok: true; token: string; id: string } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  const correo = input.correo.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return { ok: false, error: "Ese correo no parece válido." };
  const t = token();
  const existente = await db.first<{ id: string; pass_hash: string | null }>("SELECT id, pass_hash FROM crm_users WHERE correo = ?", [correo]);
  if (existente?.pass_hash) return { ok: false, error: "Ese correo ya tiene acceso. Usa «Nueva invitación» si olvidó su contraseña." };
  if (existente) {
    await db.run("UPDATE crm_users SET invite_token = ?, invite_expires = ?, nombre = COALESCE(NULLIF(?, ''), nombre), rol = ? WHERE id = ?", [t, now + TTL_INVITACION, input.nombre ?? "", input.rol, existente.id]);
    return { ok: true, token: t, id: existente.id };
  }
  const id = crypto.randomUUID();
  await db.run("INSERT INTO crm_users (id, correo, nombre, rol, invite_token, invite_expires, creado) VALUES (?,?,?,?,?,?,?)", [id, correo, (input.nombre ?? "").trim() || null, input.rol, t, now + TTL_INVITACION, now]);
  return { ok: true, token: t, id };
}

export async function nuevaInvitacion(env: Env, id: string, now = Date.now()): Promise<string | null> {
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  const t = token();
  const r = await db.run("UPDATE crm_users SET invite_token = ?, invite_expires = ?, version = version + 1 WHERE id = ?", [t, now + TTL_INVITACION, id]);
  return (r.meta?.changes ?? 0) > 0 ? t : null;
}

export async function infoInvitacion(env: Env, tk: string, now = Date.now()): Promise<{ correo: string; nombre: string } | null> {
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  const r = await db.first<{ correo: string; nombre: string | null; invite_expires: number | null }>("SELECT correo, nombre, invite_expires FROM crm_users WHERE invite_token = ?", [tk]);
  if (!r || (r.invite_expires ?? 0) < now) return null;
  return { correo: r.correo, nombre: r.nombre ?? "" };
}

export async function aceptarInvitacion(env: Env, tk: string, clave: string, nombre: string, now = Date.now()): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  if (clave.length < 10) return { ok: false, error: "La contraseña necesita al menos 10 caracteres." };
  const r = await db.first<{ id: string; nombre: string | null; invite_expires: number | null; version: number }>("SELECT id, nombre, invite_expires, version FROM crm_users WHERE invite_token = ?", [tk]);
  if (!r) return { ok: false, error: "La invitación no es válida o ya se usó." };
  if ((r.invite_expires ?? 0) < now) return { ok: false, error: "La invitación venció. Pide una nueva." };
  const sal = token(16);
  await db.run("UPDATE crm_users SET pass_hash = ?, sal = ?, nombre = ?, invite_token = NULL, invite_expires = NULL, fallos = 0, bloqueado_hasta = NULL WHERE id = ?", [await hashClave(clave, sal), sal, nombre.trim() || r.nombre || null, r.id]);
  return { ok: true, id: r.id, version: r.version };
}

export async function iniciarSesion(env: Env, correo: string, clave: string, now = Date.now()): Promise<{ ok: true; id: string; version: number } | { ok: false; bloqueado: boolean }> {
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  const r = await db.first<{ id: string; pass_hash: string | null; sal: string | null; fallos: number; bloqueado_hasta: number | null; version: number }>(
    "SELECT id, pass_hash, sal, fallos, bloqueado_hasta, version FROM crm_users WHERE correo = ?",
    [correo.trim().toLowerCase()],
  );
  if (!r?.pass_hash || !r.sal) {
    await hashClave(clave, "relleno-de-tiempo"); // mismo costo que un usuario real
    return { ok: false, bloqueado: false };
  }
  if ((r.bloqueado_hasta ?? 0) > now) return { ok: false, bloqueado: true };
  if (!iguales(await hashClave(clave, r.sal), r.pass_hash)) {
    const fallos = Number(r.fallos ?? 0) + 1;
    const lock = fallos >= MAX_FALLOS ? now + BLOQUEO : null;
    await db.run("UPDATE crm_users SET fallos = ?, bloqueado_hasta = ? WHERE id = ?", [lock ? 0 : fallos, lock, r.id]);
    return { ok: false, bloqueado: !!lock };
  }
  await db.run("UPDATE crm_users SET fallos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?", [now, r.id]);
  return { ok: true, id: r.id, version: r.version };
}

export async function listarUsuarios(env: Env): Promise<Array<UsuarioCrm & { pendiente: boolean; ultimoAcceso: number | null }>> {
  const db = new Db(env.DB);
  await asegurarUsuarios(db);
  const rs = await db.all<{ id: string; correo: string; nombre: string | null; rol: string; pass_hash: string | null; ultimo_acceso: number | null }>(
    "SELECT id, correo, nombre, rol, pass_hash, ultimo_acceso FROM crm_users ORDER BY creado ASC",
  );
  return rs.map((r) => ({ id: r.id, correo: r.correo, nombre: r.nombre ?? "", rol: r.rol === "admin" ? "admin" : "equipo", pendiente: !r.pass_hash, ultimoAcceso: r.ultimo_acceso }));
}

// ─── Páginas de acceso ───────────────────────────────────────────────────────

function paginaLogin(error?: string, correo = ""): string {
  return paginaSimple(
    "Entrar",
    `${error ? `<div style="background:rgba(255,122,138,.12);border:1px solid var(--bad);color:var(--bad);padding:9px 12px;font-size:12.5px;margin-bottom:14px">${esc(error)}</div>` : ""}
    <form method="POST" action="${BASE}/login">
      <label style="font-size:12px;color:var(--muted)">Correo</label>
      <input name="correo" type="email" autocomplete="username" required value="${esc(correo)}" style="${ESTILO_CAMPO}">
      <label style="font-size:12px;color:var(--muted)">Contraseña</label>
      <input name="clave" type="password" autocomplete="current-password" required style="${ESTILO_CAMPO}">
      <button style="${ESTILO_BOTON}">Entrar al CRM</button>
    </form>
    <p style="font-size:11px;color:var(--dim);margin:16px 0 0">¿Olvidaste tu contraseña? Pídele a Brayan una invitación nueva.</p>`,
  );
}

function paginaInvitacion(info: { correo: string; nombre: string }, error?: string): string {
  return paginaSimple(
    "Crear contraseña",
    `<p style="font-size:13.5px;color:var(--muted);margin:0 0 14px">Hola 👋 Crea tu contraseña para entrar al CRM con <b style="color:var(--cream)">${esc(info.correo)}</b>.</p>
    ${error ? `<div style="background:rgba(255,122,138,.12);border:1px solid var(--bad);color:var(--bad);padding:9px 12px;font-size:12.5px;margin-bottom:14px">${esc(error)}</div>` : ""}
    <form method="POST">
      <label style="font-size:12px;color:var(--muted)">Tu nombre</label>
      <input name="nombre" value="${esc(info.nombre)}" autocomplete="name" style="${ESTILO_CAMPO}">
      <label style="font-size:12px;color:var(--muted)">Contraseña (mínimo 10 caracteres)</label>
      <input name="clave" type="password" autocomplete="new-password" minlength="10" required style="${ESTILO_CAMPO}">
      <button style="${ESTILO_BOTON}">Guardar y entrar</button>
    </form>`,
  );
}

// ─── Aplicación ──────────────────────────────────────────────────────────────

type Vars = { Bindings: Env; Variables: { usuario: UsuarioCrm | null } };

export function crmApp(): Hono<Vars> {
  const app = new Hono<Vars>();
  const opcionesCookie = { path: BASE, httpOnly: true, secure: true, sameSite: "Lax" as const, maxAge: TTL_SESION / 1000 };
  const origen = (c: { req: { url: string } }) => new URL(c.req.url).origin;
  const soloAdminCtx = async (c: Context<Vars>) => c.get("usuario")?.rol === "admin";

  // Páginas públicas
  app.get("/logo.svg", (c) => new Response(LOGO_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } }));

  app.get("/login", async (c) => {
    if ((await leerModo(c.env)) === "junto") return c.redirect("/admin/crm");
    if (!llaveSesion(c.env)) return c.text("El CRM todavía no está configurado (falta CRM_SESSION_SECRET).", 503);
    if (await usuarioDeSesion(c.env, getCookie(c, COOKIE))) return c.redirect(BASE);
    return c.html(paginaLogin());
  });

  app.post("/login", async (c) => {
    if (!llaveSesion(c.env)) return c.text("El CRM todavía no está configurado.", 503);
    const f = await c.req.parseBody();
    const correo = String(f.correo ?? "");
    const r = await iniciarSesion(c.env, correo, String(f.clave ?? ""));
    if (!r.ok) return c.html(paginaLogin(r.bloqueado ? "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." : "Correo o contraseña incorrectos.", correo), r.bloqueado ? 429 : 401);
    const valor = await emitirSesion(c.env, r.id, r.version);
    if (!valor) return c.text("El CRM todavía no está configurado.", 503);
    setCookie(c, COOKIE, valor, opcionesCookie);
    return c.redirect(BASE);
  });

  app.get("/salir", (c) => {
    deleteCookie(c, COOKIE, { path: BASE });
    return c.redirect(`${BASE}/login`);
  });

  app.get("/invitacion/:token", async (c) => {
    const info = await infoInvitacion(c.env, c.req.param("token"));
    return info ? c.html(paginaInvitacion(info)) : c.html(paginaSimple("Invitación", `<p style="color:var(--muted);font-size:14px">Esta invitación no es válida o ya venció. Pídele a Brayan una nueva.</p><a href="${BASE}/login">Ir al acceso</a>`), 404);
  });

  app.post("/invitacion/:token", async (c) => {
    const tk = c.req.param("token");
    const info = await infoInvitacion(c.env, tk);
    if (!info) return c.html(paginaSimple("Invitación", `<p style="color:var(--muted)">Esta invitación no es válida o ya venció.</p>`), 404);
    const f = await c.req.parseBody();
    const r = await aceptarInvitacion(c.env, tk, String(f.clave ?? ""), String(f.nombre ?? ""));
    if (!r.ok) return c.html(paginaInvitacion(info, r.error), 400);
    const valor = await emitirSesion(c.env, r.id, r.version);
    if (valor) setCookie(c, COOKIE, valor, opcionesCookie);
    return c.redirect(BASE);
  });

  // ¿Dónde vive el CRM ahora? (ajuste «crm_modo», se cambia desde «Vista del CRM»).
  app.use("*", async (c, next) => {
    if (esEmbebido(c.env)) return next(); // dentro del panel de Forja ya pasó por su acceso
    const ruta = c.req.path.replace(/^\/crm/, "") || "/"; // la ruta llega completa cuando la app está montada en /crm
    if (ruta === "/logo.svg") return next();
    const modo = await leerModo(c.env);
    if (modo === "junto") return c.redirect(`/admin/crm${ruta === "/" ? "" : ruta}`);
    return next();
  });

  // Todo lo demás exige sesión del CRM (o, dentro del panel de Forja, la del panel).
  app.use("*", async (c, next) => {
    if (esEmbebido(c.env)) {
      const e = c.env as unknown as { PANEL_NAME?: string; PANEL_EMAIL?: string; PANEL_ROLE?: string };
      c.set("usuario", { id: "panel", correo: e.PANEL_EMAIL ?? "", nombre: e.PANEL_NAME ?? "Panel", rol: e.PANEL_ROLE === "staff" ? "equipo" : "admin" });
      return next();
    }
    if (!llaveSesion(c.env)) return c.text("El CRM todavía no está configurado (falta CRM_SESSION_SECRET).", 503);
    const u = await usuarioDeSesion(c.env, getCookie(c, COOKIE));
    if (!u) {
      if (c.req.method === "GET") return c.redirect(`${BASE}/login`);
      return c.text("Sesión vencida. Entra de nuevo.", 401);
    }
    c.set("usuario", u);
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return next();
  });

  const pagina = (c: Context<Vars>, html: string) => {
    const u = c.get("usuario");
    return c.html(conUsuario(html, u ? { nombre: u.nombre, correo: u.correo, rol: u.rol } : null));
  };
  const xlsx = (data: Uint8Array, nombre: string) =>
    new Response(data as unknown as BodyInit, {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${nombre}-${new Date().toISOString().slice(0, 10)}.xlsx"` },
    });

  // Leads
  app.get("/", async (c) => {
    const { renderCrmLista } = await import("./crm.local");
    return pagina(c, await renderCrmLista(c.env, { nivel: c.req.query("nivel"), canal: c.req.query("canal"), estado: c.req.query("estado"), q: c.req.query("q") }));
  });
  app.get("/export.xlsx", async (c) => {
    const { excelCrm } = await import("./crm.local");
    return xlsx(await excelCrm(c.env, { nivel: c.req.query("nivel"), canal: c.req.query("canal"), estado: c.req.query("estado"), q: c.req.query("q") }), "crm-leads");
  });
  app.get("/c/:id", async (c) => {
    const { renderCrmFicha } = await import("./crm.local");
    const html = await renderCrmFicha(c.env, decodeURIComponent(c.req.param("id")), { guardado: c.req.query("guardado") === "1", errorIA: c.req.query("iaerror") || undefined });
    return html ? pagina(c, html) : c.text("Cliente no encontrado", 404);
  });
  app.post("/c/:id/nota", async (c) => {
    const { guardarNota } = await import("./crm.local");
    const id = decodeURIComponent(c.req.param("id"));
    await guardarNota(c.env, id, String((await c.req.parseBody())["nota"] ?? ""));
    return c.redirect(`${BASE}/c/${encodeURIComponent(id)}?guardado=1`);
  });
  app.post("/c/:id/analizar", async (c) => {
    const { analizarConversacion } = await import("./crm-ia.local");
    const id = decodeURIComponent(c.req.param("id"));
    const r = await analizarConversacion(c.env, id, { forzar: (await c.req.parseBody())["forzar"] === "1" });
    return c.redirect(`${BASE}/c/${encodeURIComponent(id)}${r.ok ? "" : `?iaerror=${encodeURIComponent(r.error ?? "No se pudo analizar")}`}`);
  });
  app.get("/c/:id/ficha.xlsx", async (c) => {
    const { excelFicha } = await import("./crm-calendario.local");
    const data = await excelFicha(c.env, decodeURIComponent(c.req.param("id")));
    return data ? xlsx(data, "ficha-cliente") : c.text("Cliente no encontrado", 404);
  });

  // Calendario
  app.get("/calendario", async (c) => {
    const { renderCrmCalendario } = await import("./crm-calendario.local");
    return pagina(c, await renderCrmCalendario(c.env, c.req.query("mes")));
  });
  app.get("/llamada/:id", async (c) => {
    const { renderLlamadaDetalle } = await import("./crm-calendario.local");
    const html = await renderLlamadaDetalle(c.env, decodeURIComponent(c.req.param("id")));
    return html ? c.html(html) : c.text("Llamada no encontrada", 404);
  });

  // Informes
  app.get("/informes", async (c) => {
    const { renderCrmInformes, periodoValido } = await import("./crm-informes.local");
    return pagina(c, await renderCrmInformes(c.env, periodoValido(c.req.query("p"))));
  });
  app.get("/informes.xlsx", async (c) => {
    const { excelInforme, periodoValido } = await import("./crm-informes.local");
    return xlsx(await excelInforme(c.env, periodoValido(c.req.query("p"))), "informe-viventa");
  });

  // Recomendaciones (IA)
  app.get("/recomendaciones", async (c) => {
    const { renderCrmRecomendaciones } = await import("./crm-ia.local");
    return pagina(c, await renderCrmRecomendaciones(c.env, { id: c.req.query("id") }));
  });
  app.post("/recomendaciones/generar", async (c) => {
    const { analizarSemana, analisisSemanales, renderCrmRecomendaciones } = await import("./crm-ia.local");
    const previos = await analisisSemanales(c.env, 1);
    if (previos[0] && Date.now() - previos[0].creado < 30 * 60_000) {
      return pagina(c, await renderCrmRecomendaciones(c.env, { error: "Ya se generó un análisis hace menos de 30 minutos. Espera un poco para no gastar de más." }));
    }
    const r = await analizarSemana(c.env);
    return pagina(c, await renderCrmRecomendaciones(c.env, r.ok ? { id: r.analisis?.id, mensaje: "✔ Análisis generado." } : { error: r.error }));
  });

  // Subir a Zoho
  app.get("/zoho", async (c) => {
    const { renderCrmZoho, pestanaValida } = await import("./crm-zoho.local");
    return pagina(c, await renderCrmZoho(c.env, pestanaValida(c.req.query("tab")), { orden: c.req.query("orden") ?? undefined, mensaje: c.req.query("ok") ? `✔ ${decodeURIComponent(c.req.query("ok")!)}` : undefined }));
  });
  app.post("/zoho/marcar", async (c) => {
    const { marcarZoho, pestanaValida } = await import("./crm-zoho.local");
    const f = await c.req.parseBody({ all: true });
    const ids = ([] as unknown[]).concat(f["ids"] ?? []).map(String);
    const accion = f["accion"] === "existente" ? "existente" : f["accion"] === "deshacer" ? "deshacer" : "registrado";
    const u = c.get("usuario");
    const r = await marcarZoho(c.env, ids, accion, u?.nombre || u?.correo || "CRM");
    const texto = accion === "deshacer" ? `${r.cambiados} cliente(s) vuelven a la cola` : accion === "existente" ? `${r.cambiados} cliente(s) marcados como ya existentes` : `${r.cambiados} cliente(s) marcados como subidos`;
    return c.redirect(`${BASE}/zoho?tab=${pestanaValida(String(f["tab"] ?? ""))}&ok=${encodeURIComponent(texto)}`);
  });
  app.get("/zoho.xlsx", async (c) => {
    const { excelPendientesZoho } = await import("./crm-zoho.local");
    return xlsx(await excelPendientesZoho(c.env), "pendientes-zoho");
  });

  // Vista del CRM (separado / junto / ambos)
  app.get("/modo", async (c) => {
    if (!(await soloAdminCtx(c))) return c.text("Solo el administrador puede ver esto.", 403);
    return pagina(c, await vistaModo(c.env, origen(c), c.req.query("ok") === "1"));
  });
  app.post("/modo", async (c) => {
    if (!(await soloAdminCtx(c))) return c.text("Solo el administrador puede hacer esto.", 403);
    const f = await c.req.parseBody();
    await new SettingsRepo(new Db(c.env.DB)).set("crm_modo", modoValido(String(f["modo"] ?? "")));
    return c.redirect(`${BASE}/modo?ok=1`);
  });

  // Usuarios (solo administrador)
  const soloAdmin = async (c: Context<Vars>) => c.get("usuario")?.rol === "admin";
  app.get("/usuarios", async (c) => {
    if (!(await soloAdmin(c))) return c.text("Solo el administrador puede ver esto.", 403);
    return pagina(c, await vistaUsuarios(c.env, origen(c), c.req.query("invitacion") ?? undefined, c.req.query("error") ?? undefined));
  });
  app.post("/usuarios", async (c) => {
    if (!(await soloAdmin(c))) return c.text("Solo el administrador puede hacer esto.", 403);
    const f = await c.req.parseBody();
    const r = await crearInvitacion(c.env, { correo: String(f.correo ?? ""), nombre: String(f.nombre ?? ""), rol: f.rol === "admin" ? "admin" : "equipo" });
    return c.redirect(`${BASE}/usuarios?${r.ok ? `invitacion=${r.token}` : `error=${encodeURIComponent(r.error)}`}`);
  });
  app.post("/usuarios/:id/invitar", async (c) => {
    if (!(await soloAdmin(c))) return c.text("Solo el administrador puede hacer esto.", 403);
    const t = await nuevaInvitacion(c.env, c.req.param("id"));
    return c.redirect(`${BASE}/usuarios${t ? `?invitacion=${t}` : ""}`);
  });
  app.post("/usuarios/:id/borrar", async (c) => {
    if (!(await soloAdmin(c))) return c.text("Solo el administrador puede hacer esto.", 403);
    const id = c.req.param("id");
    if (id !== c.get("usuario")?.id) await new Db(c.env.DB).run("DELETE FROM crm_users WHERE id = ?", [id]);
    return c.redirect(`${BASE}/usuarios`);
  });

  return app;
}

async function vistaUsuarios(env: Env, origen: string, invitacion?: string, error?: string): Promise<string> {
  const us = await listarUsuarios(env);
  const enlace = invitacion && /^[a-z0-9]{20,64}$/.test(invitacion) ? `${origen}${BASE}/invitacion/${invitacion}` : "";
  const fila = (u: (typeof us)[number]) => `<tr style="border-top:1px solid var(--line)">
      <td style="padding:10px 8px"><b style="color:var(--cream)">${esc(u.nombre || "—")}</b><br><span class="text-dim" style="font-size:11.5px">${esc(u.correo)}</span></td>
      <td>${u.rol === "admin" ? "Administrador" : "Equipo"}</td>
      <td>${u.pendiente ? '<span style="color:var(--accent-2)">Invitación pendiente</span>' : `Activo<br><span class="text-dim" style="font-size:11px">${u.ultimoAcceso ? new Date(u.ultimoAcceso).toLocaleDateString("es-ES") : "—"}</span>`}</td>
      <td style="text-align:right;white-space:nowrap">
        <form method="POST" action="${BASE}/usuarios/${u.id}/invitar" style="display:inline"><button class="ghostbtn" style="background:none;border:1px solid var(--line);color:var(--muted);padding:5px 10px;font-size:11.5px;cursor:pointer" title="Genera un enlace nuevo para crear la contraseña (cierra sus sesiones)">Nueva invitación</button></form>
        <form method="POST" action="${BASE}/usuarios/${u.id}/borrar" style="display:inline" onsubmit="return confirm('¿Quitar el acceso de ${esc(u.correo)}?')"><button class="ghostbtn" style="background:none;border:1px solid var(--line);color:var(--bad);padding:5px 10px;font-size:11.5px;cursor:pointer">Quitar</button></form>
      </td></tr>`;
  const body = `<style>.crm-card{background:var(--panel);border:1px solid var(--line)}</style>
    ${enlace ? `<div class="crm-card" style="padding:14px 16px;margin-bottom:14px;border-left:4px solid var(--ok)">
        <div style="font-weight:700;color:var(--cream);margin-bottom:4px">✔ Invitación lista</div>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">Mándale este enlace a la persona (WhatsApp o correo). Sirve una sola vez y vence en 7 días:</div>
        <input readonly value="${esc(enlace)}" onclick="this.select()" style="width:100%;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 10px;font-size:12.5px"></div>` : ""}
    ${error ? `<div class="crm-card" style="padding:10px 14px;margin-bottom:14px;color:var(--bad);font-size:12.5px">${esc(error)}</div>` : ""}
    <div class="crm-card" style="padding:16px;margin-bottom:14px">
      <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:10px">Invitar a una persona</div>
      <form method="POST" action="${BASE}/usuarios" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <div><label style="font-size:11px;color:var(--muted)">Correo</label><br><input name="correo" type="email" required style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 10px;font-size:13px;min-width:240px"></div>
        <div><label style="font-size:11px;color:var(--muted)">Nombre</label><br><input name="nombre" style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 10px;font-size:13px"></div>
        <div><label style="font-size:11px;color:var(--muted)">Rol</label><br><select name="rol" style="background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:9px 10px;font-size:13px"><option value="equipo">Equipo (ve y gestiona leads)</option><option value="admin">Administrador (también invita)</option></select></div>
        <button class="bigbtn" style="background:var(--accent);color:#fff;border:0;padding:10px 18px;font-size:13px;font-weight:700">Crear invitación</button>
      </form>
    </div>
    <div class="crm-card" style="padding:6px 16px 10px;overflow-x:auto"><table style="width:100%;font-size:13px;border-collapse:collapse;color:var(--muted)">
      <thead><tr style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);text-align:left"><th style="padding:10px 8px">Persona</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
      <tbody>${us.map(fila).join("") || '<tr><td colspan="4" style="padding:20px;color:var(--dim)">Todavía no hay usuarios.</td></tr>'}</tbody></table></div>
    <p class="text-dim" style="font-size:11px;margin-top:10px">Estos usuarios son solo del CRM. No tienen relación con el panel de Forja.</p>`;
  return crmLayout({ title: "Usuarios", activa: "usuarios", body });
}

export async function leerModo(env: Env): Promise<ModoCrm> {
  try {
    return modoValido(await new SettingsRepo(new Db(env.DB)).get("crm_modo"));
  } catch {
    return "ambos";
  }
}

async function vistaModo(env: Env, origen: string, guardado: boolean): Promise<string> {
  const actual = await leerModo(env);
  const opcion = (m: ModoCrm, titulo: string, texto: string) => `<form method="POST" action="${BASE}/modo" class="crm-card" style="padding:16px 18px;border:1px solid ${actual === m ? "var(--accent)" : "var(--line)"};${actual === m ? "background:var(--accent-soft);" : ""}display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:240px"><div style="font-weight:700;color:var(--cream);font-size:14.5px">${titulo}${actual === m ? ' <span style="color:var(--ok);font-size:12px">· activo ahora</span>' : ""}</div><div style="font-size:12.5px;color:var(--muted);margin-top:3px">${texto}</div></div>
      <input type="hidden" name="modo" value="${m}">
      <button class="bigbtn" ${actual === m ? "disabled" : ""} style="background:${actual === m ? "var(--line)" : "var(--accent)"};color:#fff;border:0;padding:9px 16px;font-size:12.5px;font-weight:700">${actual === m ? "Elegido" : "Usar este"}</button></form>`;
  const body = `<style>.crm-card{background:var(--panel);border:1px solid var(--line)}</style>
    ${guardado ? '<div class="crm-card" style="padding:10px 14px;margin-bottom:12px;color:var(--ok);font-size:12.5px">✔ Cambio guardado. Ya vale, sin esperar nada.</div>' : ""}
    <p style="font-size:13px;color:var(--muted);margin:0 0 14px;max-width:760px">Aquí decides <b style="color:var(--cream)">dónde se ve el CRM</b>. Los datos son los mismos en cualquier opción (leads, llamadas, Zoho, informes): solo cambia por dónde se entra. Puedes cambiar cuando quieras, sin perder nada.</p>
    <div style="display:grid;gap:12px;max-width:820px">
      ${opcion("ambos", "Los dos a la vez (para comparar)", `Entras por <b>${esc(origen)}/crm</b> (CRM aparte, con su acceso propio) o por <b>${esc(origen)}/admin/crm</b> (dentro del panel de Forja). Úsalo mientras decides.`)}
      ${opcion("separado", "Separado (CRM aparte)", `Solo funciona <b>${esc(origen)}/crm</b>, con sus propios usuarios y su diseño de Viventa. El panel de Forja deja de mostrar el botón «CRM».`)}
      ${opcion("junto", "Junto (dentro del panel de Forja)", `Solo funciona <b>${esc(origen)}/admin/crm</b>, con el acceso del panel de Forja. La dirección <b>/crm</b> te manda ahí.`)}
    </div>`;
  return crmLayout({ title: "Vista del CRM", activa: "modo", body, env });
}

// ─── Dentro del panel de Forja ───────────────────────────────────────────────

let interna: Hono<Vars> | null = null;

/**
 * Atiende /admin/crm/* con la misma aplicación del CRM, pero dentro del marco del panel de Forja
 * y con el acceso del panel (que ya validó la sesión). Reescribe los enlaces a /admin/crm.
 */
export async function atenderEmbebido(request: Request, env: Env): Promise<Response> {
  const modo = await leerModo(env);
  const url = new URL(request.url);
  if (modo === "separado") return Response.redirect(`${url.origin}${BASE}`, 302);
  interna ??= crmApp();
  const resto = url.pathname.replace(/^\/admin\/crm/, "") || "/";
  // Dentro del panel de Forja, SOLO las páginas del CRM se pintan con la marca de Viventa (el resto del panel no cambia).
  const entorno = {
    ...env, CRM_BASE: "/admin/crm", CRM_SHELL: "forja", CRM_EMBEBIDO: "1",
    BRAND_NAME: "Maricela Naranjo · Viventa", BRAND_LOGO_URL: "/brand/logo", BRAND_ACCENT: "#E60D6F",
    BRAND_ACCENT_2: "#F2A2C6", BRAND_SURFACE: "#161A33", BRAND_FONT: "Poppins",
  } as Env;
  const res = await interna.fetch(new Request(`${url.origin}${resto}${url.search}`, request), entorno);
  const loc = res.headers.get("location");
  if (loc && loc.startsWith(BASE)) {
    const h = new Headers(res.headers);
    h.set("location", `/admin/crm${loc.slice(BASE.length)}`);
    return new Response(null, { status: res.status, headers: h });
  }
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    const h = new Headers(res.headers);
    h.delete("content-length");
    return new Response(reBase(await res.text(), "/admin/crm"), { status: res.status, headers: h });
  }
  return res;
}
