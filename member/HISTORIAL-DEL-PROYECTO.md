# Historial del proyecto Viventa (28 de septiembre – 10 de octubre de 2026)

> Bitácora de todo lo que se hizo, en orden. Para saber **cómo está hoy** el bot, lee `ESTADO-DEL-BOT.md`.
> Aquí no hay llaves, ids de Telegram ni números de clientes: el repo es público.

## 28 de septiembre – primeras mejoras del bot
- El bot **ya no se queda mudo** cuando algo falla por dentro (por ejemplo, al recibir una imagen con una pregunta): ahora avisa al dueño con un ticket. También se corrigió el "voseo" (ya no dice "decime").
- **Memoria más larga:** el bot recuerda los últimos 80 mensajes (antes 20), para no olvidar lo hablado con clientes que vuelven.
- Nuevas **fotos automáticas de proyecto** y el dato del descuento del Outlet.
- **Freno urgente:** si el cliente ya tenía historia con Maricela por WhatsApp, el bot se calla y deja que ella responda. Se apaga con el ajuste `mute_clientes_antiguos = '0'`, sin desplegar.
- El bot **no repite** dos veces el mismo "déjame confirmarlo": si ya lo dijo, se queda callado.
- El bot **sabe cuánto tiempo pasó** desde el último mensaje: si pasó un día o más, saluda corto antes de retomar.
- Cuando Maricela manda **notas de voz desde su WhatsApp normal**, el bot las transcribe y las guarda en su memoria (YCloud no entrega el texto de los mensajes escritos desde esa app; es un límite de ellos).

## 5 de octubre – agenda
- **Agenda real con Cal.com:** el bot consulta horarios libres, agenda y cancela videollamadas (hora de España; lunes a viernes de día, y martes y jueves de noche para quien no puede de día).
- **Imagen de disponibilidad** con los horarios ya reservados tachados.

## 6 de octubre – Instagram con Zernio y sistema de atención
- Instagram (`compratucasaconmari`) pasa a atenderse por **Zernio**. El canal oficial de Meta se **apagó** (se había contestado doble en la primera prueba) y se borraron los secretos de Meta del bot.
- El bot ignora los eventos del **otro número** que comparte la cuenta de YCloud (Seguros Naranjo).
- Se creó `ESTADO-DEL-BOT.md` como memoria compartida entre conversaciones.
- **Guion de 12 mensajes** (flexible, no libreto): autorización de datos → nombre → correo → dónde vive → ciudad de interés → para quién → ahora o a futuro → ahorro → valor mensual → trabajo → residencia → cierre. Sin precios hasta el final.
- **Reglas de conducta** puestas en las instrucciones del bot (en la base de datos): un mensaje corto y una sola pregunta por turno; "casa" como palabra genérica; nada de "no veo proyectos" ni "te aviso"; tono cercano usando el nombre con moderación; los referidos de MamaOli son solo contexto interno y el bot nunca habla de publicidad.
- **Aviso a Camila** por Telegram/correo con la ficha completa del lead cuando el bot termina el guion.
- **Seguimientos automáticos:** a las ~20–23 h si el cliente dejó el guion a medias, y a las 48 h si ya recibió los proyectos y no respondió.
- **Recordatorios de videollamada** al cliente 24 h y 1 h antes, y **resumen del lead para Maricela** una hora antes.

## 7 de octubre – costos, audios, caída y ajustes
- **Costos:** caché de 1 hora para la parte grande del prompt y caché del historial. Se verificó el precio real: Sonnet 5 y 5.5 cuestan igual ($2/$10 por millón). Se corrigió el contador interno, que sobreestimaba el gasto en 50 %. Medida: ~2,5 centavos por respuesta.
- **Modelo:** se probó **Claude Sonnet 5.5** (esfuerzo medio), con red de seguridad: si el modelo falla, usa al instante el normal. Se corrigió que a veces repetía una frase antes y después de una herramienta.
- **Audios:** tres causas distintas, todas arregladas y probadas con audios reales:
  - WhatsApp: YCloud exige el enlace firmado completo para descargar.
  - Instagram: Meta devolvía una página web si no se identificaba como navegador.
  - Formato MP4 de Instagram: se transcribe con un servicio que sí lo entiende, con otros dos de respaldo.
- **Pareo con Forja:** el bot aparece en el panel de Forja.
- **Conversación menos robótica:** se quitó la repetición del nombre del cliente y de "Gracias/Perfecto".
- **Caída de la base de datos (19:09–19:30 UTC):** una consulta de los seguimientos leyó 6,3 millones de filas y D1 bloqueó el bot y el panel. Se corrigió la consulta, se pasó a un cron más espaciado, se pagó el plan Workers Paid de Cloudflare y se reprocesaron los mensajes perdidos. Un test impide que vuelva a pasar.
- **Identidad:** el bot se presenta como "el equipo comercial de Maricela" y no dice por su cuenta que es un asistente virtual; si el cliente le pregunta de frente, responde con honestidad.
- Se actualizó `ESTADO-DEL-BOT.md`.

## 8 de octubre – informes, Zoho y pedido de datos
- Se generaron Excel con los clientes del día (teléfonos y correos en columnas separadas, hojas por día y de Instagram sin teléfono).
- El bot **pide el teléfono solo en Instagram** (en WhatsApp ya lo tiene) y, con el texto de Maricela, escribió a los clientes de Instagram que no lo habían dado (de a 5 cada 15 min, 9–21 h de España).
- **Avisos a Camila y Maricela por Telegram** configurados, con el canal del cliente (WhatsApp con teléfono, Instagram con perfil). El panel de tickets también muestra el canal.
- **Resumen diario de las 8:00** con los leads ordenados por prioridad (🔥/🟡/⚪).

## 9 de octubre – registro en Zoho por formulario
- Maricela registra cada cliente en el formulario de Zoho: el bot le manda un **enlace con los datos ya escritos**, al instante y en el resumen. Funcionó: 13 clientes creados en 2 minutos.
- Comandos de Maricela al bot de Telegram: `registrado <nombre>`, `existente <nombre>`, `pendientes`. Se marcaron los clientes que ella señaló en verde (ya creados) y rojo (ya existían en el sistema).
- El bot **pide por mensaje los datos que faltan** para el formulario (apellido, teléfono, ciudades) y avisa cuando el cliente los completa.
- Guion de **13 mensajes**: se añadió la pregunta de ingresos mensuales. Nuevo **comodín**: cuando el bot no sabe responder, usa el mensaje de Maricela, avisa al equipo y se pausa.
- **Reintento automático** cuando Anthropic falla (a los 3 y 10 min) y registro del error real en la tabla `ai_fallos`.

## 10 de octubre
- **Excel de clientes listos a las 6:00 y 14:00 de España** por Telegram (con enlace del formulario por fila). Sin correo, se usa uno inventado con dominio inexistente y marcado como tal (pedido de Maricela).

- **Videollamada agendada por el bot:** Maricela pidió que el bot agende solo las llamadas con calientes y tibios (10:00–16:00 España, 30 min, 4 horarios por día, otro horario → comodín). Se conectó Cal.com al Google Calendar de Maricela y se construyó el flujo completo con **botones tocables** (día → hora, más horarios, otro día, horario nocturno martes y jueves 18:00–20:00), confirmación con enlace de Google Meet y hora local del cliente si vive fuera de España. Se probó con una cuenta de Instagram de prueba y se activó el mismo día; el primer cliente real agendó esa tarde.
- **Errores encontrados y arreglados el mismo día:** el bot a veces mandaba solo «Listo, ya quedó guardado» a mitad del guion (regresión; solo 2 casos, ya calificados); el bot recordaba el idioma equivocado por datos viejos del cliente; el modelo cerró un turno sin escribir tras reservar (ahora la confirmación con el enlace está garantizada en código); ticket duplicado tras agendar; la imagen de horarios decía 15 min en lugar de 30.
- **Recordatorios:** 24 h con botones «Confirmo / Reprogramar», 1 h antes; ambos con el enlace y la hora local.
- **Resumen de las 8:00** con la línea «llamadas que agendó el bot vs. comodín».
- **Oferta a clientes ya calificados:** mensaje único con botones de día a 12 clientes con ventana abierta; plantilla de WhatsApp `viventa_oferta_llamada` enviada a Meta para otros 11 que ya pasaron de 24 h. Excel con los 21 sin ventana entregado a Brayan.
- **Costo medido:** ~1,6 centavos de dólar por respuesta (≈25 centavos por cliente que completa el guion); 97 % del prompt va en caché.
- **Cal.com:** cuenta renombrada a «Maricela Naranjo», ubicación Google Meet; pendiente que Maricela verifique su correo como principal.

## Pendiente (resumen; el detalle está en `ESTADO-DEL-BOT.md`)
1. Revisar que llegaron los primeros Excel de las 6:00/14:00 y cómo contestan los clientes a los pedidos de datos.
2. Plantillas de WhatsApp aprobadas en YCloud (seguimientos y recordatorios fuera de 24 h).
3. Aprobación de la plantilla `viventa_oferta_llamada` y envío a los 11 de WhatsApp; verificar cuántas llamadas agenda el bot; nota de voz de Maricela tras cada llamada.
4. Seguridad: restablecer claves de Instagram en Meta y de Cal.com, y cerrar sesiones de Forja desconocidas.
5. Medir costo con Sonnet 5.5, lecturas de la base de datos y fallos de IA (`ai_fallos`); reconectar el permiso de Zernio antes del 5 de diciembre de 2026.

- **CRM · Resultado de la llamada (10 oct 2026):** en la ventana de cada videollamada del calendario, Maricela pega o sube (.txt/.vtt/.srt) la transcripción; la IA devuelve resultado (se concretó / parcial / no / sin respuesta), resumen, qué se concretó y qué no, objeciones, interés 1-5, próximo paso y pendientes (checklist, también visible en la ficha del cliente). Archivo `member/crm-resultados.local.ts`; tablas `crm_llamada_resultado` y `crm_pendientes`. Nombres/teléfonos/correos se anonimizan antes de enviar a la IA.

- **CRM · Pipeline (10 oct 2026):** sección «Pipeline» (`member/crm-pipeline.local.ts`): tablero de 7 etapas (Nuevo, Calificado, Llamada agendada, Llamada hecha, Negociando, Cerrado, Perdido). La etapa se calcula sola (datos del cliente, llamada agendada/pasada, resultado de la llamada analizada) y Maricela puede arrastrar o usar el selector; lo manual se guarda en `conversations.metadata.crm_etapa` y manda («Volver a automático» lo quita). Al interpretar una llamada el cliente avanza solo (concretado/parcial → Negociando; otro → Llamada hecha), salvo que esté Cerrado/Perdido a mano.

- **CRM · Fathom automático (10 oct 2026):** `POST /webhooks/fathom` (`member/crm-fathom.local.ts`). Fathom (cuenta gratis de Maricela, ligada a su Google Calendar) manda la transcripción al terminar la llamada; firma Standard Webhooks verificada con el secreto `FATHOM_WEBHOOK_SECRET` (`whsec_…`, secreto de Worker); se empareja con la cita por hora (±90 min) y correo; se analiza sola (resultado, pendientes, etapa del pipeline) y se avisa por Telegram. Tabla `crm_fathom` evita duplicados. Responde 503 hasta que exista el secreto.

- **CRM · Nota y tarea para Zoho (11 oct 2026):** en la ficha de cada cliente, tarjeta «📋 Nota y tarea para Zoho» (`member/crm-zohonota.local.ts`, tabla `crm_zoho_notas`): mini resumen (IA, sin nombre/teléfono/correo) + tarea (regla: llamada agendada → «Videollamada programada — fecha»; llamada hecha → su primer pendiente; si no, la sugiere la IA), con botón Copiar. Se carga sola al abrir la ficha y solo se regenera si hay novedades. Subirlo directo a Zoho por API queda pendiente (requiere acceso API de Zoho).

- **CRM · Por agendar (11 oct 2026):** sección «Por agendar» (`member/crm-poragendar.local.ts`): todas las personas sin videollamada agendada (calientes y tibios; fríos opcional), con motivo: propuso horario (heurística por días/horas en sus mensajes, se muestra el mensaje), sin contactar (con teléfono y sin conversación de WhatsApp), en conversación, sin respuesta reciente, solo Instagram sin teléfono. Une Instagram y WhatsApp por los últimos 9 dígitos del teléfono (antes la lista de «no contactados» ignoraba que Maricela ya había escrito por WhatsApp). Citas canceladas vuelven a la lista; cerrado/perdido a mano se excluye. Excel incluido.

- **CRM · Agendar llamada manual (11 oct 2026):** pantalla `/crm/agendar` (`member/crm-agendar.local.ts`, botón en el Calendario) para llamadas que Maricela acordó por su cuenta: resumen con hora en España/Colombia, disponibilidad real en Cal.com, cliente encontrado por teléfono/correo, y 3 modos: Cal.com sin avisar al cliente (correo de relleno `@correo-no-proporcionado.invalid`; recomendado, evita segunda invitación con otro Meet), Cal.com avisando al cliente, o solo CRM. Reutiliza `agendarCita`; en modos sin aviso suprime confirmación y recordatorios por WhatsApp. Acepta datos por URL (`?nombre=&correo=&tel=&fecha=YYYY-MM-DD&hora=HH:MM&zona=madrid|colombia`).

- **CRM · Clasificar en «Por agendar» (11 oct 2026):** cada persona tiene «Clasificar ▾»: Ya está agendada (abre Agendar llamada manual precargada), Recontactar más adelante (fecha; vuelve sola a la lista), No está interesado, No quiso agendar, Número perdido/no responde (estas tres la pasan a «Perdido» en el Pipeline). Se guarda en `conversations.metadata.crm_descarte` en todas las conversaciones de la persona (IG + WhatsApp por teléfono). Pestaña «🗂 Descartados» con «↩ Reactivar».

- **Bot · Guion de 9 preguntas, sin emojis (12 oct 2026):** las instrucciones del bot (D1 `settings.custom_instructions`) pasaron de 13 a 10 mensajes (autorización, nombre+correo [+WhatsApp solo en Instagram], país/ciudad+ciudad de compra, para quién, cuándo, ahorro, mensual, trabajo+ingresos, residencia, cierre) con el orden de Maricela. Sin emojis por defecto (se quitaron de todos los ejemplos). Si el cliente contesta solo una parte no se repite la pregunta; al final, una sola vez, un mensaje con los datos OBLIGATORIOS que faltan (los demás los completa Maricela en la videollamada). Copia anterior: `settings.custom_instructions_respaldo_2026-10-12` (para volver atrás: copiar su valor a `custom_instructions`).

- **Bot · Limpieza de instrucciones (12 oct 2026):** se quitaron ~6.800 caracteres de `custom_instructions` (41.958 → 35.184) que ya no se usaban: Outlet del 3-4 oct, horarios del Outlet, «Agenda Fase 4», costos del acompañamiento, catálogo/búsqueda de proyectos, fotos de proyectos, geografía, y las líneas de emojis moderados. Se mantuvo todo el flujo de preguntas, videollamada, recordatorio, silencio/handoff, MamaOli y centrales de riesgo. Copia previa: `settings.custom_instructions_respaldo_2026-10-12b`. Pendiente por decidir: campañas de un solo uso (teléfono 8 oct, datos de registro 9 oct) y limitar el historial que lee el bot (hoy hasta 80 mensajes).

- **Bot · Toda la información primero, después el agendamiento (13 oct 2026):** caso Carolina Guerrero (Instagram): un envío automático («Quiero llamarte mañana…», `runPedirTelefono`) le habló de una llamada antes de terminar el guion y el bot cerró con «estate atento a la llamada» sin pedir los datos ni agendar. Cambios: (1) `runPedirTelefono` apagado en `runSistemaViventa` (el guion nuevo pide el teléfono en el mensaje 2); (2) instrucciones: regla «TODA LA INFORMACIÓN PRIMERO, DESPUÉS EL AGENDAMIENTO» (sin handoffHuman/pauseBot ni «el equipo te escribirá» mientras falten datos obligatorios, salvo que pida una persona o esté molesto) y reglas de precios / «no sé responder» ya no pasan el caso antes de tiempo; (3) respuesta al teléfono/hora ahora sigue el guion hasta agendar. Copias: `custom_instructions_respaldo_2026-10-13` y `…-13b`. Pendiente por decidir: ofrecer videollamada también a clientes «fríos» con la información completa; error de puntaje: la nota «Hora de llamada pedida: no indicada» suma 1 punto por error.

- **Bot · Videollamada para todos (13 oct 2026):** `proponerLlamada` ya no descarta a los clientes «fríos»: la oferta de videollamada va a todo el que termina el guion (pedido del dueño). Se corrigió además el puntaje (`horaDeLlamadaPedida`: «no indicada» no suma). Instrucciones actualizadas; copia previa `custom_instructions_respaldo_2026-10-13c`.

- **CRM · Seguimientos de hoy, fase 1 (13 oct 2026):** sección «Seguimientos» (`member/crm-seguimientos.local.ts`, conexión en `member/crm-zohoapi.local.ts`). Lee de Zoho (Self Client; secretos `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`) las tareas de Maricela con fecha de hoy o anterior que no están «Completa» (solo módulo Candidatos; los clientes que reservaron están en Oportunidades). «Preparar mensaje» (1 llamada de IA por candidato, ~0,02 USD, guardada 12 h en `crm_seg_borrador`) lee la NOTA de Zoho y la conversación del bot (anonimizadas) y propone: temperatura (la deduce de la nota), acción (WhatsApp / videollamada si ya recibió proyectos / cerrar si compró o pidió no ser contactado), mensaje, nota nueva y fecha de la siguiente tarea (caliente 2-3 días, tibio 5-7, frío 14); con ingresos < 1.250 € recomienda segundo titular. SOLO BORRADORES: no envía ni cambia nada en Zoho. Falta para activarlo: código nuevo del Self Client con permisos `notes.READ` y `users.READ`. Fase 2 (con aprobación): marcar la tarea «Completa», crear la siguiente en «En Proceso» y la nota.

- **Agenda · Días bloqueados (14 oct 2026):** ajuste `viventa_dias_bloqueados` (fechas YYYY-MM-DD separadas por coma). `src/integrations/calcom.ts` (`diasBloqueados`): en esos días no se devuelven horarios (bot, ofertas de videollamada, agenda manual del CRM) y `createBooking` se niega (`dia_bloqueado`). Las citas que ya existían no se tocan. Activo para el jueves 15 oct 2026 (Maricela solo atiende a la persona ya agendada). Para quitarlo: vaciar el ajuste o borrar la fecha. Ojo: no bloquea reservas directas por el enlace público de Cal.com (hay que marcar el día no disponible en Cal.com / Google Calendar).
- **Seguimientos · fallo de la IA (14 oct 2026):** «La IA no devolvió un mensaje claro» en casi todos los candidatos: el tope de 900 tokens de salida se acababa razonando y el JSON llegaba cortado. Subido a 4.000 (también «nota Zoho» 700→3.000 y «resultado de la llamada» 1.600→4.000, que tocaban su tope a veces).

- **Seguimientos · botón al panel de Forja (14 oct 2026):** Maricela escribe desde el panel de Forja, no desde WhatsApp. «Preparar mensaje» ahora muestra «Abrir la conversación en el panel de Forja»: abre `/admin/conversations?c=<id>&texto=<mensaje>` (el panel pone el texto en la caja de respuesta; `src/admin/routes.ts`) y lo copia al portapapeles. La conversación se busca por teléfono (últimos 9 dígitos). Si el candidato no tiene conversación en el panel queda el respaldo de wa.me, avisando por qué.

- **Seguimientos · la tarea manda (14 oct 2026):** el mensaje ahora debe lograr lo que dice el asunto de la tarea de Zoho (p. ej. «Confirmar si desea agendar la videollamada»), y el borrador trae también el asunto de la SIGUIENTE tarea (`tareaSiguiente`) además de la nota y la fecha. Los borradores guardados sin ese campo se rehacen.

- **Seguimientos · «Revisar en el futuro» (14 oct 2026):** regla de Maricela: con MÁS DE 3 intentos de contacto sin respuesta (la IA los cuenta en las notas) la acción es `futuro`: se propone pasar el candidato al estado «Revisar en el futuro» de Zoho (por ahora a mano; en fase 2 hará falta el permiso `ZohoCRM.modules.leads.UPDATE`), un último mensaje amable opcional y NINGUNA siguiente tarea: al pasar a ese estado Zoho mismo crea la tarea de dentro de 3 meses (lo confirmó Maricela el 14 oct).

- **Seguimientos · fase 2, actualizar Zoho (14 oct 2026):** botón «Ya lo envié: actualizar Zoho» en cada borrador (`aplicarEnZoho`, `member/crm-seguimientos.local.ts`; escritura en `member/crm-zohoapi.local.ts`). Pide confirmación y, para ESA tarea y ESE candidato: 1) crea la nota, 2) crea la siguiente tarea «En Proceso» a nombre de Maricela (según temperatura), 3) marca la tarea de hoy «Completa»; con «futuro» cambia el estado a «Revisar en el futuro» (Zoho programa la tarea a 3 meses) y con «cerrar» solo nota + completar. Nunca borra. Acción, candidato y días salen del borrador guardado en el servidor; si un paso falla, lo ya hecho no se repite al reintentar (`crm_seg_hecho`); si la tarea ya estaba completa no cambia nada. **APAGADO por defecto**: solo escribe con el ajuste `zoho_escritura = activo` (D1). Para activarlo hace falta un código nuevo del Self Client con el permiso `ZohoCRM.modules.leads.UPDATE` (además de los de lectura/tareas/notas ya concedidos) y una prueba con UNA tarea real aprobada por Maricela.

- **Seguimientos · «Cliente perdido» y «Descartado» (14 oct 2026):** en Zoho esos dos estados piden un MOTIVO (listas distintas), no dejan tarea y solo dejan nota; se usan cuando el cliente pide que no lo llamen, ya compró o ya no quiere comprar. La acción «cerrar» se reemplazó por `perdido` / `descartado` con `motivoCierre` (lista en `MOTIVOS_PERDIDO` / `MOTIVOS_DESCARTADO`, vista en la pantalla de Maricela; puede faltar alguna opción escondida arriba del desplegable). La tarjeta muestra un selector de motivo. La escritura en Zoho de estos dos estados necesita los nombres de los campos «Motivo» (ajustes `zoho_campo_motivo_perdido` / `zoho_campo_motivo_descartado`): sin ellos NO hace nada a medias y avisa que se cambie a mano. Pendiente: leerlos de Zoho con el permiso `ZohoCRM.settings.fields.READ` (en el código nuevo del Self Client).

- **Zoho · permisos nuevos y campos reales (14 oct 2026):** Self Client con `leads.UPDATE` y `settings.fields.READ` (clave nueva guardada como secreto). Leído por la API: estados de Candidato (`Lead_Status`: «Cliente perdido», «Descartado», «Revisar en el futuro», «Abierto primer/segundo/tercer/cuarto intento», «Nunca respondió», «Sin contacto»…) y el campo `motivo` (un solo picklist para perdido y descartado; los valores son exactos, p. ej. «Desistio compra» sin tilde). `CAMPO_MOTIVO = "motivo"`. La escritura sigue APAGADA (`zoho_escritura`); falta una prueba supervisada con UNA tarea. Riesgo a vigilar: si el cambio de estado es una transición de Blueprint/Canvas en Zoho, la API podría rechazarlo (el sistema muestra el error y no repite lo ya hecho).

- **Seguimientos · último mensaje en «Cliente perdido» (14 oct 2026, pedido de Maricela):** «perdido» ahora trae un ÚLTIMO mensaje breve y cálido que deja la puerta abierta por si el cliente quiere retomar (opcional, se puede editar); «descartado» nunca escribe. Siguen sin dejar tarea (solo nota).
- **Bot · instrucciones sin campañas viejas (14 oct 2026):** se quitó «TELÉFONO SOLO EN INSTAGRAM» (8 oct, ya cubierto por el guion de 9 preguntas) y se redujo la respuesta al pedido de teléfono/hora a una versión corta. Se mantienen «Datos para el registro» y «Oferta de llamada», porque sus envíos automáticos siguen activos. Copia previa: `custom_instructions_respaldo_2026-10-14`.
