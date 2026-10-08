# Historial del proyecto Viventa (28 de septiembre – 8 de octubre de 2026)

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

## 8 de octubre – revisión
- Se revisó que **los audios funcionan** (sin fallos desde el arreglo). Las **imágenes** se reciben y se guardan, pero falta una prueba real para confirmar que el bot las interpreta bien. Los **documentos/PDF** no se leen: los revisa una persona.
- Se creó este historial.

## Pendiente (resumen; el detalle está en `ESTADO-DEL-BOT.md`)
1. Que Camila y Maricela le escriban al bot de Telegram para configurar sus avisos.
2. Plantillas de WhatsApp aprobadas en YCloud (seguimientos y recordatorios fuera de 24 h).
3. Seguridad: restablecer claves de Instagram en Meta y de Cal.com, y cerrar sesiones de Forja desconocidas.
4. Medir en 2–3 días: lecturas de la base de datos, caché y costo con Sonnet 5.5.
5. Prueba real de imagen; CRM para estatus migratorio y ahorros; lista de clientes ya conocidos; reconectar el permiso de Zernio antes del 5 de diciembre de 2026.
