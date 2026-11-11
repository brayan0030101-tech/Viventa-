# Traspaso: bots DEMO para mostrar a clientes (servicio de automatizaciones con chatbots)

Para abrir en una conversación NUEVA. Sin datos de clientes ni claves.

## Qué se quiere
Brayan vende automatizaciones con chatbots para cualquier tipo de negocio. Necesita demos que pueda
(1) mostrar en una reunión en una página web y (2) mandarle un link al cliente para que lo pruebe solo.

## Lo que ya existe (no hay que inventarlo)
- El proyecto base trae un MODO DEMO: con `DEMO_MODE = "on"` en `wrangler.toml` publica un chat web en `/demo`
  (src/demo.ts, ruta en src/index.ts). Tope de 40 mensajes por visitante. Sin WhatsApp ni Telegram.
- La skill `skill/demo.md` (`/demo`) monta un demo con la marca del prospecto en minutos:
  `npx forjabot init --yes --negocio … --que … --ofrece … --horario … --ubicacion …`, enciende DEMO_MODE,
  publica y entrega link + mensaje de WhatsApp para enviarlo al prospecto.
- REGLA DE ORO de esa skill: cada demo va en su carpeta aislada (`~/forja-demos/<slug>`), NUNCA dentro de la
  carpeta del bot de Viventa (lo sobrescribiría) ni compartiendo su base de datos, claves o números.

## Por qué NO hacerlo dentro del proyecto de Viventa
Ese proyecto es el bot real: clientes reales, Zoho, WhatsApp y Cal.com conectados. Un demo debe tener su propio
Worker, su propia base D1 y su propia llave de IA, para no tocar datos reales ni mostrar nada de Viventa.

## Mejoras ya probadas en Viventa que conviene llevar a los demos (para que se vean pro)
Tomar como referencia los archivos, sin copiar datos específicos de Viventa:
1. Respuestas con BOTONES: marcador `[[botones: a | b | c]]` (máx. 3, título ≤ 20 caracteres); el toque del
   cliente llega como texto. En el demo web los botones se ven como lista; en WhatsApp son botones reales
   (src/replies/sender.ts, src/channels/ycloud.ts, skill/botones.md).
2. Guion por pasos, UN mensaje y UNA pregunta a la vez; si el cliente responde fuera de orden, agradecer y
   volver al paso pendiente; no repetir preguntas ya contestadas (instrucciones en D1 `settings.custom_instructions`).
3. Agenda real: herramientas verDisponibilidad / agendarCita con Cal.com, reagendar siempre lo hace el bot,
   recordatorio 24 h y 1 h, y NO avisar si la cita ya no existe (src/integrations/calcom.ts, src/followup/sistemaViventa.ts).
4. Calificación del cliente (frío / tibio / caliente) y seguimiento automático: recordatorios, reactivación de
   clientes que dejaron de responder (src/followup/*, member/crm-reactivacion.local.ts).
5. Envío fiable: 3 reintentos, y no reenviar cuando Meta da un error ambiguo (evita mensajes dobles).
6. Guardián de instrucciones: copia de seguridad de las instrucciones y aviso si falta una regla imprescindible
   (src/followup/guardianInstrucciones.ts).
7. Escenarios de prueba del bot (member/crm-pruebas.local.ts) para comprobar el guion antes de enseñarlo.
8. Panel CRM con leads, seguimientos y auditoría (member/crm-*.local.ts) — útil para enseñar «lo que ve el dueño».

## Lo que NO se debe copiar
Datos de clientes, `member/HISTORIAL-DEL-PROYECTO.md`, reglas de cotizaciones/ViveHome, integración Zoho, números y
claves (YCloud, Zernio, Zoho, Cal.com, Capital, etc.). Todo secreto se pone con `wrangler secret put`, nunca en el chat.

## Plan sugerido para la conversación nueva
1. Crear la carpeta contenedora `~/forja-demos` (fuera del proyecto de Viventa) y usar `/demo`.
2. Armar una PLANTILLA de demo reutilizable por giro (clínica, restaurante, inmobiliaria, tienda, barbería,
   academia…) con guion, botones y agenda de ejemplo, para clonar en 5 minutos con la marca de cada prospecto.
3. Para cada prospecto: link `https://<worker>.workers.dev/demo` + mensaje listo para enviarle; probarlo antes de enviarlo.
4. Cuando cierre la venta: bot real con `/cliente-nuevo` (su propia instancia y canales). Borrar el demo
   con `npx wrangler delete` cuando ya no se use.
5. Pendiente a decidir: dominio propio para los demos (p. ej. demo.<tu-dominio>) y una página índice con todos.

## Mensaje para abrir la conversación nueva (copiar y pegar)
«Vendo automatizaciones con chatbots para cualquier tipo de negocio. Necesito bots DEMO en una página web que pueda
mostrar en reuniones y enviar por link para que el cliente los pruebe. Lee `member/TRASPASO-BOTS-DEMO.md` del
repositorio brayan0030101-tech/viventa- y usa la skill `/demo`. Los demos van en una carpeta aparte, nunca dentro
del bot de Viventa. Quiero una plantilla por giro con botones, agenda y seguimiento.»
