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
