/**
 * Cola de cotizaciones del bot: interruptor (apagado / piloto / activo), aprobación del piloto, horario y ventana de 24 h, registro en el CRM
 * y en la ficha, y fallos de ViveHome convertidos en hallazgos del auditor. ViveHome y el envío están simulados (sin red).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { SettingsRepo } from "../../src/db/settings";
import { runCotizacionesBot, asegurarTablasCola, guardarCatalogo, filasDe, pedirOtraCotizacion, AJUSTE_MODO, AJUSTE_PILOTO, AJUSTE_PILOTO_OK, AJUSTE_PLANTILLA, type Dependencias } from "../../src/vivehome/cola";
import { ErrorPantalla, type TipologiaCatalogo, type PedidoCotizacion } from "../../src/vivehome/navegador";
import { asegurarTablaCotizaciones } from "../../src/followup/cotizaciones";
import type { Env } from "../../src/env";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0); // 14:00 en Madrid
let env: Env;
let db: Db;

const t = (proyecto: string, ciudad: string, valor: number, meses: number): TipologiaCatalogo => ({ proyecto, ciudad, valor, meses, pctMin: 20, area: "50,00", segmento: "VIS" });
const CATALOGO = [t("Abedules", "Cali", 249_395_630, 31), t("Casas de la vega", "Cali", 175_322_130, 20), t("Ambar", "Jamundí", 203_333_000, 35), t("Alborada", "Bogotá D.C.", 247_430_000, 28)];

interface Simulado {
  deps: Dependencias;
  plantillas: Array<{ tel: string; nombre: string }>;
  creadas: PedidoCotizacion[];
  enviados: Array<{ conversationId: string; text: string }>;
  avisos: string[];
  abiertos: number;
}

function simular(opts: { fallarCrear?: boolean; siguienteId?: number } = {}): Simulado {
  const s: Simulado = { creadas: [], enviados: [], avisos: [], abiertos: 0, plantillas: [], deps: {} };
  let id = opts.siguienteId ?? 3000;
  s.deps = {
    plantillaAprobada: async () => true,
    enviarPlantilla: async (_e, tel, nombre) => {
      s.plantillas.push({ tel, nombre });
    },
    abrirNavegador: async () => {
      s.abiertos++;
      return { page: {}, cerrar: async () => undefined };
    },
    enviar: async (_e, m) => {
      s.enviados.push({ conversationId: m.conversationId, text: m.text });
    },
    avisar: async (_e, h, b) => {
      s.avisos.push(`${h} ${b}`);
    },
    navegador: {
      entrar: async () => undefined,
      leerCatalogo: async () => ({ tipologias: CATALOGO, eur: 3563, usd: 3174.7 }),
      crearCotizacion: async (_p: unknown, ped: PedidoCotizacion) => {
        if (opts.fallarCrear) throw new ErrorPantalla("inmuebles", "no aparece el buscador");
        s.creadas.push(ped);
        return { cotId: String(++id), ensayo: false, resumen: "" };
      },
      leerCotizacionPublica: async () => ({ cliente: "", proyectos: [{ proyecto: "ABEDULES", ciudad: "Cali", pct: 20, valor: 249_395_630, meses: 31, mensualidad: 1_576_774 }, { proyecto: "CASAS DE LA VEGA", ciudad: "Cali", pct: 20, valor: 175_322_130, meses: 20, mensualidad: 1_654_000 }, { proyecto: "AMBAR", ciudad: "Jamundí", pct: 20, valor: 203_333_000, meses: 35, mensualidad: 1_133_343 }] }),
    } as never,
  };
  return s;
}

async function cliente(tel: string, nombre: string, meta: Record<string, string>, ultimoMsg = NOW - 2 * H): Promise<string> {
  const c = await new ConversationsRepo(db).getOrCreate("ycloud", tel, nombre);
  await new MessagesRepo(db).append(c.id, "user", "hola", { createdAt: ultimoMsg });
  await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [crypto.randomUUID(), c.id, nombre, `${nombre.split(" ")[0].toLowerCase()}@correo.com`, "Lead", JSON.stringify({ ciudadResidencia: "España, Madrid", entregaInmediataOFutura: "futura", ahorroDisponible: "5000 euros", tipoEmpleo: "empleado", ingresosMensuales: "2000 euros", ...meta }), NOW - 3 * H, NOW - 3 * H]);
  return c.id;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1, VIVEHOME_USER: "u", VIVEHOME_PASSWORD: "p", DASHBOARD_BASE_URL: "" } as unknown as Env;
  await asegurarTablasCola(db);
  await asegurarTablaCotizaciones(db);
  await guardarCatalogo(db, { tipologias: CATALOGO, eur: 3563, usd: 3174.7 }, NOW - H);
});

const ajustar = (k: string, v: string) => new SettingsRepo(db).set(k, v);

describe("cotizaciones del bot", () => {
  it("apagado (o sin ajuste) no hace nada", async () => {
    await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    const s = simular();
    expect((await runCotizacionesBot(env, NOW, s.deps)).modo).toBe("apagado");
    expect(await filasDe(env)).toHaveLength(0);
    expect(s.abiertos).toBe(0);
  });

  it("piloto: prepara la propuesta de los de la lista y NO crea ni envía nada sin el OK", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros mensuales" });
    await cliente("34600000002", "Fuera Del Piloto", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    await ajustar(AJUSTE_MODO, "piloto");
    await ajustar(AJUSTE_PILOTO, a);
    const s = simular();
    await runCotizacionesBot(env, NOW, s.deps);
    const filas = await filasDe(env);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ conv_id: a, estado: "propuesta", tipo: "a_la_medida", capacidad: 1_750_000 });
    expect(filas[0].mensaje).toContain("¡Hola, Laura!");
    expect(filas[0].mensaje).toContain("quota-information?id=[número]");
    expect(s.creadas).toHaveLength(0);
    expect(s.enviados).toHaveLength(0);
    expect(s.abiertos).toBe(0); // catálogo al día: ni siquiera abre el navegador
  });

  it("piloto aprobado: crea en ViveHome (20 %, casilla desmarcada la pone el navegador), envía con cifras exactas y registra en CRM y ficha", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros mensuales" });
    await ajustar(AJUSTE_MODO, "piloto");
    await ajustar(AJUSTE_PILOTO, a);
    await runCotizacionesBot(env, NOW, simular().deps);
    await ajustar(AJUSTE_PILOTO_OK, a);
    const s = simular();
    const r = await runCotizacionesBot(env, NOW + 15 * 60_000, s.deps);
    expect(r).toMatchObject({ creadas: 1, enviadas: 1, errores: 0 });
    expect(s.creadas[0]).toMatchObject({ nombre: "Laura Pérez", correo: "laura@correo.com", telefono: "+34600000001" });
    expect(s.creadas[0].items.length).toBeLessThanOrEqual(3);
    expect(s.enviados[0].text).toContain("quota-information?id=3001");
    expect(s.enviados[0].text).toContain("$1.133.343 al mes durante 35 meses"); // la más baja, con la cifra exacta de la cotización publicada
    const [f] = await filasDe(env, a);
    expect(f).toMatchObject({ estado: "enviada", cot_id: "3001" });
    const crm = await db.first<{ cot_id: string }>("SELECT cot_id FROM cotizaciones_enviadas WHERE tel = '34600000001'");
    expect(crm?.cot_id).toBe("3001");
    const notas = await db.first<{ notes: string }>("SELECT notes FROM leads WHERE conversation_id = ?", [a]);
    expect(notas?.notes).toContain("COT-3001");
    // Una sola por cliente: otra pasada no hace nada nuevo.
    const s2 = simular();
    await runCotizacionesBot(env, NOW + 30 * 60_000, s2.deps);
    expect(s2.creadas).toHaveLength(0);
  });

  it("no le alcanza: manda las 2 más económicas y anota en la ficha que NO se cotizó a la medida", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Bogotá", capacidadMensual: "350 euros" });
    await cliente("34600000009", "Otro", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    await ajustar(AJUSTE_MODO, "activo");
    const s = simular();
    await runCotizacionesBot(env, NOW, s.deps);
    const f = (await filasDe(env, a))[0];
    expect(f).toMatchObject({ estado: "enviada", tipo: "mas_economicas" });
    expect(s.enviados.find((e) => e.conversationId === a)?.text).toContain("queda por encima de lo que me comentaste");
    const notas = await db.first<{ notes: string }>("SELECT notes FROM leads WHERE conversation_id = ?", [a]);
    expect(notas?.notes).toContain("NO se cotizó a la medida");
  });

  it("sin proyectos en su ciudad: no se cotiza y se avisa a Maricela", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Neiva, Huila", capacidadMensual: "900 euros" });
    await ajustar(AJUSTE_MODO, "activo");
    const s = simular();
    await runCotizacionesBot(env, NOW, s.deps);
    expect((await filasDe(env, a))[0].estado).toBe("sin_proyectos");
    expect(s.avisos[0]).toContain("Neiva");
    expect(s.creadas).toHaveLength(0);
  });

  it("activo: se salta a quien tiene videollamada o ya recibió cotización de Maricela", async () => {
    const conCita = await cliente("34600000001", "Con Cita", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    await db.run("INSERT INTO leads (id, conversation_id, intent, created_at, updated_at) VALUES (?,?,?,?,?)", [crypto.randomUUID(), conCita, "Cita · videollamada", NOW, NOW]);
    const conCot = await cliente("34600000002", "Con Cotizacion", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    await db.run("INSERT INTO cotizaciones_enviadas (msg_id, cot_id, tel, enviada_en) VALUES ('m', '2387', '34600000002', ?)", [NOW - 5 * H]);
    await ajustar(AJUSTE_MODO, "activo");
    const s = simular();
    await runCotizacionesBot(env, NOW, s.deps);
    expect(await filasDe(env, conCita)).toHaveLength(0);
    expect((await filasDe(env, conCot))[0].estado).toBe("omitida");
    expect(s.creadas).toHaveLength(0);
  });

  it("fuera de la ventana de 24 h no crea nada: queda pendiente de plantilla y vuelve a la cola cuando el cliente escribe", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" }, NOW - 30 * H);
    await ajustar(AJUSTE_MODO, "activo");
    const s = simular();
    await runCotizacionesBot(env, NOW, s.deps);
    expect((await filasDe(env, a))[0].estado).toBe("pendiente_plantilla");
    expect(s.creadas).toHaveLength(0);
    await new MessagesRepo(db).append(a, "user", "hola de nuevo", { createdAt: NOW + H });
    const s2 = simular();
    await runCotizacionesBot(env, NOW + H + 60_000, s2.deps);
    expect((await filasDe(env, a))[0].estado).toBe("enviada");
  });

  it("de noche (hora del cliente) espera a la mañana", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" }, Date.UTC(2026, 9, 20, 21, 0));
    await ajustar(AJUSTE_MODO, "activo");
    const s = simular();
    await runCotizacionesBot(env, Date.UTC(2026, 9, 20, 22, 30), s.deps); // 00:30 en Madrid
    expect((await filasDe(env, a))[0].estado).toBe("propuesta");
    expect(s.creadas).toHaveLength(0);
  });

  it("si ViveHome cambió: hallazgo del auditor, reintenta y a los 3 fallos se detiene", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    await ajustar(AJUSTE_MODO, "activo");
    for (let i = 0; i < 3; i++) await runCotizacionesBot(env, NOW + i * 15 * 60_000, simular({ fallarCrear: true }).deps);
    const f = (await filasDe(env, a))[0];
    expect(f).toMatchObject({ estado: "error", intentos: 3 });
    const h = await db.all<{ tipo: string; detalle: string }>("SELECT tipo, detalle FROM auditoria_hallazgos WHERE conv_id = ?", [a]);
    expect(h).toHaveLength(3);
    expect(h[0].tipo).toBe("cotizacion_fallida");
    expect(h[2].detalle).toContain("se dejó de intentar");
  });

  it("el cliente pidió otra: nueva ronda que se arma en la pasada siguiente", async () => {
    const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" });
    await ajustar(AJUSTE_MODO, "activo");
    await runCotizacionesBot(env, NOW, simular().deps);
    expect(await pedirOtraCotizacion(env, a, NOW + H)).toBe(true);
    expect(await pedirOtraCotizacion(env, a, NOW + H)).toBe(false); // ya hay una pedida
    const s = simular({ siguienteId: 4000 });
    await runCotizacionesBot(env, NOW + 2 * H, s.deps);
    const filas = await filasDe(env, a);
    expect(filas.map((f) => [f.ronda, f.estado])).toEqual([[2, "enviada"], [1, "enviada"]]);
  });

  describe("plantilla de WhatsApp para los que tienen la ventana cerrada", () => {
    it("con el interruptor apagado no manda nada (cuesta dinero)", async () => {
      await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" }, NOW - 30 * H);
      await ajustar(AJUSTE_MODO, "activo");
      const s = simular();
      await runCotizacionesBot(env, NOW, s.deps);
      await runCotizacionesBot(env, NOW + 15 * 60_000, s.deps);
      expect(s.plantillas).toHaveLength(0);
    });

    it("activa: una sola plantilla por cliente, en su horario, solo WhatsApp; con «Sí, envíamela» sale la cotización", async () => {
      const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" }, NOW - 30 * H);
      const ig = await new ConversationsRepo(db).getOrCreate("zernio", "ig-123", "insta");
      await new MessagesRepo(db).append(ig.id, "user", "hola", { createdAt: NOW - 30 * H });
      await db.run("INSERT INTO leads (id, conversation_id, name, intent, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [crypto.randomUUID(), ig.id, "Insta Gram", "Lead", JSON.stringify({ ciudadCompra: "Cali", capacidadMensual: "500 euros" }), NOW - 3 * H, NOW - 3 * H]);
      await ajustar(AJUSTE_MODO, "activo");
      await ajustar(AJUSTE_PLANTILLA, "activo");
      const s = simular();
      await runCotizacionesBot(env, NOW, s.deps); // prepara y marca pendientes
      await runCotizacionesBot(env, NOW + 15 * 60_000, s.deps);
      await runCotizacionesBot(env, NOW + 30 * 60_000, s.deps);
      expect(s.plantillas).toEqual([{ tel: "34600000001", nombre: "Laura" }]);
      expect(s.creadas).toHaveLength(0);
      const hilo = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant'", [a]);
      expect(hilo?.content).toContain("¿Te la enviamos por aquí?");
      await new MessagesRepo(db).append(a, "user", "Sí, envíamela", { createdAt: NOW + H });
      await runCotizacionesBot(env, NOW + H + 60_000, s.deps);
      expect((await filasDe(env, a))[0].estado).toBe("enviada");
      expect(s.enviados.find((e) => e.conversationId === a)?.text).toContain("quota-information?id=");
    });

    it("con «Ahora no» no se le cotiza y queda anotado", async () => {
      const a = await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" }, NOW - 30 * H);
      await ajustar(AJUSTE_MODO, "activo");
      await ajustar(AJUSTE_PLANTILLA, "activo");
      const s = simular();
      await runCotizacionesBot(env, NOW, s.deps);
      await runCotizacionesBot(env, NOW + 15 * 60_000, s.deps);
      expect(s.plantillas).toHaveLength(1);
      await new MessagesRepo(db).append(a, "user", "Ahora no", { createdAt: NOW + H });
      await runCotizacionesBot(env, NOW + H + 60_000, s.deps);
      expect((await filasDe(env, a))[0].estado).toBe("omitida");
      expect(s.creadas).toHaveLength(0);
      const notas = await db.first<{ notes: string }>("SELECT notes FROM leads WHERE conversation_id = ?", [a]);
      expect(notas?.notes).toContain("Ahora no");
    });

    it("sin aprobación de Meta no se manda", async () => {
      await cliente("34600000001", "Laura Pérez", { ciudadCompra: "Cali", capacidadMensual: "500 euros" }, NOW - 30 * H);
      await ajustar(AJUSTE_MODO, "activo");
      await ajustar(AJUSTE_PLANTILLA, "activo");
      const s = simular();
      s.deps.plantillaAprobada = async () => false;
      await runCotizacionesBot(env, NOW, s.deps);
      await runCotizacionesBot(env, NOW + 15 * 60_000, s.deps);
      expect(s.plantillas).toHaveLength(0);
    });
  });
});
