// member/tools.local.ts — TUS funciones extra del bot ("tools").
//
// Esta carpeta (member/) es TUYA: las actualizaciones (`forjabot update`) NUNCA
// la tocan. Todo lo que definas aquí SOBREVIVE cada actualización, ya conectado
// (a diferencia de editar src/, que el update reemplaza).
//
// Devuelve un objeto { nombreDeLaTool: tool(...) }. Déjalo vacío ({}) para no
// agregar ninguna. Para escribir una sin programar, usa el skill /agregar-tool.
//
// Para agregar una tool, importa los helpers y regrésala:
//   import { tool } from "ai";
//   import { z } from "zod";
//
// `ctx.env` = variables/bindings del bot; `ctx.getConversationId()` = la
// conversación en curso.
import type { MemberToolCtx } from "../src/tools/member";
import { calcomConfigured } from "../src/integrations/calcom";
import { verDisponibilidadTool, agendarCitaTool, cancelarCitaTool } from "../src/tools/servicios";

// El giro "inmobiliaria" no trae agendarCita/verDisponibilidad de fábrica (esas
// tools son de los giros de cita — barbería, spa, dentista…). Viventa SÍ agenda
// videollamadas/visitas, así que las reactivamos acá reusando el mismo cliente
// de Cal.com ya construido en src/integrations/calcom.ts — sin tocar src/.
export function memberTools(ctx: MemberToolCtx): Record<string, unknown> {
  if (!calcomConfigured(ctx.env)) return {};
  return {
    verDisponibilidad: verDisponibilidadTool(ctx.env, ctx.getConversationId),
    agendarCita: agendarCitaTool(ctx.env, ctx.getConversationId),
    cancelarCita: cancelarCitaTool(ctx.env, ctx.getConversationId),
  };
}
