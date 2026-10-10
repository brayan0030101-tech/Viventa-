/**
 * El CRM es una aplicación PROPIA (/crm): su propio acceso, independiente del panel de Forja.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { crmApp, crearInvitacion, nuevaInvitacion, __reiniciarTabla } from "../../member/crm-app.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let raiz: Hono<{ Bindings: Env }>;

const pedir = (ruta: string, init: RequestInit = {}, cookie?: string) =>
  raiz.request(`https://bot.example${ruta}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } }, env);
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const cookieDe = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

async function usuario(correo: string, rol: "admin" | "equipo", clave = "una-clave-larga-1", nombre = "Maricela Naranjo"): Promise<string> {
  const inv = await crearInvitacion(env, { correo, nombre, rol });
  if (!inv.ok) throw new Error(inv.error);
  const r = await pedir(`/crm/invitacion/${inv.token}`, form({ nombre, clave }));
  expect(r.status).toBe(302);
  return cookieDe(r);
}

beforeEach(async () => {
  __reiniciarTabla();
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", CRM_SESSION_SECRET: "secreto-de-prueba-largo-123456" } as unknown as Env;
  raiz = new Hono<{ Bindings: Env }>();
  raiz.route("/crm", crmApp());
});

describe("acceso al CRM", () => {
  it("sin sesión todo manda al acceso del CRM (y no al del panel de Forja)", async () => {
    const r = await pedir("/crm");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/crm/login");
    const p = await pedir("/crm/calendario");
    expect(p.headers.get("location")).toBe("/crm/login");
    expect((await pedir("/crm/login")).status).toBe(200);
    expect(await (await pedir("/crm/login")).text()).toContain("Entrar al CRM");
  });

  it("sin la llave de sesión propia el CRM no abre (falla cerrado)", async () => {
    env = { ...env, CRM_SESSION_SECRET: "" } as Env;
    expect((await pedir("/crm")).status).toBe(503);
    expect((await pedir("/crm/login")).status).toBe(503);
  });

  it("la invitación crea la contraseña una sola vez y deja entrar", async () => {
    const inv = await crearInvitacion(env, { correo: "maricela@viventa.co", nombre: "Maricela", rol: "equipo" });
    if (!inv.ok) throw new Error("x");
    expect((await pedir(`/crm/invitacion/${inv.token}`)).status).toBe(200);
    const corta = await pedir(`/crm/invitacion/${inv.token}`, form({ nombre: "M", clave: "corta" }));
    expect(corta.status).toBe(400);
    const ok = await pedir(`/crm/invitacion/${inv.token}`, form({ nombre: "Maricela Naranjo", clave: "una-clave-larga-1" }));
    expect(ok.status).toBe(302);
    const cookie = cookieDe(ok);
    const home = await pedir("/crm", {}, cookie);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Maricela Naranjo");
    expect(html).toContain("Cerrar sesión");
    expect(html).not.toContain("Flujo"); // nada del panel de Forja
    expect((await pedir(`/crm/invitacion/${inv.token}`)).status).toBe(404); // ya se usó
  });

  it("entra con correo y contraseña; falla con la equivocada y se bloquea a los 5 intentos", async () => {
    await usuario("maricela@viventa.co", "equipo");
    const bien = await pedir("/crm/login", form({ correo: "maricela@viventa.co", clave: "una-clave-larga-1" }));
    expect(bien.status).toBe(302);
    for (let i = 0; i < 4; i++) expect((await pedir("/crm/login", form({ correo: "maricela@viventa.co", clave: "mala" }))).status).toBe(401);
    expect((await pedir("/crm/login", form({ correo: "maricela@viventa.co", clave: "mala" }))).status).toBe(429);
    expect((await pedir("/crm/login", form({ correo: "maricela@viventa.co", clave: "una-clave-larga-1" }))).status).toBe(429); // bloqueada aunque acierte
    expect((await pedir("/crm/login", form({ correo: "nadie@x.co", clave: "x" }))).status).toBe(401);
  });

  it("una cookie del panel de Forja o de otra llave no sirve en el CRM", async () => {
    await usuario("maricela@viventa.co", "equipo");
    expect((await pedir("/crm", {}, "hz_panel=master.9999999999999.1.firma")).status).toBe(302);
    expect((await pedir("/crm", {}, "crm_sesion=falsa.9999999999999.1.firma")).status).toBe(302);
  });

  it("cerrar sesión borra la cookie; «nueva invitación» invalida las sesiones viejas", async () => {
    const cookie = await usuario("maricela@viventa.co", "equipo");
    expect((await pedir("/crm", {}, cookie)).status).toBe(200);
    const salir = await pedir("/crm/salir", {}, cookie);
    expect(salir.headers.get("location")).toBe("/crm/login");
    const u = await db.first<{ id: string }>("SELECT id FROM crm_users WHERE correo = 'maricela@viventa.co'");
    await nuevaInvitacion(env, u!.id);
    expect((await pedir("/crm", {}, cookie)).status).toBe(302); // sesión anterior invalidada
  });
});

describe("usuarios del CRM", () => {
  it("solo el administrador ve y crea usuarios; el equipo no", async () => {
    const admin = await usuario("brayan@viventa.co", "admin", "otra-clave-larga-22", "Brayan");
    const equipo = await usuario("camila@viventa.co", "equipo", "clave-de-camila-33", "Camila");
    expect((await pedir("/crm/usuarios", {}, equipo)).status).toBe(403);
    expect((await pedir("/crm/usuarios", form({ correo: "x@y.co" }), equipo)).status).toBe(403);
    const lista = await pedir("/crm/usuarios", {}, admin);
    expect(lista.status).toBe(200);
    const html = await lista.text();
    expect(html).toContain("camila@viventa.co");
    expect(html).toContain("Estos usuarios son solo del CRM");
    const crea = await pedir("/crm/usuarios", form({ correo: "nueva@viventa.co", nombre: "Nueva", rol: "equipo" }), admin);
    expect(crea.status).toBe(302);
    expect(crea.headers.get("location")).toMatch(/invitacion=[a-z0-9]{32}/);
    // el equipo ni siquiera ve la pestaña de usuarios
    expect(await (await pedir("/crm", {}, equipo)).text()).not.toContain("🔑");
    expect(await (await pedir("/crm", {}, admin)).text()).toContain("🔑");
  });

  it("el logo es público y todas las páginas del CRM usan los colores y el logo de Viventa", async () => {
    const logo = await pedir("/crm/logo.svg");
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    const cookie = await usuario("maricela@viventa.co", "equipo");
    for (const ruta of ["/crm", "/crm/calendario", "/crm/informes", "/crm/recomendaciones"]) {
      const r = await pedir(ruta, {}, cookie);
      expect(r.status).toBe(200);
      const h = await r.text();
      expect(h).toContain("#E60D6F");
      expect(h).toContain("/crm/logo.svg");
      expect(h).not.toContain("/admin/");
    }
  });
});
