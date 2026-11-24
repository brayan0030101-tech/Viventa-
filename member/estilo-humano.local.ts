// member/estilo-humano.local.ts — cómo deben sonar los mensajes que Maricela deja a sus clientes desde el panel (seguimientos y reactivación).
// Pedido de Maricela y Brayan (24 nov 2026): menos robótico, más humano y cercano, y personalizado tras ANALIZAR al cliente antes de escribir.

/** «buenos días / buenas tardes / buenas noches» según la hora de España (donde está Maricela cuando lo envía). */
export function saludoDelMomento(now = Date.now()): string {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Madrid" }).format(new Date(now))) % 24;
  return h < 12 ? "buenos días" : h < 20 ? "buenas tardes" : "buenas noches";
}

/** Se pide ANTES del mensaje: el modelo estudia al cliente y recién entonces escribe. */
export const ANALISIS_PREVIO = `ANTES de escribir, analiza al cliente con TODO lo que tienes (notas, datos reunidos, conversación y cuánto hace que no habla) y deja ese análisis en el campo "analisis" (3 a 5 frases cortas, para uso interno, nunca va al cliente):
- quién es y su situación (dónde vive, qué busca, para cuándo, con quién decide);
- qué le preocupa o qué preguntó (financiación, formulario, precios, tiempos, su pareja…);
- en qué quedaron la última vez y qué se le prometió o se le envió (proyectos, formulario, video, llamada);
- cómo escribe (formal o relajado, breve o extenso) y su ritmo (¿contesta rápido o tarda?);
- qué paso concreto le toca ahora y qué detalle personal puede mencionar con naturalidad.
El mensaje se escribe a partir de ese análisis: tiene que sonar a que Maricela se acuerda de ESTA persona, no a una plantilla.`;

/** Estilo del WhatsApp (se añade al final de las reglas de cada generador). */
export const ESTILO_HUMANO = `Cómo debe sonar (muy importante): como Maricela escribiéndole a una persona a la que ya conoce, por WhatsApp, con calidez genuina. Nada de tono de empresa, de folleto ni de recordatorio automático.
- Saluda con el nombre y el momento del día que se te indique, y pregunta cómo está («Hola [nombre], buenas tardes, ¿cómo estás?»). Si la conversación fue más formal, mantén el «usted».
- Retoma algo real y concreto de esta persona (lo que preguntó, lo que le preocupaba, algo que contó) en vez de frases genéricas como «te escribo para dar seguimiento».
- Habla en primera persona y con frases naturales, como se dice en voz alta; puedes usar «no te preocupes», «cuéntame», «si prefieres, lo hacemos juntas».
- Si le enviaste algo antes (proyectos, formulario, video) menciónalo con naturalidad. Si el enlace del formulario puede haber vencido (se envió hace más de 48 horas), dilo con tranquilidad y ofrécele enviarle uno nuevo; NUNCA escribas ni inventes un enlace.
- Puedes ofrecer una videollamada corta como alternativa amable cuando encaje.
- Un solo asunto principal (puede ir acompañado de lo que lo explica, como el video del formulario), cerrando con una invitación abierta a contar cómo lo ve o a resolver dudas, y una despedida cálida corta («Un abrazo»).
- Largo: entre 3 y 6 renglones. Sin emojis. Sin listas. Sin repetir cifras ni datos personales sensibles (ingresos, documentos). No presiones ni agobies.
- Evita las frases de robot: «le informamos», «nos permitimos», «estimado cliente», «quedamos atentos», «a la espera de su respuesta».`;
