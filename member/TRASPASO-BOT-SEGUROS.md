# Traspaso: terminar y pulir el chatbot de SEGUROS + construir su CRM

Documento para la conversación que ya tiene adelantado el bot de seguros. Resume lo aprendido construyendo y operando el bot de Viventa (vivienda en Colombia), para que el de seguros llegue al mismo nivel de calidad. **No contiene claves ni datos de clientes.**

## 0. Cómo trabajar con el dueño (Brayan)
- No es técnico: explicar en español sencillo, sin jerga, y decir siempre **qué se verificó y qué no**. Nunca presentar una suposición como un hecho.
- Para todo lo que sale hacia afuera (mensajes a clientes, cambios en un CRM real, plantillas de WhatsApp, pagos) **pedir su visto bueno antes** y probar primero con UN caso real aprobado.
- Todo lo nuevo que actúe sobre clientes nace **apagado** (un ajuste en la base de datos) y se enciende con su orden. Apagarlo debe tomar un segundo.
- Cada incidente real → primero entender la causa con datos, luego arreglo mínimo + una prueba automática + nota en el historial.
- El cliente final de seguros (quien pidió el CRM) y los asesores también escriben por el chat de Brayan: priorizar lo que reportan, con la publicidad activa nada puede quedar sin respuesta.

## 1. Arquitectura que funcionó (Viventa)
- Cloudflare Worker (Hono) + base D1 + vitest. Despliegue: `pnpm run deploy`; **siempre** correr las pruebas completas antes de desplegar.
- Las instrucciones del bot viven en la base (`settings.custom_instructions`), con copia de respaldo antes de cada cambio y un **guardián** (`src/followup/guardianInstrucciones.ts`) que avisa si falta una regla imprescindible o el texto se encoge.
- Patrón de **operación sin acceso al servidor** ("diag runner"): un ajuste de la base (`*_diag_pedir`) con una orden pequeña que el cron de 5 min ejecuta una vez y deja el resultado en otro ajuste (`*_diag_resultado`). Sirvió para leer Zoho, crear plantillas de WhatsApp, canjear permisos y ejecutar pruebas puntuales sin imprimir secretos. Ver `member/zoho-diag.local.ts`, `member/ycloud-diag.local.ts`.
- Canales: WhatsApp por YCloud (ventana de 24 h; fuera de ella solo plantillas aprobadas por Meta), Instagram por Zernio. Agenda real con Cal.com. Avisos al equipo por Telegram.
- Mucho del código "de miembro" vive en `member/*.local.ts`; el núcleo del bot en `src/`.

## 2. Diseño de la conversación (lo que más se notó en calidad)
1. **Guion por pasos, UNA pregunta por mensaje**, con **botones de respuesta** cuando hay opciones: marcador `[[botones: a | b | c]]` (máx. 3 botones, título ≤ 20 caracteres). El toque del cliente llega como texto. Cuidado: el cliente muchas veces escribe en vez de tocar; el bot debe entender ambas cosas.
2. **No repetir preguntas** ya contestadas; **juntar** respuestas fragmentadas ("empleada" + "2000") antes de preguntar lo siguiente.
3. Si el cliente pide hablar con una persona o una cita, **primero se agenda** y el cuestionario espera.
4. **Nunca cerrar la puerta** a un cliente por un dato bajo; ofrecer alternativa.
5. El bot **no inventa** precios, coberturas, plazos ni enlaces: solo los que devuelve una herramienta. Nunca promete "te lo confirma el equipo".
6. Cada mensaje del bot termina con una pregunta o con el siguiente paso. Un cliente nunca queda sin respuesta.
7. Calificación del cliente (frío/tibio/caliente) con reglas escritas y probadas; no descartar por una sola respuesta.
8. Mensajes cortos, tono cercano, y separar siempre los enlaces con una línea en blanco.

## 3. Fiabilidad: errores reales que hay que evitar
- **Mensaje doble**: Meta devolvió un 500 ambiguo (código 131000) y el bot reenviaba como texto; el mensaje con botones sí había llegado. Regla: ante un error ambiguo **no reenviar**; reenviar solo ante rechazo claro (4xx). Hay un vigilante que detecta mensajes que YCloud aceptó y WhatsApp rechazó después.
- **Respuesta que nunca llega**: esperar a un sistema externo (Zoho) **dentro del turno del bot** hizo que el turno se cortara. Regla: dentro del turno solo acciones rápidas; lo lento se marca como "pendiente" ANTES de empezar y lo termina una revisión en segundo plano (cada 5 min).
- Envío con 3 reintentos; si falla del todo se borra la respuesta guardada para que el sistema detecte "sin respuesta" y la reintente solo.
- **Recordatorios de citas**: comprobar en Cal.com que la reserva siga viva antes de avisar (un cliente recibió recordatorios de una cita que ya no existía).
- Plantillas de Meta: Meta **no permite botones con enlaces wa.me**; usar botones de respuesta rápida y que el bot conteste con el enlace. Las ofertas con "gratis" pueden ser rechazadas: tener el texto exacto aprobado por quien lo ofrece.
- Envíos masivos: **de a poco** (tandas pequeñas, tope diario), horario del cliente, una sola vez por cliente, botón "No me interesa" que marque al cliente, y exclusión de quien pidió no ser contactado.
- Asociar datos a la persona correcta: una llamada grabada se pegó a otro cliente por coincidir solo la hora. Regla: emparejar por correo o nombre, no solo por hora.

## 4. Integración con CRM (lecciones de Zoho; adaptar al CRM de seguros)
- Una conexión con permisos justos; renovar permisos cuando haga falta con el flujo "código de un solo uso → canje en el servidor" (el token nunca se imprime).
- **No escribir en fichas de otra persona**: comprobar el dueño antes de crear notas o tareas.
- No escribir la palabra "bot" en notas ni tareas del CRM (pidió el equipo comercial).
- Notas de seguimiento en cada contacto; las notas de Zoho no se pueden editar por la API.
- Ejecutar una función de Zoho por la API exige una función **independiente** con API REST (OAuth2) activada, y pasar los argumentos **también** en el parámetro `arguments` de la dirección; Zoho puede responder HTTP 200 con un error dentro del cuerpo: **leer siempre el cuerpo**.
- Evitar duplicados: buscar por correo y por teléfono antes de crear una ficha.
- Todo lo que escriba en el CRM: apagado por defecto, una vez por cliente, y probado con un caso real.

## 5. Panel CRM (lo que ya existe y sirve de modelo)
Leads con ficha y prioridad, Seguimientos de hoy (con botones de WhatsApp/CRM), Auditoría de conversaciones, Reactivación de clientes que se enfriaron, Por agendar, Calendario de llamadas, Cotizaciones, Instrucciones del bot (con versiones). Código en `member/crm-*.local.ts`. **El CRM de seguros debe diseñarse con la información que el cliente de seguros ya envió** (ver sección 7), no copiando el de vivienda.

## 6. Seguros: puntos legales y de producto
- Pedir permiso para ofertas comerciales por WhatsApp (en España exige consentimiento) y guardarlo.
- No pedir por chat datos de salud detallados; eso lo trata una persona.
- Número de registro del mediador y aseguradora visibles cuando sea obligatorio; el bot remite a la documentación oficial y no resume condiciones.
- Promociones (p. ej. «1 mes gratis»): el texto exacto lo aprueba quien ofrece el seguro.
- Renovaciones: en seguros son clave; avisar con tiempo y seguimiento.
- Ya existe una oferta de seguros ERGO|DKV a clientes de Viventa (`member/crm-seguros.local.ts`, plantilla `viventa_tpl_seguros`) con la que el bot de seguros debe ser coherente.

## 7. Qué debe hacer la conversación nueva, en orden
1. Leer este documento y pedirle a Brayan lo que haga falta: la ubicación del proyecto del bot de seguros, y **el documento o mensaje donde el cliente de seguros especificó la información del CRM**.
2. **Auditar** el bot de seguros actual contra las secciones 2, 3 y 4, y escribir una lista corta de brechas con prioridad. Sin cambiar nada todavía.
3. Proponer a Brayan el plan (guion con botones, agenda, calificación, reglas de seguridad y legales, pruebas) y esperar su aprobación.
4. Pulir el bot con pruebas automáticas por cada regla; escenarios de conversación de prueba antes de enseñarlo.
5. Construir el CRM con los campos, estados e informes que pidió el cliente de seguros; todo lo que actúe sobre clientes, apagado hasta aprobar.
6. Probar con UN cliente real aprobado, vigilar los primeros días y reportar en español sencillo.

## 8. Referencias en este repositorio (si la conversación tiene acceso)
`src/replies/sender.ts`, `src/channels/ycloud.ts` (botones y envío), `src/followup/guardianInstrucciones.ts`, `src/followup/sistemaViventa.ts` (recordatorios y reactivación), `src/integrations/calcom.ts` (agenda), `member/viabilidad.local.ts` (tareas lentas en segundo plano), `member/crm-seguros.local.ts` (envío masivo prudente), `member/crm-pruebas.local.ts` (escenarios de prueba), `member/zoho-diag.local.ts` (patrón de operación), `member/HISTORIAL-DEL-PROYECTO.md` (cada incidente y su arreglo).
