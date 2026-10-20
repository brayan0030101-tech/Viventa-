/** Texto de cortesía («vale», «gracias»…): no necesita respuesta. Lo usa el auditor (`auditor.ts`) para no avisar por esos mensajes. */

const CORTESIAS = new Set([
  "vale", "ok", "okey", "okay", "gracias", "muchas", "perfecto", "listo", "genial", "excelente", "bueno", "entendido", "dale", "claro",
  "super", "súper", "bien", "si", "sí", "no", "ya", "hola", "buenas", "buenos", "dias", "días", "tardes", "noches", "de", "nada", "por", "favor",
  "muy", "amable", "te", "lo", "agradezco", "quedo", "atento", "atenta", "pendiente", "saludos", "adios", "adiós", "chao", "hasta", "luego",
]);

/** «Vale», «Gracias 🙏», «Vale perfecto muchas gracias»: no necesitan respuesta. */
export function esCortesia(texto: string): boolean {
  const palabras = texto.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return true; // solo emojis o signos
  return !texto.includes("?") && palabras.every((p) => CORTESIAS.has(p));
}
