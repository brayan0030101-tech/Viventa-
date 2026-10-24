/**
 * WhatsApp/Instagram reconocen un enlace hasta el primer espacio: «…?id=2585por favor» se vuelve un enlace roto que da error al abrir
 * (Maricela, 24 oct 2026). Este arreglo se aplica a todo texto que sale hacia el cliente:
 *  · antes de un enlace siempre hay un espacio (o salto de línea): «Cali;https://…» → «Cali; https://…»;
 *  · después de un enlace de cotización (termina en dígitos) no puede pegarse una letra: «id=2585por» → «id=2585 por».
 */
export function separarEnlaces(texto: string): string {
  return texto
    .replace(/([^\s(\[{«"'¿¡=/?&#%])(https?:\/\/)/g, "$1 $2")
    .replace(/(https?:\/\/[^\s]*?[?&]id=\d+)(?=[A-Za-zÁÉÍÓÚáéíóúñÑ])/gi, "$1 ");
}
