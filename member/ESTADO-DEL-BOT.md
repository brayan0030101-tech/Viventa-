# Estado del bot de Viventa (memoria compartida entre conversaciones)

> Léelo antes de tocar nada. Última actualización: 6 de octubre de 2026.
> Aquí **nunca** va el valor de una llave. Solo nombres y dónde viven.
> El repo es **público**: no subas `.env`, tokens ni números de clientes.

## Quién es quién
- **Viventa:** ayuda a colombianos que viven fuera a comprar vivienda en Colombia.
- **Maricela:** es el nombre del bot y también la asesora humana (Maricela Naranjo). El bot habla en primera persona **como Maricela**. Nunca debe decir "una videollamada con Maricela (conmigo)" ni hablar de ella en tercera persona.
- **Brayan:** dueño y quien pide los cambios. No es técnico: español neutro, sencillo, sin tecnicismos. Pide confirmación antes de desplegar, de subir a GitHub o de cambiar algo de producción.

## Dónde vive todo
- Worker de Cloudflare: `forja-inmobiliaria-8664f4` (`https://forja-inmobiliaria-8664f4.brayan0030101.workers.dev`).
- Base de datos D1: `horizontes_bot_inmobiliaria_8664f4_db`. Panel: `/admin`.
- Repo: `github.com/brayan0030101-tech/Viventa-`, rama `main` (público).
- Desplegar: `pnpm run deploy` (no `pnpm deploy`). Comprobar: `npx tsc --noEmit` y `npx vitest run`. Ver registros: `npx wrangler tail forja-inmobiliaria-8664f4`.
- Cloudflare: la sesión necesita `CLOUDFLARE_API_TOKEN` en el entorno (menú del entorno → Editar). Si está cambiada o falta, wrangler pide autenticarse. Una variable nueva solo la ve una sesión nueva.
- **Ajustes que NO están en git** (viven en la base D1 y se cambian sin desplegar): las instrucciones adicionales del bot (`custom_instructions`, ya largas, ~26 mil caracteres la última vez que se midieron) y `max_chunks = 2`. Antes de cambiarlas, léelas y no las reemplaces enteras.

## Canales
| Canal | Cómo entra | Detalle |
|---|---|---|
| WhatsApp | YCloud, número `+34611688609` (`YCLOUD_WA_FROM`) | Webhook `/webhooks/ycloud`. La cuenta de YCloud es **compartida** con otro bot (Seguros Naranjo, `+34603039032`): `isForThisNumber` en `src/channels/ycloud.ts` descarta eventos y ecos de otro número. No cambiar el webhook ni la API key de YCloud sin que Brayan lo pida. |
| Instagram | Zernio, cuenta `compratucasaconmari` | Webhook `/webhooks/zernio`. El camino oficial de Meta quedó **apagado** con `IG_OFFICIAL = "off"` para no contestar doble. Funciona con cuentas sin rol en Meta. Si algún día se reactiva Meta, apagar Zernio o poner `IG_DM_SOURCE` según corresponda. |

Lección: Instagram directo con la app propia de Meta solo responde a cuentas con rol en la app y exige publicarla y pasar revisión. Antes de conectar un canal nuevo, presentar las opciones (Meta directo, Zernio, ManyChat) y dejar que Brayan elija. Guía: `skill/references/channel-setup-guides/_elegir-canal-y-metodo.md`.

## Agenda con Cal.com
- Tipo de evento `7227219`, "Videollamada Viventa", 15 minutos. Zona horaria `Europe/Madrid` (hora española).
- Horario de Maricela: lunes a viernes de 10 a 16 h. Martes y jueves de 18 a 20 h **solo** como bloque nocturno para quien no puede de día.
- Herramientas: `verDisponibilidad`, `agendarCita`, `cancelarCita` (vía `member/tools.local.ts`). Cal.com rechaza correos falsos tipo `example.com`.
- Imagen de disponibilidad con horarios tachados: marcador `[[disponibilidad]]` (modo día o `noche`), ruta firmada `/disponibilidad.png`. Solo se tachan reservas reales. Si falla el PNG, el bot manda el texto con `~hora~`.
- Pendiente: probar la imagen en un chat real de WhatsApp.

## Reglas de conducta del bot (dichas por Brayan)
1. **Nunca** decir "eso me lo confirma el equipo" ni frases parecidas para ganar tiempo. Si no sabe algo, **se queda callado y se lo pasa a Maricela** directamente.
2. Máximo **dos mensajes** por turno, y esperar la respuesta del cliente.
3. Es Maricela, en primera persona. Español neutro.

## Llaves (solo nombres; valores nunca)
Viven como secretos del worker (`npx wrangler secret list` muestra los nombres): la llave del modelo de IA, `YCLOUD_API_KEY` y `YCLOUD_WEBHOOK_SECRET`, `CALCOM_API_KEY`, `ZERNIO_API_KEY` y `ZERNIO_WEBHOOK_SECRET`, `META_VERIFY_TOKEN`, la contraseña del panel. Los secretos de Instagram con Meta (`INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_APP_SECRET`) se **borraron** del worker.
Para guardar uno: `printf '%s' '<valor>' | npx wrangler secret put NOMBRE`, sin escribirlo en archivos ni en el chat. Si Brayan prefiere trabajar desde su computador: `.env` local (ignorado por git) y `npx wrangler secret bulk .env` (sube todo el archivo y reemplaza los que tengan el mismo nombre).

## Pendientes
1. **Audios de clientes:** desde el 25 de septiembre quedan guardados como "(no pude entender el audio)" (174 hasta la fecha). El bot llega a su ruta `/webhooks/ycloud/media/:id` y YCloud rechaza la descarga (502). El registro de diagnóstico ya está desplegado: con un audio real, revisar `wrangler tail` y arreglar (por ejemplo usar el enlace `audio.link` del evento). Los audios que el dueño manda desde su app dan 404 aparte.
2. **Seguridad (todo pasó por el chat):** restablecer la clave y el token de la app de Instagram en Meta; crear una llave nueva en Cal.com y guardarla como `CALCOM_API_KEY`; la llave de Cloudflare que apareció en un chat ya se rodó.
3. **Zernio:** el permiso de Instagram vence el **5 de diciembre de 2026**. Hay un recordatorio programado para el 1 de diciembre; si Zernio no lo renueva solo, reconectar la cuenta en su panel y probar con alguien sin rol.
4. **Seguros Naranjo:** confirmar con un caso real que el filtro descarta sus eventos.
5. **Instagram:** revisar que Maricela se comporte bien allí (mensajes cortos, fotos, notas de voz) y decidir si lleva instrucciones propias (`custom_instructions:instagram`). Las conversaciones viejas que entraron por Meta no reciben seguimientos automáticos.
6. **Clientes ya conocidos:** nunca se entregó la lista de teléfonos, así que el bot no distingue clientes existentes.
7. **Mensajes automáticos del CRM (Zoho):** hace falta acceso de administrador para revisarlos.
