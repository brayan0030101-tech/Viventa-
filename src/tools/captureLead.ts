import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";
import { phoneFromConversationId, channelUserIdFromConversationId } from "./shared-phone";

export function captureLeadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Captura un lead (cliente interesado) para que el dueño venda después. Guarda en D1 + opcionalmente exporta a Google Sheets / Notion / Airtable. " +
      "Si el canal es WhatsApp, NO le pidas el teléfono al cliente — se completa solo desde el número con el que ya te está escribiendo; dejá 'contact' vacío salvo que el cliente te dé un contacto DISTINTO a propósito.",
    inputSchema: z.object({
      name: z.string().optional().describe("Nombre del cliente"),
      contact: z.string().optional().describe("Teléfono o email — solo si el cliente lo dio explícitamente (p.ej. un email, o un teléfono distinto al de WhatsApp)"),
      intent: z.string().describe("Qué quiere el cliente, en 1-2 frases"),
      notes: z.string().optional(),
      // Calificación extendida (embudo completo, Pro) — todos opcionales; solo
      // se guardan si el cliente los dio. Van a metadata estructurada, no a
      // notes, para que se puedan filtrar/ver como columnas en el panel.
      ciudadResidencia: z.string().optional().describe("Ciudad donde vive el cliente actualmente (fuera de Colombia)"),
      ciudadCompra: z.string().optional().describe("Ciudad de Colombia donde quiere comprar"),
      motivoCompra: z.string().optional().describe("Para vivir, para la familia, o como inversión"),
      ahorroDisponible: z.string().optional().describe("Ahorro disponible para la cuota inicial, tal como lo dijo"),
      capacidadMensual: z.string().optional().describe("Cuánto podría destinar mensualmente, tal como lo dijo"),
      ingresosMensuales: z.string().optional().describe("Ingresos mensuales aproximados, tal como los dijo"),
      tipoEmpleo: z.string().optional().describe("Empleado, autónomo/independiente, u otro"),
      antiguedadLaboral: z.string().optional().describe("Tiempo en su trabajo actual"),
      plazoCompra: z.string().optional().describe("Cuándo quiere comprar (ya, en 1-2 años, etc.)"),
      entregaInmediataOFutura: z.string().optional().describe("Prefiere entrega inmediata o sobre planos/a futuro"),
      compraSoloOAcompanado: z.string().optional().describe("Si compra solo o acompañado (pareja, familia)"),
      // Cita agendada (Outlet o videollamada) — llenalo SIEMPRE que confirmes
      // una fecha/hora con el cliente, para que el recordatorio automático del
      // día anterior funcione. citaFecha en formato YYYY-MM-DD.
      citaTipo: z.enum(["outlet", "videollamada"]).optional().describe("Tipo de cita agendada, si aplica"),
      citaFecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "usa YYYY-MM-DD").optional().describe("Fecha de la cita en formato YYYY-MM-DD"),
      citaHora: z.string().optional().describe("Hora de la cita, tal como se la confirmaste al cliente (ej. '16:00', '4pm')"),
    }),
    execute: async ({
      name, contact, intent, notes,
      ciudadResidencia, ciudadCompra, motivoCompra, ahorroDisponible, capacidadMensual,
      ingresosMensuales, tipoEmpleo, antiguedadLaboral, plazoCompra, entregaInmediataOFutura, compraSoloOAcompanado,
      citaTipo, citaFecha, citaHora,
    }) => {
      const convId = getConversationId();
      const channelUserId = channelUserIdFromConversationId(convId);
      const leads = new LeadsRepo(new Db(env.DB), env);
      const metadata: Record<string, string> = {};
      if (ciudadResidencia) metadata.ciudadResidencia = ciudadResidencia;
      if (ciudadCompra) metadata.ciudadCompra = ciudadCompra;
      if (motivoCompra) metadata.motivoCompra = motivoCompra;
      if (ahorroDisponible) metadata.ahorroDisponible = ahorroDisponible;
      if (capacidadMensual) metadata.capacidadMensual = capacidadMensual;
      if (ingresosMensuales) metadata.ingresosMensuales = ingresosMensuales;
      if (tipoEmpleo) metadata.tipoEmpleo = tipoEmpleo;
      if (antiguedadLaboral) metadata.antiguedadLaboral = antiguedadLaboral;
      if (plazoCompra) metadata.plazoCompra = plazoCompra;
      if (entregaInmediataOFutura) metadata.entregaInmediataOFutura = entregaInmediataOFutura;
      if (compraSoloOAcompanado) metadata.compraSoloOAcompanado = compraSoloOAcompanado;
      if (citaTipo) metadata.citaTipo = citaTipo;
      if (citaFecha) metadata.citaFecha = citaFecha;
      if (citaHora) metadata.citaHora = citaHora;
      const leadId = await leads.create({
        conversationId: convId,
        name,
        contact: contact ?? phoneFromConversationId(convId) ?? undefined,
        channelUserId,
        intent,
        notes,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      });

      // Optional external export — Pro-tier feature, skipped if no creds
      // (Implementation deferred to Task 7.4 — adds Google Sheets export)

      return { leadId, message: "Lead capturado." };
    },
  });
}
