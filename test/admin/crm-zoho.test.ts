/**
 * CRM: sección «Subir a Zoho» (marcar subidos sin duplicar, orden y progreso) y modos separado / junto.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { cargarZoho, marcarZoho, renderCrmZoho, resumenZoho, excelPendientesZoho } from "../../member/crm-zoho.local";
import { crmApp, atenderEmbebido, crearInvitacion, __reiniciarTabla } from "../../member/crm-app.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 12, 0);
const H = 3600_000;

const COMPLETO = (extra: Record<string, string> = {}) => ({
  ahorroDisponible: "20 mil euros", capacidadMensual: "1000", ciudadCompra: "Medellín", ciudadResidencia: "España, Madrid", ...extra,
});

async function cliente(id: string, nombre: string, meta: Record<string, string>, contact: string, hace: number, convMeta?: Record<string, string>) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at, metadata) VALUES (?,?,?,?,?,?,?)",
    [id, "ycloud", id.split(":")[1], nombre, NOW - 9 * H, NOW - 1 * H, convMeta ? JSON.stringify(convMeta) : null]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [`l-${id}`, id, nombre, contact, "compra", JSON.stringify(meta), "new", NOW - hace, NOW - hace]);
}

beforeEach(async () => {
  __reiniciarTabla();
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", CRM_SESSION_SECRET: "secreto-de-prueba-largo-123456" } as unknown as Env;
  await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_form_url', 'https://forms.example/f', 1)");
  await cliente("ycloud:34600000001", "Ana López Ruiz", COMPLETO(), "ana@correo.com", 8 * H); // llegó primero
  await cliente("ycloud:34600000002", "Luis Mora Gil", COMPLETO(), "luis@correo.com", 3 * H);
  await cliente("ycloud:34600000003", "Pepa", COMPLETO(), "", 2 * H); // le falta apellido y correo no cuenta
  await cliente("ycloud:34600000004", "Zoe Gil Paz", COMPLETO(), "zoe@correo.com", 5 * H, { viventa_registrado: "2026-10-12T10:00:00.000Z", viventa_registrado_por: "Maricela" });
  await cliente("ycloud:34600000005", "Eva Sanz Ruiz", COMPLETO(), "eva@correo.com", 6 * H, { viventa_existente: "2026-10-09-maricela" });
});

describe("cola de Zoho", () => {
  it("clasifica en por subir, incompletos, subidos y ya existían, con orden de llegada", async () => {
    const f = await cargarZoho(env, NOW);
    const por = (e: string) => f.filter((x) => x.estado === e).map((x) => x.lead.nombre);
    expect(por("pendiente")).toEqual(["Ana López Ruiz", "Luis Mora Gil"]);
    expect(por("incompleto")).toEqual(["Pepa"]);
    expect(por("subido")).toEqual(["Zoe Gil Paz"]);
    expect(por("existia")).toEqual(["Eva Sanz Ruiz"]);
    const r = resumenZoho(f, NOW);
    expect(r.pendientes).toBe(2);
    expect(r.hechos).toBe(2);
    expect(r.completos).toBe(4);
    expect(r.ultimo?.lead.nombre).toBe("Zoe Gil Paz");
    expect(r.subidosHoy).toBe(1);
  });

  it("marcar como subido no se puede repetir (no duplica) y se puede deshacer", async () => {
    expect((await marcarZoho(env, ["ycloud:34600000001"], "registrado", "Maricela", NOW)).cambiados).toBe(1);
    expect((await marcarZoho(env, ["ycloud:34600000001"], "registrado", "Camila", NOW + 1000)).cambiados).toBe(0); // ya estaba
    expect((await marcarZoho(env, ["ycloud:34600000001"], "existente", "Camila", NOW + 2000)).cambiados).toBe(0); // tampoco la pisa
    const f = await cargarZoho(env, NOW + 3000);
    const ana = f.find((x) => x.lead.nombre.startsWith("Ana"))!;
    expect(ana.estado).toBe("subido");
    expect(ana.por).toBe("Maricela");
    await marcarZoho(env, ["ycloud:34600000001"], "deshacer", "Maricela", NOW + 4000);
    expect((await cargarZoho(env, NOW + 5000)).find((x) => x.lead.nombre.startsWith("Ana"))!.estado).toBe("pendiente");
    const log = await db.all<{ accion: string }>("SELECT accion FROM crm_zoho_log ORDER BY at");
    expect(log.map((l) => l.accion)).toEqual(["registrado", "deshacer"]);
  });

  it("marca varios a la vez, ignora ids raros y el resumen de las 8:00 ya no los trae", async () => {
    const r = await marcarZoho(env, ["ycloud:34600000001", "ycloud:34600000002", "'; DROP TABLE x;--"], "registrado", "Maricela", NOW);
    expect(r.cambiados).toBe(2);
    const { leadsListos } = await import("../../src/followup/resumenDia");
    expect((await leadsListos(db, NOW)).map((l) => l.nombre)).not.toContain("Ana López Ruiz");
  });

  it("la página muestra el progreso, el último subido, el formulario y los botones", async () => {
    const html = await renderCrmZoho(env, "pendientes", {}, NOW);
    expect(html).toContain("Llevas 2 de 4 clientes completos");
    expect(html).toContain("Último subido");
    expect(html).toContain("Zoe Gil Paz");
    expect(html).toContain("Abrir formulario");
    expect(html).toContain("forms.example/f");
    expect(html).toContain("Ya subido");
    expect(html).toContain("Marcar seleccionados como subidos");
    expect(html.indexOf("Ana López Ruiz")).toBeLessThan(html.indexOf("Luis Mora Gil")); // el más antiguo primero
    expect(html).not.toContain("Zoe Gil Paz</a>"); // el subido no está en la cola
    const subidos = await renderCrmZoho(env, "subidos", {}, NOW);
    expect(subidos).toContain("Zoe Gil Paz");
    expect(subidos).toContain("Deshacer");
    expect(subidos).toContain("por Maricela");
    expect(await renderCrmZoho(env, "incompletos", {}, NOW)).toContain("Falta: ");
  });

  it("el Excel de pendientes trae solo la cola", async () => {
    const x = await excelPendientesZoho(env, NOW);
    expect(String.fromCharCode(x[0], x[1])).toBe("PK");
  });
});

describe("separado / junto", () => {
  const raiz = () => {
    const r = new Hono<{ Bindings: Env }>();
    r.route("/crm", crmApp());
    return r;
  };
  const poner = (modo: string) => db.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('crm_modo', ?, 1)", [modo]);

  it("separado (por defecto: ambos): /crm pide su propio acceso y no deja pasar sin sesión", async () => {
    const r = await raiz().request("https://bot.example/crm/zoho", {}, env);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/crm/login");
  });

  it("modo «junto»: /crm manda al panel de Forja", async () => {
    await poner("junto");
    const r = await raiz().request("https://bot.example/crm/zoho", {}, env);
    expect(r.headers.get("location")).toBe("/admin/crm/zoho");
    expect((await raiz().request("https://bot.example/crm/login", {}, env)).headers.get("location")).toBe("/admin/crm");
  });

  it("dentro del panel de Forja: usa su marco, sus enlaces /admin/crm y su acceso (sin pedir otro)", async () => {
    const panel = { ...env, PANEL_NAME: "Brayan", PANEL_ROLE: "admin", PANEL_EMAIL: "b@x.co" } as Env;
    const res = await atenderEmbebido(new Request("https://bot.example/admin/crm/zoho?tab=pendientes"), panel);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Subir a Zoho");
    expect(html).toContain('href="/admin/crm/calendario"'); // enlaces reescritos
    expect(html).toContain("Panel"); // marco del panel de Forja
    expect(html).not.toContain('href="/crm/');
    const marcar = await atenderEmbebido(new Request("https://bot.example/admin/crm/zoho/marcar", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "ids=ycloud%3A34600000001&accion=registrado&tab=pendientes" }), panel);
    expect(marcar.status).toBe(302);
    expect(marcar.headers.get("location")).toMatch(/^\/admin\/crm\/zoho\?tab=pendientes/);
    expect((await cargarZoho(env, NOW)).find((x) => x.lead.nombre.startsWith("Ana"))!.por).toBe("Brayan");
  });

  it("modo «separado»: el panel de Forja manda a /crm", async () => {
    await poner("separado");
    const res = await atenderEmbebido(new Request("https://bot.example/admin/crm"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://bot.example/crm");
  });

  it("el administrador cambia la vista desde «Vista del CRM»; el equipo no", async () => {
    const mk = async (correo: string, rol: "admin" | "equipo") => {
      const inv = await crearInvitacion(env, { correo, nombre: correo, rol });
      if (!inv.ok) throw new Error(inv.error);
      const r = await raiz().request(`https://bot.example/crm/invitacion/${inv.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "nombre=X&clave=una-clave-larga-1" }, env);
      return (r.headers.get("set-cookie") ?? "").split(";")[0];
    };
    const admin = await mk("a@x.co", "admin");
    const equipo = await mk("e@x.co", "equipo");
    expect((await raiz().request("https://bot.example/crm/modo", {}, env)).status).toBe(302); // sin sesión
    const solo = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "modo=separado" };
    expect((await raiz().request("https://bot.example/crm/modo", { ...solo, headers: { ...solo.headers, cookie: equipo } }, env)).status).toBe(403);
    const ok = await raiz().request("https://bot.example/crm/modo", { ...solo, headers: { ...solo.headers, cookie: admin } }, env);
    expect(ok.status).toBe(302);
    expect((await db.first<{ value: string }>("SELECT value FROM settings WHERE key = 'crm_modo'"))?.value).toBe("separado");
    const pag = await raiz().request("https://bot.example/crm/modo", { headers: { cookie: admin } }, env);
    expect(await pag.text()).toContain("activo ahora");
  });
});
