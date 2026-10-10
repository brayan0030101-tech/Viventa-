/**
 * Zona horaria del cliente a partir de «País, Ciudad» de su ficha. Las
 * videollamadas se ofrecen en hora de España; si el cliente vive en otro país se
 * le muestra también su hora local, para que no haya confusiones.
 */

export interface ZonaCliente {
  tz: string;
  /** Cómo se nombra en el mensaje: «Colombia», «EE. UU. (costa este)»… */
  etiqueta: string;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const US_ESTE = /(miami|orlando|florida|tampa|new york|nueva york|new jersey|nueva jersey|atlanta|boston|washington|carolina|georgia|virginia|pensilvania|philadelphia|filadelfia|connecticut|massachusetts)/;
const US_CENTRO = /(houston|dallas|texas|austin|chicago|illinois|san antonio|nueva orleans|new orleans|minnesota|missouri)/;
const US_MONTANA = /(denver|colorado|phoenix|arizona|utah)/;
const US_OESTE = /(los angeles|california|san francisco|san diego|seattle|las vegas|nevada|portland|oregon)/;

export function zonaDeResidencia(ciudadResidencia: string | undefined | null): ZonaCliente | null {
  const t = norm(ciudadResidencia ?? "");
  if (!t.trim()) return null;
  if (/(espana|spain|madrid|barcelona|valencia|sevilla|bilbao|girona|malaga|zaragoza)/.test(t)) return { tz: "Europe/Madrid", etiqueta: "España" };
  if (/(estados unidos|eeuu|ee\.? ?uu|usa|united states|\bus\b)/.test(t) || US_ESTE.test(t) || US_CENTRO.test(t) || US_MONTANA.test(t) || US_OESTE.test(t)) {
    if (US_OESTE.test(t)) return { tz: "America/Los_Angeles", etiqueta: "EE. UU. (costa oeste)" };
    if (US_MONTANA.test(t)) return { tz: "America/Denver", etiqueta: "EE. UU. (zona montaña)" };
    if (US_CENTRO.test(t)) return { tz: "America/Chicago", etiqueta: "EE. UU. (zona central)" };
    return { tz: "America/New_York", etiqueta: "EE. UU. (costa este)" };
  }
  if (/(canada|toronto|montreal|ottawa)/.test(t)) return { tz: "America/Toronto", etiqueta: "Canadá (Toronto)" };
  if (/(vancouver)/.test(t)) return { tz: "America/Vancouver", etiqueta: "Canadá (Vancouver)" };
  if (/(colombia|bogota|medellin|cali\b|barranquilla|cartagena|pereira)/.test(t)) return { tz: "America/Bogota", etiqueta: "Colombia" };
  const pais: Array<[RegExp, string, string]> = [
    [/chile|santiago/, "America/Santiago", "Chile"],
    [/mexico|ciudad de mexico|cdmx/, "America/Mexico_City", "México"],
    [/argentina|buenos aires/, "America/Argentina/Buenos_Aires", "Argentina"],
    [/peru|lima/, "America/Lima", "Perú"],
    [/ecuador|quito|guayaquil/, "America/Guayaquil", "Ecuador"],
    [/venezuela|caracas/, "America/Caracas", "Venezuela"],
    [/panama/, "America/Panama", "Panamá"],
    [/reino unido|inglaterra|londres|london|uk\b|escocia/, "Europe/London", "Reino Unido"],
    [/irlanda|dublin/, "Europe/Dublin", "Irlanda"],
    [/portugal|lisboa/, "Europe/Lisbon", "Portugal"],
    [/francia|paris/, "Europe/Paris", "Francia"],
    [/italia|roma|milan/, "Europe/Rome", "Italia"],
    [/alemania|berlin|munich/, "Europe/Berlin", "Alemania"],
    [/suiza|zurich|ginebra/, "Europe/Zurich", "Suiza"],
    [/holanda|paises bajos|amsterdam/, "Europe/Amsterdam", "Países Bajos"],
    [/belgica|bruselas/, "Europe/Brussels", "Bélgica"],
  ];
  for (const [re, tz, etiqueta] of pais) if (re.test(t)) return { tz, etiqueta };
  return null;
}

/** «19:00» de un instante ISO, en la zona dada. */
export function horaEn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-ES", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function esEspana(z: ZonaCliente | null): boolean {
  return !z || z.tz === "Europe/Madrid";
}
