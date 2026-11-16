// member/proyectos.local.ts — «Atender lo que el cliente pide» (Maricela, 16 nov 2026).
// Cuando el cliente pide ver proyectos o precios de una ciudad (por ejemplo «pásame lo que tengas en Medellín por menos de 200 millones»), el bot NO debe
// contestar «el equipo te enviará opciones» y seguir con el formulario: debe resolver su necesidad. Esta herramienta le da los proyectos más económicos
// REALES del catálogo de ViveHome (los mismos de las cotizaciones) para esa ciudad y su área, dice con honestidad si hay algo dentro de su presupuesto y,
// si ya tiene ciudad y cuota guardadas, deja pedida la cotización formal (se arma en la próxima pasada y le llega por aquí).
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { asegurarTablasCola, catalogoGuardado, pedirOtraCotizacion } from "../src/vivehome/cola";
import { AREAS, ciudadesBuscadas, mensualidadEstimada, pctParaCotizar } from "../src/vivehome/reglas";
import type { Catalogo } from "../src/vivehome/navegador";

const MAX_OPCIONES = 3;
const CATALOGO_MAX_EDAD = 3 * 24 * 3_600_000;

export interface OpcionEconomica {
  proyecto: string;
  ciudad: string;
  /** Valor del apartamento más económico de ese proyecto, en pesos. */
  valor: number;
  entregaMeses: number;
  area: string;
  cuotaMensualPesos: number;
  cuotaMensualEuros: number;
  pctInicial: number;
}

const redondea = (n: number, a: number) => Math.round(n / a) * a;
const millones = (pesos: number) => `${redondea(pesos / 1e6, 1).toLocaleString("es-ES")} millones de pesos`;

/** Puro y probable: los proyectos más económicos (uno por proyecto) en las ciudades pedidas y su área metropolitana. */
export function masEconomicos(cat: Catalogo, ciudadTexto: string | null | undefined, max = MAX_OPCIONES): { ciudades: string[]; opciones: OpcionEconomica[]; sinCiudad: boolean } {
  const delCatalogo = [...new Set(cat.tipologias.map((t) => t.ciudad))];
  const pedidas = ciudadTexto ? ciudadesBuscadas(ciudadTexto, delCatalogo) : null;
  const ciudades = pedidas?.conArea?.length ? pedidas.conArea : delCatalogo;
  const pool = cat.tipologias
    .filter((t) => ciudades.includes(t.ciudad) && pctParaCotizar(t.pctMin) != null && t.meses > 0 && t.valor > 0)
    .map((t) => {
      const pct = pctParaCotizar(t.pctMin) as number;
      const mensual = mensualidadEstimada(t, pct);
      return { t, pct, mensual };
    })
    .filter((x) => x.mensual > 0);
  const porProyecto = new Map<string, (typeof pool)[number]>();
  for (const x of pool) {
    const k = `${x.t.proyecto}|${x.t.ciudad}`;
    const prev = porProyecto.get(k);
    if (!prev || x.t.valor < prev.t.valor) porProyecto.set(k, x);
  }
  const opciones = [...porProyecto.values()]
    .sort((a, b) => a.t.valor - b.t.valor)
    .slice(0, max)
    .map((x) => ({
      proyecto: x.t.proyecto,
      ciudad: x.t.ciudad,
      valor: x.t.valor,
      entregaMeses: x.t.meses,
      area: x.t.area,
      cuotaMensualPesos: redondea(x.mensual, 10_000),
      cuotaMensualEuros: redondea(x.mensual / cat.eur, 10),
      pctInicial: x.pct,
    }));
  return { ciudades: pedidas?.conArea?.length ? pedidas.nombradas : [], opciones, sinCiudad: !pedidas?.conArea?.length };
}

export function proyectosEconomicosTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Úsala cuando el cliente PIDE ver proyectos, precios o qué hay en una ciudad, o dice un tope de precio (por ejemplo «pásame los proyectos de Medellín por menos de 200 millones»). Devuelve los proyectos más económicos REALES del catálogo en esa ciudad y su área (nombre, valor, entrega, cuota mensual aproximada) y si hay alguno dentro de su presupuesto. Atiende primero lo que pidió con estos datos (nunca inventes otros); no la uses si el cliente no lo pidió.",
    inputSchema: z.object({
      ciudad: z.string().optional().describe("Ciudad o ciudades que dijo el cliente, tal como las escribió (ej. «Bogotá y Medellín»). Si no dijo, omítela."),
      presupuestoMaxMillones: z.number().optional().describe("Tope de precio del apartamento en MILLONES de pesos (ej. 200). Omítelo si no dijo un tope."),
    }),
    execute: async ({ ciudad, presupuestoMaxMillones }) => {
      try {
        const db = new Db(env.DB);
        await asegurarTablasCola(db);
        const cat = await catalogoGuardado(db);
        if (!cat || Date.now() - cat.leidoEn > CATALOGO_MAX_EDAD) return { ok: false as const, message: "No tengo el catálogo al día en este momento: dile con calidez que Maricela le presentará las mejores opciones en la videollamada y sigue con el guion. No inventes proyectos ni precios." };
        const convId = getConversationId();
        // Ciudad: la que dijo ahora; si no, la que ya tiene guardada en su ficha.
        let ciudadTxt = ciudad ?? "";
        let cuotaGuardada = "";
        if (convId) {
          const f = await db.first<{ ciudad: string | null; cuota: string | null }>(
            "SELECT json_extract(metadata,'$.ciudadCompra') AS ciudad, json_extract(metadata,'$.capacidadMensual') AS cuota FROM leads WHERE conversation_id = ? AND intent NOT LIKE 'Cita ·%' ORDER BY created_at DESC LIMIT 1",
            [convId],
          );
          if (!ciudadTxt) ciudadTxt = f?.ciudad ?? "";
          cuotaGuardada = f?.cuota ?? "";
        }
        const r = masEconomicos(cat, ciudadTxt);
        if (!r.opciones.length) return { ok: false as const, message: "No encontré proyectos en esa zona: díselo con honestidad y calidez, ofrécele mirar otra ciudad cercana y sigue con el guion. No inventes proyectos." };
        const tope = presupuestoMaxMillones ? presupuestoMaxMillones * 1e6 : null;
        const dentro = tope ? r.opciones.filter((o) => o.valor <= tope) : [];
        // Cotización formal: solo si ya hay ciudad y cuota guardadas y nunca se le ha hecho una (evita mandar dos).
        let cotizacionEnCamino = false;
        if (convId && ciudadTxt && cuotaGuardada) {
          const hay = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM cotizaciones_bot WHERE conv_id = ?", [convId]).catch(() => ({ n: 1 }));
          if (!hay?.n) cotizacionEnCamino = await pedirOtraCotizacion(env, convId).catch(() => false);
        }
        const opciones = r.opciones.map((o) => ({
          proyecto: o.proyecto,
          ciudad: o.ciudad,
          desde: `desde unos ${millones(o.valor)}`,
          entrega: `entrega en unos ${o.entregaMeses} meses`,
          area: o.area ? `${o.area} m²` : undefined,
          cuotaMensualAprox: `unos ${o.cuotaMensualPesos.toLocaleString("es-ES")} pesos al mes (≈ ${o.cuotaMensualEuros.toLocaleString("es-ES")} €) durante la construcción`,
        }));
        return {
          ok: true as const,
          ciudadesConsultadas: r.ciudades.length ? r.ciudades : "todas las del catálogo",
          presupuestoMaxMillones: presupuestoMaxMillones ?? null,
          hayDentroDelPresupuesto: tope ? dentro.length > 0 : null,
          masEconomicoDesde: millones(Math.min(...r.opciones.map((o) => o.valor))),
          opciones,
          cotizacionEnCamino,
          message:
            "ATIENDE LO QUE PIDIÓ, en un mensaje cálido y natural, ANTES de seguir con el guion. " +
            (tope && !dentro.length
              ? `Dile con honestidad que por menos de ${presupuestoMaxMillones} millones no hay hoy, pero que lo más económico parte desde ${millones(Math.min(...r.opciones.map((o) => o.valor)))}, y cuéntale las opciones de \`opciones\` (nombre, desde cuánto y entrega; la cuota mensual solo si la pregunta). `
              : "Cuéntale las opciones de `opciones` (nombre, desde cuánto y entrega; la cuota mensual solo si la pregunta). ") +
            (cotizacionEnCamino
              ? "Dile que en unos minutos le llega por aquí una cotización con los valores y la ubicación. "
              : "Dile que Maricela le prepara una cotización con los valores y la ubicación y se la comparte. ") +
            "Usa SOLO estos datos: no inventes proyectos, precios ni plazos. Después, en el mismo mensaje y con naturalidad, retoma UNA sola pregunta pendiente del guion.",
        };
      } catch (e) {
        console.error("[proyectosEconomicos]", e);
        return { ok: false as const, message: "No pude consultar los proyectos ahora: dile con calidez que Maricela le presentará las opciones y sigue con el guion." };
      }
    },
  });
}
