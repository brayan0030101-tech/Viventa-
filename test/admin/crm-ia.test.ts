/**
 * CRM de Maricela (fase 4): análisis con IA de una conversación y análisis semanal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generarMock = vi.fn();
vi.mock("../../src/llm/work-model", () => ({
  workModel: async () => ({ modelId: "modelo-test", provider: "anthropic", generate: (a: unknown) => generarMock(a) }),
}));
const notifyMock = vi.fn();
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyMock(...a), camilaConfigured: () => true };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { anonimizar, analizarConversacion, analizarSemana, prepararSemana, runAnalisisSemanal, mdHtml, tarjetaAnalisisConv, ultimoAnalisisConv, renderCrmRecomendaciones } from "../../member/crm-ia.local";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
const NOW = Date.UTC(2026, 9, 12, 7, 30); // lunes 12 oct 2026, 09:30 en Madrid
const D = 24 * 3600_000;

async function cliente(id: string, nombre: string, tel: string, n = 4) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", [id, "ycloud", tel, nombre, NOW - 3 * D, NOW - 2 * D + n * 1000]);
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [`l-${id}`, id, nombre, tel, "compra", JSON.stringify({ ahorroDisponible: "20 mil euros", ciudadCompra: "Medellín" }), "new", NOW - 3 * D, NOW - 3 * D]);
  for (let i = 0; i < n; i++) {
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
      [crypto.randomUUID(), id, i % 2 === 0 ? "user" : "assistant", i % 2 === 0 ? `Hola soy ${nombre}, mi teléfono es ${tel}` : "¿Para quién sería la vivienda?\n[[botones: Para mí | Inversión]]", NOW - 2 * D - (n - i) * 1000]);
  }
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", DASHBOARD_BASE_URL: "https://bot.example" } as unknown as Env;
  generarMock.mockReset().mockResolvedValue({ text: "## Resumen\nTodo bien con **Cliente 1** y Cliente 2.\n## Las 5 mejoras que más valen la pena\n- Mejora uno\n## Clientes para contactar primero\n- Cliente 1" });
  notifyMock.mockReset().mockResolvedValue(true);
  await cliente("ycloud:34600000001", "Ana López", "34600000001");
  await cliente("ycloud:34600000002", "Luis Mora", "34600000002");
  await cliente("ycloud:34600000003", "Carla Gil", "34600000003");
});

describe("análisis de una conversación", () => {
  it("lo guarda, lo muestra y no vuelve a gastar IA si no hay mensajes nuevos", async () => {
    const r = await analizarConversacion(env, "ycloud:34600000001", {}, NOW);
    expect(r.ok).toBe(true);
    expect(generarMock).toHaveBeenCalledTimes(1);
    const prompt = (generarMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("CLIENTE:");
    expect(prompt).toContain("(botones: Para mí | Inversión)");
    expect((await ultimoAnalisisConv(env, "ycloud:34600000001"))?.modelo).toBe("modelo-test");
    const otra = await analizarConversacion(env, "ycloud:34600000001", {}, NOW + 1000);
    expect(otra.reutilizado).toBe(true);
    expect(generarMock).toHaveBeenCalledTimes(1);
    const forzado = await analizarConversacion(env, "ycloud:34600000001", { forzar: true }, NOW + 2000);
    expect(forzado.reutilizado).toBeUndefined();
    expect(generarMock).toHaveBeenCalledTimes(2);
  });

  it("falla con gracia: conversación inexistente, muy corta o IA caída", async () => {
    expect((await analizarConversacion(env, "ycloud:0")).ok).toBe(false);
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES ('ycloud:1','ycloud','1','x',1,1)");
    expect((await analizarConversacion(env, "ycloud:1")).error).toContain("muy pocos");
    generarMock.mockRejectedValueOnce(new Error("boom"));
    const r = await analizarConversacion(env, "ycloud:34600000002", {}, NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No pude consultar a la IA");
  });

  it("la tarjeta de la ficha muestra el botón y luego el análisis", async () => {
    expect(await tarjetaAnalisisConv(env, "ycloud:34600000001", NOW)).toContain("Analizar esta conversación");
    await analizarConversacion(env, "ycloud:34600000001", {}, NOW);
    const html = await tarjetaAnalisisConv(env, "ycloud:34600000001", NOW - 2 * D + 4 * 1000);
    expect(html).toContain("Volver a analizar");
    expect(await tarjetaAnalisisConv(env, "ycloud:34600000001", NOW)).toContain("Actualizar análisis"); // llegaron mensajes nuevos
    expect(html).toContain("Mejora uno");
  });
});

describe("análisis semanal", () => {
  it("no manda nombres ni teléfonos a la IA y los devuelve en el resultado", async () => {
    const base = (await prepararSemana(env, NOW))!;
    expect(base.n).toBe(3);
    expect(base.texto).not.toContain("34600000001");
    expect(base.texto).toContain("### Cliente 1");
    const r = await analizarSemana(env, NOW);
    const prompt = (generarMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Ana López");
    expect(prompt).not.toContain("34600000002");
    // los nombres reales se vuelven a poner al guardar
    expect(r.analisis?.contenido).toMatch(/\(Cliente 1\)/);
    expect(r.analisis?.contenido).toMatch(/\((Cliente 2)\)/);
  });

  it("el cron solo corre los lunes a las 9:00, una vez, y avisa al equipo", async () => {
    expect((await runAnalisisSemanal(env, NOW + 30 * 24 * 3600_000 + D)).hecho).toBe(false); // otro día
    expect((await runAnalisisSemanal(env, NOW - 60 * 60_000)).hecho).toBe(false); // lunes 8:30
    expect((await runAnalisisSemanal(env, NOW)).hecho).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1].url).toBe("https://bot.example/crm/recomendaciones");
    expect(notifyMock.mock.calls[0][1].body).toContain("Mejora uno");
    expect((await runAnalisisSemanal(env, NOW + 5 * 60_000)).hecho).toBe(false); // ya se hizo hoy
    expect(generarMock).toHaveBeenCalledTimes(1);
  });

  it("se puede apagar con el ajuste viventa_analisis_semanal = off", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('viventa_analisis_semanal', 'off', 1)");
    expect((await runAnalisisSemanal(env, NOW)).hecho).toBe(false);
    expect(generarMock).not.toHaveBeenCalled();
  });

  it("la página de recomendaciones muestra el último análisis", async () => {
    await analizarSemana(env, NOW);
    const html = await renderCrmRecomendaciones(env, {}, NOW + 3600_000);
    expect(html).toContain("Las 5 mejoras");
    expect(html).toContain("Anteriores");
  });
});

describe("anonimizar", () => {
  it("quita correos, teléfonos y el nombre de la persona", () => {
    const t = anonimizar("Soy Ana López, escríbeme a ana@correo.com o al +34 600 000 001", "Ana López Ruiz");
    expect(t).not.toContain("Ana");
    expect(t).not.toContain("ana@correo.com");
    expect(t).not.toContain("600 000 001");
    expect(t).toContain("[correo]");
    expect(t).toContain("[teléfono]");
  });
});

describe("mdHtml", () => {
  it("escapa el HTML y da formato a títulos, viñetas y negritas", () => {
    const h = mdHtml("## Título\n- uno <script>x</script>\n**fuerte**");
    expect(h).toContain("<h4");
    expect(h).toContain("<li");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("<script>");
    expect(h).toContain("<b ");
  });
});
