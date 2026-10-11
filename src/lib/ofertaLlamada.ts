/**
 * Mensaje del equipo que OFRECE la videollamada («Maricela puede llamarte en una videollamada de 30
 * minutos… ¿te parece bien si la agendamos?»). Cuando se manda desde el panel, el bot NO debe quedarse
 * callado (la pausa por intervención lo silenciaría): debe seguir con el agendamiento en cuanto el
 * cliente responda. Es deliberadamente estrecho para no soltar al bot en una charla normal del equipo.
 */
export function esOfertaVideollamada(text: string): boolean {
  const t = text.trim();
  if (t.length > 500) return false;
  return /videollamada/i.test(t) && /(agend|programar|coordinar|cuadr)/i.test(t);
}
