# Reglas compartidas entre las sesiones «Viventa (bot)» y «Datos de ViveHome»

Las dos sesiones trabajan en este mismo repo. Quien toque la cola de cotizaciones (`src/vivehome/cola.ts`), la propuesta de llamada
(`member/llamada.local.ts`) o la calificación (`src/followup/resumenDia.ts`) debe respetar esto y actualizar este archivo si cambia algo.
Antes de empezar: `git pull origin main` y leer también `member/HISTORIAL-DEL-PROYECTO.md`.

## Quién recibe cotización
- Se cotiza solo cuando terminó las 7 preguntas base de la prospección. Mientras las responde, la cola espera.
- NO se cotiza a: fríos, reportados en Datacrédito sin plan de ponerse al día, números colombianos, quien dijo que no le interesa
  (`dijoQueNo`: «ya no estoy interesado», «no quiere continuar», conversación IG↔WA enlazada), clientes perdidos/cerrados/descartados.
- Calificación (`evaluarCalificacion`): caliente = empleado + ingresos ≥ 1.500 € (suma al co-comprador) + cuota ≥ 400 € + no reportado;
  tibio = ingresos ≥ 1.300 € y cuota ≥ 300 €; frío = ingresos < 1.300 € o cuota < 300 €. Los reportados quedan como máximo en tibio.
  «En cierre» = caliente, ya habló con Maricela y tiene el formulario enviado (estado de Zoho).

## Flujo
1. Los muy calientes (sin reporte) pasan directo a proponer videollamada.
2. Tibios y reportados con plan: primero la cotización (`primero_cotizacion`), luego videollamada (`proponerLlamada`).
3. WhatsApp fuera de las 24 h: solo plantilla aprobada de Meta. Instagram: solo dentro de las 24 h, sin plantillas.
4. Nunca decir «el equipo lo confirma» para agendar: el bot agenda con Cal.com (videollamada de 45 min, un inicio por hora).

## Zoho
- Cada vez que se vuelve a escribir a un cliente que ya está en Zoho queda una nota en su ficha (`notaSeguimientoZoho`), sin decir «bot».
- Clientes nuevos que se suben: tarea para HOY, sin tope de 25. Calientes y «En cierre» siempre ignoran el tope de 25 tareas.
- La subida automática (`viventa_zoho_subida = activo`) sube 3 clientes por pasada de 15 min.

## No pisar
- Las instrucciones del bot viven en D1 `settings.custom_instructions`. No sobrescribirlas completas: hay un guardián
  (`runGuardianInstrucciones`) que avisa si faltan los marcadores de reglas. Respaldar antes de editar.
