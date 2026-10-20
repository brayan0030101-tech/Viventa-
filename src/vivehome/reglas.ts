/**
 * Reglas para elegir qué cotizar a cada cliente (aprobadas por Brayan el 20 oct 2026). Todo aquí es puro (sin red ni base de datos) para poder
 * probarlo con vitest:
 *  · la cuota mensual que dijo el cliente se pasa a pesos con la tasa del día de ViveHome (euro o dólar) y se redondea HACIA ABAJO a $50.000;
 *    si dio un rango, se toma el número menor; sin moneda clara o sin cifra, no se cotiza;
 *  · se buscan proyectos de su ciudad y de las ciudades de su misma área metropolitana. Cuota inicial: 20 % cuando el proyecto la ofrece; si no,
 *    la que pida el proyecto hasta 30 % (flexible, pedido de Brayan, para no dejar fuera buenos proyectos; en el asistente se elige la opción
 *    más cercana al 20 %). Los que piden más de 30 % de inicial no entran;
 *  · si le alcanza: hasta 3 proyectos, de cada uno el apartamento más grande que le cabe, los que más se acercan a su cuota;
 *  · si no le alcanza: las 2 opciones más económicas (texto honesto, y queda anotado que no se cotizó a la medida), pero nunca una que cueste
 *    más de 2,5 veces su cuota; si no queda ninguna, se trata como «sin proyectos» (no se manda, se avisa a Maricela);
 *  · si no hay proyectos (con inicial hasta 30 %) en su ciudad ni en su área metropolitana: no se cotiza y se avisa a Maricela.
 */
import type { TipologiaCatalogo } from "./navegador";

export const SEPARACION = 1_000_000;
/** Cuota inicial preferida y la máxima aceptada (si el proyecto no ofrece el 20 %). */
export const PCT_PREFERIDO = 20;
export const PCT_MAXIMO = 30;

/** Cuota inicial con la que se cotiza un proyecto: 20 % si su mínimo es 20 % o menos; si no, su mínimo (hasta 30 %). null = no entra. */
export function pctParaCotizar(pctMin: number): number | null {
  if (!(pctMin > 0) || pctMin > PCT_MAXIMO) return null;
  return Math.max(PCT_PREFERIDO, pctMin);
}
export const MAX_A_LA_MEDIDA = 3;
export const MAX_MAS_ECONOMICAS = 2;
/** Tope de seguridad cuando no le alcanza: no se ofrece nada que cueste más de 2,5 veces su cuota (p. ej. $7.000.000/mes a quien dijo 200 €). */
export const TOPE_SOBRE_CUOTA = 2.5;

export function sinTildes(s: string): string {
  return s
    .toLowerCase()
    .replace(/€/g, " eur ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// ─── Cuota mensual del cliente ───────────────────────────────────────────────

export interface Capacidad {
  pesos: number;
  moneda: "COP" | "EUR" | "USD";
  /** Cifra tal como se entendió (antes de convertir). */
  cifra: number;
}

/** Interpreta «500 euros mensuales», «1.700.900 COP», «2 a 3 millones», «200-500 dólares», «600 mil COP». null = no se puede cotizar. */
export function leerCapacidad(texto: string | null | undefined, tasas: { eur: number; usd: number }): Capacidad | null {
  const t = sinTildes(String(texto ?? ""));
  if (!t.trim()) return null;
  if (/no (sabe|defin|lo ha|tiene claro)|depende|flexible|asesor|renta del|lo que se genere|sin definir|aun no/.test(t)) return null;
  const nums = [...t.matchAll(/(\d[\d.,]*)\s*(millones|millon|mil\b|k\b)?/g)].map((m) => ({ txt: m[1], mult: m[2] ?? "" }));
  if (!nums.length) return null;
  const aNumero = (s: string): number => {
    // «1.700.900» / «1.500» = separador de miles; «2,5» = decimal.
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
    if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ""));
    return Number(s.replace(",", "."));
  };
  const multDe = (m: string) => (m.startsWith("millon") ? 1e6 : m === "mil" || m === "k" ? 1e3 : 1);
  let { txt, mult } = nums[0];
  // «2 a 3 millones», «800 a 1000 mil»: el multiplicador va después del segundo número.
  if (!mult && nums[1]?.mult && /^\s*(a|-|y|o)\s*$/.test(t.slice(t.indexOf(txt) + txt.length, t.indexOf(nums[1].txt, t.indexOf(txt) + txt.length)))) mult = nums[1].mult;
  const cifra = aNumero(txt) * multDe(mult);
  if (!Number.isFinite(cifra) || cifra <= 0) return null;
  let moneda: Capacidad["moneda"];
  let pesos: number;
  if (/\beur|euro/.test(t)) {
    moneda = "EUR";
    pesos = cifra * tasas.eur;
  } else if (/dolar|\busd\b|us\$/.test(t)) {
    moneda = "USD";
    pesos = cifra * tasas.usd;
  } else if (/\bcop\b|peso|millon/.test(t) || cifra >= 100_000) {
    moneda = "COP";
    pesos = cifra;
  } else return null; // «200 al mes», «800 mensual»: no se sabe la moneda
  pesos = Math.floor(pesos / 50_000) * 50_000;
  if (pesos < 200_000 || pesos > 50_000_000) return null;
  return { pesos, moneda, cifra };
}

// ─── Ciudades y áreas metropolitanas ─────────────────────────────────────────

/** Áreas metropolitanas (solo ciudades vecinas del mismo área). Los nombres van como en la Calculadora de ViveHome. */
export const AREAS: string[][] = [
  ["Bogotá D.C.", "Soacha", "Mosquera", "Funza", "Madrid", "Cota", "Chía", "Cajicá", "La Calera", "Sopó", "Tocancipá", "Zipaquirá"],
  ["Medellín", "Bello", "Itagüí", "Envigado", "Sabaneta", "La Estrella", "Caldas", "Copacabana", "Girardota", "Barbosa"],
  ["Cali", "Jamundí", "Yumbo", "Candelaria", "Palmira"],
  ["Barranquilla", "Soledad", "Malambo", "Puerto Colombia", "Galapa"],
  ["Pereira", "Dosquebradas", "La Virginia"],
  ["Bucaramanga", "Floridablanca", "Girón", "Piedecuesta"],
  ["Cúcuta", "Villa del Rosario", "Los Patios"],
  ["Manizales", "Villamaría"],
];

const nombreCorto = (c: string) => c.replace(/\s*D\.C\.?$/i, "").trim();

/** Ciudades que menciona el cliente (las del catálogo o de las áreas), ampliadas con su área metropolitana. */
export function ciudadesBuscadas(texto: string | null | undefined, ciudadesCatalogo: string[]): { nombradas: string[]; conArea: string[] } | null {
  const t = ` ${sinTildes(String(texto ?? "")).replace(/[^a-z0-9ñ]+/g, " ")} `;
  if (!t.trim() || /\b(menos|excepto|cualquier|cualquiera|no se|aun no|sin definir)\b/.test(t)) return null;
  const todas = [...new Set([...ciudadesCatalogo, ...AREAS.flat()])].filter((c) => c && !/sin ciudad/i.test(c));
  // Más largas primero («Santa Rosa de Cabal» antes que «Cabal»…).
  const nombradas = todas
    .sort((a, b) => b.length - a.length)
    .filter((c) => t.includes(` ${sinTildes(nombreCorto(c)).replace(/[^a-z0-9ñ]+/g, " ").trim()} `));
  const conArea = new Set(nombradas);
  for (const c of nombradas) for (const a of AREAS) if (a.includes(c)) a.forEach((x) => conArea.add(x));
  return { nombradas, conArea: [...conArea] };
}

// ─── Elección ────────────────────────────────────────────────────────────────

/** Mensualidad estimada de la cuota inicial: (pct % redondeado a miles − separación) ÷ meses. Igual a la cotización de ViveHome. */
export function mensualidadEstimada(t: Pick<TipologiaCatalogo, "valor" | "meses">, pct = PCT_PREFERIDO): number {
  const inicial = Math.ceil((t.valor * pct) / 100 / 1000) * 1000;
  return Math.round((inicial - SEPARACION) / t.meses);
}

export interface Elegido {
  proyecto: string;
  ciudad: string;
  valor: number;
  meses: number;
  area: string;
  mensual: number;
  /** Cuota inicial con la que se cotiza (20 salvo proyectos que piden más). */
  pct: number;
}

export type Eleccion =
  | { tipo: "a_la_medida"; items: Elegido[] }
  | { tipo: "mas_economicas"; items: Elegido[] }
  | { tipo: "sin_proyectos"; items: []; motivo: "sin_20" | "muy_caro" };

export function elegirProyectos(catalogo: TipologiaCatalogo[], ciudades: string[], capacidad: number): Eleccion {
  const pool = catalogo
    .filter((t) => ciudades.includes(t.ciudad) && pctParaCotizar(t.pctMin) != null && t.meses > 0 && t.valor > 0)
    .map((t) => {
      const pct = pctParaCotizar(t.pctMin) as number;
      return { proyecto: t.proyecto, ciudad: t.ciudad, valor: t.valor, meses: t.meses, area: t.area, pct, mensual: mensualidadEstimada(t, pct) };
    })
    .filter((t) => t.mensual > 0);
  if (!pool.length) return { tipo: "sin_proyectos", items: [], motivo: "sin_20" };
  const clave = (e: Elegido) => `${e.proyecto}|${e.ciudad}`;
  const caben = pool.filter((t) => t.mensual <= capacidad);
  if (caben.length) {
    // De cada proyecto, el apartamento más caro que le cabe (el más grande que le alcanza).
    const mejor = new Map<string, Elegido>();
    for (const t of caben) {
      const k = clave(t);
      const prev = mejor.get(k);
      if (!prev || t.mensual > prev.mensual) mejor.set(k, t);
    }
    const items = [...mejor.values()].sort((a, b) => b.mensual - a.mensual).slice(0, MAX_A_LA_MEDIDA);
    return { tipo: "a_la_medida", items };
  }
  const barato = new Map<string, Elegido>();
  for (const t of pool) {
    const k = clave(t);
    const prev = barato.get(k);
    if (!prev || t.mensual < prev.mensual) barato.set(k, t);
  }
  const items = [...barato.values()]
    .filter((t) => t.mensual <= capacidad * TOPE_SOBRE_CUOTA)
    .sort((a, b) => a.mensual - b.mensual)
    .slice(0, MAX_MAS_ECONOMICAS);
  if (!items.length) return { tipo: "sin_proyectos", items: [], motivo: "muy_caro" };
  return { tipo: "mas_economicas", items };
}

// ─── Mensaje al cliente ──────────────────────────────────────────────────────

export const pesos = (n: number): string => `$${Math.round(n).toLocaleString("es-CO").replace(/,/g, ".")}`;

function listaLugares(ciudades: string[]): string {
  const u = [...new Set(ciudades.map(nombreCorto))];
  return u.length <= 1 ? (u[0] ?? "") : `${u.slice(0, -1).join(", ")} y ${u[u.length - 1]}`;
}

export function primerNombre(...cands: Array<string | null | undefined>): string {
  for (const c of cands) {
    const n = (c ?? "").trim().split(/\s+/)[0] ?? "";
    if (n && !/[\d_.@]/.test(n)) return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
  }
  return "";
}

/** Texto que acompaña al enlace. `ejemplo` = el proyecto con la cuota más baja, con las cifras exactas de la cotización publicada. */
export function textoMensaje(o: {
  nombre: string;
  tipo: "a_la_medida" | "mas_economicas";
  enlace: string;
  ciudades: string[];
  /** Ciudad que pidió el cliente: si las opciones son de una vecina, se aclara «muy cerca de …». */
  ciudadCliente?: string;
  /** Cuota inicial de cada proyecto (si todas son 20 %, el texto lo dice). */
  pcts?: number[];
  n: number;
  ejemplo: { proyecto: string; mensualidad: number; meses: number };
}): string {
  const hola = o.nombre ? `¡Hola, ${o.nombre}!` : "¡Hola!";
  const cliente = o.ciudadCliente ? nombreCorto(o.ciudadCliente) : "";
  const lugares = listaLugares(o.ciudades) + (cliente && !o.ciudades.map(nombreCorto).includes(cliente) ? `, muy cerca de ${cliente}` : "");
  const proyecto = o.ejemplo.proyecto;
  const cuota = `${pesos(o.ejemplo.mensualidad)} al mes durante ${o.ejemplo.meses} meses`;
  if (o.tipo === "a_la_medida") {
    const opciones = o.n === 1 ? "una opción" : `${o.n} opciones`;
    return (
      `${hola} Con lo que me contaste, te preparé una cotización con ${opciones} en ${lugares} que se ${o.n === 1 ? "ajusta" : "ajustan"} a lo que puedes pagar al mes:\n` +
      `${o.enlace}\n\n` +
      `Ahí ves el valor ${o.n === 1 ? "del apartamento" : "de cada apartamento"}, ${(o.pcts ?? [20]).every((x) => x === 20) ? "la cuota inicial del 20 %" : o.n === 1 ? `la cuota inicial del ${o.pcts?.[0]} %` : "la cuota inicial de cada uno"} y cuánto pagarías mes a mes. ${o.n === 1 ? "En" : "Por ejemplo, en"} ${proyecto} serían ${cuota}.\n\n` +
      (o.n === 1 ? `¿Qué te parece?` : `¿Cuál te llamó más la atención?`)
    );
  }
  const opciones = o.n === 1 ? "la opción más económica" : `las ${o.n} opciones más económicas`;
  return (
    `${hola} Te preparé una cotización con ${opciones} que hay hoy en ${lugares}:\n` +
    `${o.enlace}\n\n` +
    `Te cuento con claridad: la cuota mensual queda por encima de lo que me comentaste. ${o.n === 1 ? "En" : "Por ejemplo, en"} ${proyecto} la cuota inicial sería de ${cuota}. ` +
    `Ahí puedes ver todos los valores con calma, y con Maricela podemos revisar cómo ajustarlo a tu bolsillo.\n\n` +
    `¿Qué te parece?`
  );
}
