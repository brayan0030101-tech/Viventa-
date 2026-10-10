/**
 * CRM de Maricela (fase 1): lista por prioridad, ficha del cliente y conversación completa.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { cargarCrm, filtrarCrm, renderCrmLista, renderCrmFicha, guardarNota, excelCrm, mensajeHtml } from "../../member/crm.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 20, 12, 0);

async function cliente(id: string, channel: string, user: string, nombre: string, meta: Record<string, string>, contact = "") {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, channel, user, nombre, NOW - 5000, NOW - 1000]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [`l-${id}`, id, nombre, contact, "compra", JSON.stringify(meta), "new", NOW - 4000, NOW - 4000]);
}
async function msg(conv: string, role: string, content: string, at: number) {
  await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), conv, role, content, at]);
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro" } as unknown as Env;
  await cliente("ycloud:34600000001", "ycloud", "34600000001", "Ana López Ruiz",
    { ahorroDisponible: "20 mil euros", capacidadMensual: "1000", tipoEmpleo: "contrato indefinido", entregaInmediataOFutura: "ahora", ciudadCompra: "Medellín", ciudadResidencia: "España, Madrid" }, "ana@correo.com");
  await cliente("zernio:99", "zernio", "99", "pepe_ig", {});
  await msg("ycloud:34600000001", "user", "Hola <b>buenas</b>", NOW - 3000);
  await msg("ycloud:34600000001", "assistant", "¿Qué día te queda mejor?\n[[botones: Lun 12 oct | Mar 13 oct]]", NOW - 2500);
  await msg("ycloud:34600000001", "owner", "Te llamo yo mañana", NOW - 2000);
});

describe("lista del CRM", () => {
  it("clasifica y ordena: caliente primero, con su canal", async () => {
    const filas = await cargarCrm(env, NOW);
    expect(filas.map((f) => f.lead.nombre)).toContain("Ana López Ruiz");
    const ana = filas.find((f) => f.lead.nombre.startsWith("Ana"))!;
    expect(ana.lead.prioridad.nivel).toBe("caliente");
    expect(ana.lead.prioridad.razones.length).toBeGreaterThan(2);
    const html = await renderCrmLista(env, {}, NOW);
    expect(html).toContain("Ana López Ruiz");
    expect(html).toContain("Calientes");
    expect(html.indexOf("Ana López Ruiz")).toBeLessThan(html.indexOf("pepe_ig"));
  });

  it("filtra por nivel, canal y búsqueda", async () => {
    const filas = await cargarCrm(env, NOW);
    expect(filtrarCrm(filas, { nivel: "caliente" }).map((f) => f.lead.canal)).toEqual(["WhatsApp"]);
    expect(filtrarCrm(filas, { canal: "instagram" })).toHaveLength(1);
    expect(filtrarCrm(filas, { q: "medellin" })).toHaveLength(1); // sin tildes
    expect(filtrarCrm(filas, { q: "no existe" })).toHaveLength(0);
  });
});

describe("ficha del cliente", () => {
  it("muestra datos, prioridad y la conversación completa (cliente, bot y equipo) sin romper el HTML", async () => {
    const html = (await renderCrmFicha(env, "ycloud:34600000001", {}, NOW))!;
    expect(html).toContain("Ana López Ruiz");
    expect(html).toContain("Ahorro disponible");
    expect(html).toContain("Quiere entrega inmediata");
    expect(html).toContain("&lt;b&gt;buenas&lt;/b&gt;"); // el HTML del cliente se escapa
    expect(html).not.toContain("<b>buenas</b>");
    expect(html).toContain("Te llamo yo mañana");
    expect(html).toContain("Equipo (persona)");
    expect(html).toContain("Mar 13 oct"); // botones como chips
    expect(html).not.toContain("[[botones");
  });

  it("devuelve null si el cliente no existe", async () => {
    expect(await renderCrmFicha(env, "ycloud:0", {}, NOW)).toBeNull();
  });

  it("guarda la nota interna y la muestra", async () => {
    await guardarNota(env, "ycloud:34600000001", "Prefiere por la tarde");
    const html = (await renderCrmFicha(env, "ycloud:34600000001", { guardado: true }, NOW))!;
    expect(html).toContain("Prefiere por la tarde");
    expect(html).toContain("Guardada");
  });
});

describe("otros", () => {
  it("mensajeHtml convierte marcadores en chips", () => {
    const h = mensajeHtml("Hola\n[[botones: a | b]]");
    expect(h).toContain(">a<");
    expect(h).not.toContain("[[");
  });
  it("el Excel de la lista se genera", async () => {
    const x = await excelCrm(env, { nivel: "caliente" }, NOW);
    expect(x.length).toBeGreaterThan(200);
    expect(String.fromCharCode(x[0], x[1])).toBe("PK");
  });
});
