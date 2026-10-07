# Estado del bot de Viventa (memoria compartida entre conversaciones)

> Léelo antes de tocar nada. Última actualización: 7 de octubre de 2026.
> Aquí **nunca** va el valor de una llave. Solo nombres y dónde viven.
> El repo es **público**: no subas `.env`, tokens, ids de Telegram, números de clientes ni la licencia de Forja.

## Quién es quién
- **Viventa:** ayuda a colombianos que viven fuera a comprar vivienda en Colombia.
- **El bot** se presenta como **"el equipo comercial de Maricela Naranjo"** (en plural) y **no dice por iniciativa propia que es un asistente virtual, bot o IA** (pedido de Brayan, 7 de octubre). No se hace pasar por Maricela ni por una persona, y **si el cliente pregunta directamente si habla con una persona, un bot o una IA, responde con honestidad** (nunca lo niega): es un límite deliberado, también por transparencia frente a los clientes en España/UE. No nombra a Camila en los mensajes: habla del "equipo comercial de Maricela".
- **Camila** (equipo comercial) recibe el lead calificado y envía los proyectos. **Maricela** hace la videollamada de cierre.
- **Brayan:** dueño y quien pide los cambios. No es técnico: español neutro, sencillo, sin tecnicismos. Pide confirmación antes de desplegar, de subir a GitHub o de cambiar algo de producción.

## Dónde vive todo
- Worker de Cloudflare: `forja-inmobiliaria-8664f4` (`https://forja-inmobiliaria-8664f4.brayan0030101.workers.dev`).
- Base de datos D1: `horizontes_bot_inmobiliaria_8664f4_db`. Panel: `/admin`. El bot está **pareado** con el panel de Forja (`app.forjabots.com`) desde el 7 de octubre.
- Repo: `github.com/brayan0030101-tech/Viventa-`, rama `main` (público).
- Desplegar: `pnpm run deploy` (no `pnpm deploy`). Comprobar: `npx tsc --noEmit` y `npx vitest run`. Ver registros: `npx wrangler tail forja-inmobiliaria-8664f4`.
- Cloudflare: la sesión necesita `CLOUDFLARE_API_TOKEN` en el entorno (menú del entorno → Editar). Una variable nueva solo la ve una sesión nueva. La llave de la sesión **no** tiene permiso de Workers AI ni de registros: los errores reales se ven con `wrangler tail`.
- **Ajustes que NO están en git** (viven en la base D1 y se cambian sin desplegar): `custom_instructions` (las reglas del bot, ~28 mil caracteres), `max_chunks = 1` y `llm_model`. Antes de cambiar las instrucciones, léelas, edita solo la parte que toca y guarda copia de seguridad (ver "Cómo cambiar las instrucciones").
- **Cuenta de Cloudflare en plan Workers Paid** (desde el 7 de octubre). Antes estaba en el plan gratis y el límite diario de 5 M de lecturas de D1 tumbó el bot y el panel (ver "Lecciones").

## Modelo de IA y costos
- Modelo en uso: **Claude Sonnet 5.5** (`llm_model = claude-sonnet-5-5` en D1). Para volver a Sonnet 5: borrar esa fila (`DELETE FROM settings WHERE key='llm_model'`), sin desplegar. Hay red de seguridad: si el modelo elegido da 400/403/404, usa al instante el modelo normal.
- `ANTHROPIC_EFFORT = "medium"` (esfuerzo de razonamiento, solo para modelos 5.5). Sonnet 5 y 5.5 cuestan lo mismo ($2 entrada / $10 salida por millón); cambiar de modelo no ahorra, solo cambia calidad y tokens. Precios internos en `src/pricing.ts`.
- **Caché de prompts:** punto de caché en el bloque grande (`PROMPT_CACHE_TTL = "1h"`) y otro en el último mensaje del historial (los pasos con herramientas y los turnos seguidos leen el historial a 0,1×). Código en `src/llm/cache.ts`. Si el tráfico baja, volver a `"5m"`.
- Con Sonnet 5.5 el modelo a veces repetía una frase antes y después de una herramienta; se corrigió enviando solo el texto del **último** paso (`src/agent.ts`).
- Medida de referencia (6 oct): ~2,5 centavos por respuesta, ~75–80 % de la entrada leída desde caché.

## Canales
| Canal | Cómo entra | Detalle |
|---|---|---|
| WhatsApp | YCloud, número `+34611688609` (`YCLOUD_WA_FROM`) | Webhook `/webhooks/ycloud`. La cuenta de YCloud es **compartida** con otro bot (Seguros Naranjo, `+34603039032`): `isForThisNumber` en `src/channels/ycloud.ts` descarta eventos y ecos de otro número. No cambiar el webhook ni la API key de YCloud sin que Brayan lo pida. |
| Instagram | Zernio, cuenta `compratucasaconmari` | Webhook `/webhooks/zernio`. El camino oficial de Meta quedó **apagado** con `IG_OFFICIAL = "off"`. Funciona con cuentas sin rol en Meta. |

Lección: antes de conectar un canal nuevo, presentar las opciones (Meta directo, Zernio, ManyChat) y dejar que Brayan elija. Guía: `skill/references/channel-setup-guides/_elegir-canal-y-metodo.md`.

### Audios y fotos de clientes (arreglado el 7 de octubre; verificado con audios reales)
- **WhatsApp (YCloud):** el enlace de descarga del evento lleva una firma (`?sig=…&payload=…`); descargar solo con el id da error. El proxy firmado `/webhooks/ycloud/media/:id` ahora recibe el enlace completo (`src`, solo `api.ycloud.com`, firmado) y lo baja con `X-API-Key`.
- **Instagram (Zernio):** el audio llega como MP4/AAC desde `lookaside.fbsbx.com`. La CDN de Meta responde una **página HTML** si la petición no trae `User-Agent` de navegador. `src/lib/media-fetch.ts` (`fetchMedia`) lo manda; úsalo para cualquier descarga de medios de clientes.
- **Transcripción** (`src/media/transcribe.ts`): MP4/AAC → Deepgram Nova-3 primero; ogg/mp3/wav → Whisper primero; el otro de respaldo; OpenAI solo si hay `OPENAI_API_KEY`. Whisper de Workers AI no decodifica MP4 (error 3030).
- Los ~190 audios fallidos entre el 25 de septiembre y el 7 de octubre quedaron como "(no pude entender el audio)" y no se reprocesan.

## Agenda con Cal.com
- Tipo de evento `7227219`, "Videollamada Viventa", 15 minutos. Zona horaria `Europe/Madrid` (hora española; **solo horario español**, decisión de Brayan).
- Horario de Maricela: lunes a viernes de 10 a 16 h. Martes y jueves de 18 a 20 h **solo** como bloque nocturno para quien no puede de día.
- Herramientas: `verDisponibilidad`, `agendarCita`, `cancelarCita` (vía `member/tools.local.ts`). Cal.com rechaza correos falsos tipo `example.com`.
- Imagen de disponibilidad con horarios tachados: marcador `[[disponibilidad]]` (modo día o `noche`), ruta firmada `/disponibilidad.png`.
- Las citas reservadas son leads "Cita ·" con `metadata.calStart` (instante exacto) y `estado = "Reservada (Cal.com)"`.

## Sistema de atención (fases) y automatismos
- **Fase 1–2 (bot):** guion de 12 mensajes **como plantilla flexible**, no libreto: autorización de datos → nombre y apellido → correo → país y ciudad donde vive → ciudad de interés → para quién → ahora o a futuro → ahorro → valor mensual → situación laboral → situación de residencia → cierre. Una pregunta por mensaje, sin precios. Datos delicados (ahorro, migración) solo con confianza.
- **Cierre del guion:** `captureLead` + `handoffHuman` con motivo "Lead calificado: enviar proyectos". Estatus migratorio y autorización van en `notes` del lead (aún no hay campos propios; temporal).
- **Fase 3 (Camila):** envía máximo 3 proyectos desde la app de WhatsApp (queda como mensaje `owner` tras el traspaso). Seguimiento del bot a las 48 h sin respuesta.
- **Fase 4 (Maricela):** videollamada. Recordatorios al cliente 24 h y 1 h antes (hora de España) y resumen del lead para Maricela ~1 h antes.
- **Código:** `src/followup/sistemaViventa.ts` (cron, ver abajo), `src/lib/camila.ts` (avisos al equipo + ficha del lead). El recordatorio diario viejo (`appointmentReminder.ts`) quedó solo para el Outlet.
- **Cron:** corre cada 15 min (dentro del cron de 5 min). Seguimiento del guion entre 20 h y 23,5 h sin respuesta (no a las 24 h: la ventana de WhatsApp se cierra). **Nunca** usar subconsultas correlacionadas por conversación ahí (ver "Lecciones").
- **Avisos al equipo:** `CAMILA_TELEGRAM_CHAT_ID` (secreto) admite **varios ids separados por coma** (Camila y Maricela). Falta que ellas le escriban al bot de Telegram para obtener sus ids (aparecen como conversaciones `telegram:<id>` en D1). `CAMILA_EMAIL` opcional (Resend; el remitente de prueba solo entrega al dueño de la cuenta). Mientras no estén configurados, los avisos van solo al dueño.
- **Plantillas de WhatsApp pendientes** (fuera de las 24 h Meta solo permite plantillas aprobadas): se crean en el panel de YCloud y sus nombres van en las filas de D1 `viventa_tpl_seguimiento`, `viventa_tpl_recordatorio` y `viventa_tpl_lang` (por defecto `es`). Sin ellas, esos mensajes no se envían y se avisa al equipo y al dueño.
- **Referidos de MamaOli (@mamaoliolaya):** solo contexto interno. El bot nunca habla de publicidad ni cuenta la historia de Oli; anota el origen en el lead.

## Reglas de conducta del bot (dichas por Brayan y Maricela)
Viven en D1 (`custom_instructions`; valen para WhatsApp **e** Instagram siempre) y `max_chunks = 1`. Las reglas nuevas van en bloques con fecha al final del texto y mandan sobre las viejas.
1. **Un solo mensaje por turno**, corto (máx. ~3 renglones), y esperar la respuesta. **Una sola pregunta por turno.**
2. **Nunca** "eso me lo confirma el equipo" ni "ya te aviso". Excepción única: el mensaje de precios, el comodín y los de pasar el caso, escritos en el guion.
3. **Precios solo al final**, tras tener los datos y explicar los beneficios. Si preguntan antes, decir con calidez que el equipo comercial lo explica en detalle y seguir con la siguiente pregunta; si insisten, `handoffHuman`.
4. **"Casa" es genérico** (casa o apartamento). Nunca "no hay casas".
5. **Durante la calificación no habla de disponibilidad de proyectos:** nada de "no veo proyectos" ni "te aviso cuando haya algo" (suena a despedida). Dice que el equipo comercial evaluará las mejores opciones y oportunidades para sus necesidades y sigue con las preguntas. No usa `searchKb` en esa fase.
6. **Tono cercano:** el nombre del cliente con mucha moderación (máx. una vez al conocerlo y quizá al despedirse; nunca en mensajes seguidos); no empezar mensajes seguidos con "Gracias"/"Perfecto"; reaccionar de forma breve y genuina; emojis moderados.
7. Si piden hablar con una persona o se frustran → `handoffHuman` de inmediato. No promete hipoteca, rentabilidad ni fechas de entrega. Datos legales los confirma Maricela o su abogado.

### Cómo cambiar las instrucciones
Leer `SELECT value FROM settings WHERE key='custom_instructions'` (wrangler d1 execute --remote --json), guardar copia, editar solo el bloque que toca, y escribir con `UPDATE ... updated_at = <ms>`. El bot las lee en vivo (sin desplegar).

## Llaves (solo nombres; valores nunca)
Viven como secretos del worker (`npx wrangler secret list` muestra los nombres): la llave del modelo de IA, `YCLOUD_API_KEY` y `YCLOUD_WEBHOOK_SECRET`, `CALCOM_API_KEY`, `ZERNIO_API_KEY` y `ZERNIO_WEBHOOK_SECRET`, `META_VERIFY_TOKEN`, `TELEGRAM_*`, `OWNER_TELEGRAM_CHAT_ID`, `CONTROL_PLANE_TOKEN` y `CONTROL_PLANE_URL` (los puso `forjabot pair`), la contraseña del panel. Los secretos de Instagram con Meta (`INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_APP_SECRET`) se **borraron** del worker.
Para guardar uno: `printf '%s' '<valor>' | npx wrangler secret put NOMBRE`, sin escribirlo en archivos ni en el chat.

## Lecciones (no repetir)
- **Límite de D1:** el 7 de octubre el bot y el panel cayeron ~20 min al pasar 5 M de lecturas gratis (6,3 M ese día; lo normal era 0,2–0,6 M). Causa: una consulta del cron con `EXISTS` sobre `tickets` (sin índice por conversación) por cada conversación cada 5 min (~60 mil filas por pasada). Regla: en crones, consultas acotadas por índice y cruce en memoria; probar el costo en filas. Hay un test que prohíbe ese patrón. Para ver el consumo: GraphQL `d1AnalyticsAdaptiveGroups` (rowsRead por día).
- **`forjabot update` pisa `src/`** (deja respaldo en `.forja-backups/`). Hay código propio del proyecto que habría que volver a aplicar: `src/lib/camila.ts`, `src/lib/media-fetch.ts`, `src/llm/cache.ts`, `src/followup/sistemaViventa.ts` y retoques en `src/agent.ts`, `src/channels/ycloud.ts`, `src/media/transcribe.ts`, `src/media/vision.ts`, `src/tools/handoffHuman.ts`, `src/followup/appointmentReminder.ts`, `src/pricing.ts`, `src/index.ts`, `src/env.ts`. A 7 de octubre el bot ya estaba en la última versión (1.0.77).
- Las capturas del panel/Instagram: la marca "N mensajes nuevos" de Instagram es *no leído*, no "sin responder". Medir el retraso real en D1 (mediana de respuesta ~5 s).
- Los avisos de Zernio llegan firmados con `ZERNIO_WEBHOOK_SECRET`; para reprocesar mensajes perdidos se puede reenviar un `message.received` firmado con un id propio (`replay-<id>`), así no se duplica.

## Pendientes
1. **Camila y Maricela en Telegram:** que le escriban al bot, leer sus ids en D1 y guardarlos en `CAMILA_TELEGRAM_CHAT_ID` (coma). Opcional: aviso corto por WhatsApp a Camila (necesita plantilla en YCloud y su número como secreto).
2. **Plantillas de WhatsApp** (seguimiento a 48 h y recordatorios) aprobadas en YCloud.
3. ~~WhatsApp perdido durante la caída de D1 (19:09–19:30 UTC del 7 oct)~~ — **resuelto** por Brayan (los de Instagram se reenviaron al bot).
4. **Seguridad (todo pasó por el chat):** restablecer la clave y el token de la app de Instagram en Meta; crear una llave nueva en Cal.com y guardarla como `CALCOM_API_KEY`; cerrar sesiones de Forja desconocidas (el código de acceso del CLI pasó por el chat).
5. **Zernio:** el permiso de Instagram vence el **5 de diciembre de 2026**; reconectar la cuenta en su panel si no se renueva solo y probar con alguien sin rol.
6. **CRM** (Zoho o uno nuevo) para guardar estatus migratorio y ahorros con acceso limitado; hace falta acceso de administrador.
7. **Seguros Naranjo:** confirmar con un caso real que el filtro descarta sus eventos.
8. **Medir** en 2–3 días: consumo de lecturas de D1, % de caché y costo por respuesta con Sonnet 5.5; decidir si se mantiene.
9. **Clientes ya conocidos:** nunca se entregó la lista de teléfonos, así que el bot no distingue clientes existentes.
