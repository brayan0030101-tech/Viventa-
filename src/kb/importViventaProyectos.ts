import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { KbDocsRepo, indexDoc, removeDocVectors, MAX_DOC_CHARS } from "./docs";

const SITEMAP_URL = "https://www.viventa.co/sitemap.xml";
const PROYECTOS_RE = /<loc>\s*(https?:\/\/(?:www\.)?viventa\.co\/proyectos\/([a-z0-9-]+))\s*<\/loc>/gi;
const BATCH_SIZE = 12;
const FETCH_TIMEOUT_MS = 12_000;
const DOC_ID_PREFIX = "proyecto:";

const SLUGS_KEY = "viventa_proyectos_slugs_pass";
const CURSOR_KEY = "viventa_proyectos_cursor";
const KNOWN_KEY = "viventa_proyectos_known_slugs";

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ViventaBot/1.0)" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemapSlugs(): Promise<string[]> {
  const res = await fetchWithTimeout(SITEMAP_URL, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`sitemap_http_${res.status}`);
  const xml = await res.text();
  const slugs = new Set<string>();
  PROYECTOS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROYECTOS_RE.exec(xml))) slugs.add(m[2]);
  return Array.from(slugs).sort();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToLines(html: string): string[] {
  const noScripts = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const noTags = noScripts.replace(/<[^>]+>/g, "\n");
  return decodeEntities(noTags)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function findIndex(lines: string[], pred: (l: string) => boolean, from = 0): number {
  for (let i = Math.max(from, 0); i < lines.length; i++) if (pred(lines[i])) return i;
  return -1;
}

interface ProjectFields {
  title: string;
  content: string;
}

// El template de las páginas de proyecto es siempre el mismo (mismo componente
// Blazor), así que anclamos la extracción a las etiquetas fijas que ese
// template imprime ("Proyecto en", "Amenidades", "Precio desde", etc.) en vez
// de a posiciones de HTML, que cambian de proyecto a proyecto.
function extractProjectFields(html: string): ProjectFields | null {
  const lines = htmlToLines(html);
  const iProyectoEn = findIndex(lines, (l) => l.startsWith("Proyecto en "));
  if (iProyectoEn === -1) return null;

  const ciudadBarrio = lines[iProyectoEn - 1] || lines[iProyectoEn].replace("Proyecto en ", "");
  const headWindow = lines.slice(iProyectoEn, iProyectoEn + 15).join("\n");

  const habMatch = headWindow.match(/(\d+)\s*hab\b/i);
  const banosMatch = headWindow.match(/(\d+)\s*baños/i);
  const areaMatch = headWindow.match(/([\d.,]+(?:\s*-\s*[\d.,]+)?)\s*m²/);
  const precioMatch = headWindow.match(/Precio desde\n\$([\d.,]+)\s*(?:Millones|M)\b/i);
  const entregaMatch = headWindow.match(/^(Entrega[^\n]*)$/im);

  const iAmen = findIndex(lines, (l) => l === "Amenidades", iProyectoEn);
  const iPlanos = findIndex(lines, (l) => l === "Planos y tipos de apartamentos", iAmen === -1 ? iProyectoEn : iAmen);
  const amenities = iAmen !== -1 && iPlanos !== -1 ? lines.slice(iAmen + 1, iPlanos) : [];

  const iUbicacion = findIndex(
    lines,
    (l) => l === "Ubicación y puntos cercanos",
    iPlanos === -1 ? iProyectoEn : iPlanos,
  );
  const floorSlice = iPlanos !== -1 ? lines.slice(iPlanos + 1, iUbicacion !== -1 ? iUbicacion : iPlanos + 80) : [];
  const floorText = floorSlice.join("\n");
  const floorRe = /(\d+)\s*hab\n(\d+)\s*baños\n([\d.,]+)\s*m²\nDesde\n\$([\d.,]+)\s*(?:Millones|M)\b/gi;
  const floorplans: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = floorRe.exec(floorText))) {
    floorplans.push(`${fm[1]} hab, ${fm[2]} baños, ${fm[3]} m², desde $${fm[4]} millones`);
  }

  const iCompradores = findIndex(
    lines,
    (l) => l === "Compradores de este proyecto",
    iUbicacion === -1 ? iProyectoEn : iUbicacion,
  );
  const puntosSlice =
    iUbicacion !== -1 ? lines.slice(iUbicacion + 1, iCompradores !== -1 ? iCompradores : iUbicacion + 40) : [];
  // Vienen en pares categoría + distancia ("Aeropuerto" / "12,0 km caminando").
  // Algunas fichas traen la distancia rota (decenas de km "caminando", un bug
  // del origen) — ahí nos quedamos solo con la categoría, sin inventar un dato.
  const puntosCercanos: string[] = [];
  for (let i = 0; i < puntosSlice.length; i++) {
    const categoria = puntosSlice[i];
    if (/caminando/i.test(categoria)) continue;
    const siguiente = puntosSlice[i + 1];
    const distMatch = siguiente && /caminando/i.test(siguiente) ? siguiente.match(/([\d.,]+)\s*km/i) : null;
    const km = distMatch ? parseFloat(distMatch[1].replace(",", ".")) : NaN;
    puntosCercanos.push(Number.isFinite(km) && km <= 60 ? `${categoria} (~${distMatch![1]} km)` : categoria);
  }

  const iVerificada = findIndex(
    lines,
    (l) => l.startsWith("Verificada por Viventa"),
    iCompradores === -1 ? iProyectoEn : iCompradores,
  );
  const constructorNombre = iVerificada > 0 ? lines[iVerificada - 1] : "";
  const constructorBio = iVerificada !== -1 ? lines[iVerificada] : "";

  const parts: string[] = [ciudadBarrio];
  if (habMatch) parts.push(`Habitaciones: ${habMatch[1]}`);
  if (banosMatch) parts.push(`Baños: ${banosMatch[1]}`);
  if (areaMatch) parts.push(`Área: ${areaMatch[1]} m²`);
  if (precioMatch) parts.push(`Precio desde: $${precioMatch[1]} millones de pesos colombianos`);
  if (entregaMatch) parts.push(entregaMatch[1]);
  if (floorplans.length) parts.push(`Tipos de apartamento disponibles:\n- ${floorplans.join("\n- ")}`);
  if (amenities.length) parts.push(`Amenidades: ${amenities.join(", ")}`);
  if (puntosCercanos.length) parts.push(`Puntos de interés cercanos: ${puntosCercanos.join(", ")}`);
  if (constructorNombre) {
    parts.push(`Constructora: ${constructorNombre}${constructorBio ? " — " + constructorBio : ""}`);
  }

  const content = parts.join("\n\n");
  if (content.length < 30) return null;

  const titleBits = [
    ciudadBarrio,
    habMatch ? `${habMatch[1]} hab` : "",
    precioMatch ? `desde $${precioMatch[1]} millones` : "",
  ].filter(Boolean);

  return { title: titleBits.join(" · ") || ciudadBarrio, content: content.slice(0, MAX_DOC_CHARS) };
}

export interface ImportTickResult {
  processed: number;
  upserted: number;
  failed: number;
  passCompleted: boolean;
  removed: number;
}

/**
 * Sincroniza el catálogo de proyectos de viventa.co/proyectos al KB del bot,
 * en tandas (BATCH_SIZE por tick) para no pasarse del límite de subrequests
 * de un Worker. Pensado para correr en el cron de 5 min — una pasada completa
 * de todo el catálogo toma varias horas y se repite indefinidamente, así el
 * bot nunca queda más de unas horas desactualizado sin que nadie lo toque.
 */
export async function runViventaProyectosImportTick(env: Env): Promise<ImportTickResult> {
  const db = new Db(env.DB);
  const settings = new SettingsRepo(db);
  const repo = new KbDocsRepo(db);

  const storedSlugsRaw = await settings.get(SLUGS_KEY);
  let slugs: string[];
  let cursor: number;

  if (!storedSlugsRaw) {
    slugs = await fetchSitemapSlugs();
    if (slugs.length === 0) {
      return { processed: 0, upserted: 0, failed: 0, passCompleted: false, removed: 0 };
    }
    await settings.set(SLUGS_KEY, JSON.stringify(slugs));
    cursor = 0;
  } else {
    slugs = JSON.parse(storedSlugsRaw);
    const storedCursorRaw = await settings.get(CURSOR_KEY);
    cursor = storedCursorRaw ? parseInt(storedCursorRaw, 10) : 0;
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  }

  const batch = slugs.slice(cursor, cursor + BATCH_SIZE);
  let upserted = 0;
  let failed = 0;

  for (const slug of batch) {
    try {
      const res = await fetchWithTimeout(`https://www.viventa.co/proyectos/${slug}`, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        failed++;
        continue;
      }
      const html = await res.text();
      const fields = extractProjectFields(html);
      if (!fields) {
        failed++;
        continue;
      }
      const doc = { id: `${DOC_ID_PREFIX}${slug}`, title: fields.title, content: fields.content, updated_at: Date.now() };
      await repo.upsert(doc);
      await indexDoc(env, doc);
      upserted++;
    } catch (e) {
      console.error(`[importViventaProyectos] fallo con ${slug}:`, e);
      failed++;
    }
  }

  const newCursor = cursor + batch.length;
  let passCompleted = false;
  let removed = 0;

  if (newCursor >= slugs.length) {
    passCompleted = true;
    const knownRaw = await settings.get(KNOWN_KEY);
    const previouslyKnown: string[] = knownRaw ? JSON.parse(knownRaw) : [];
    const currentSet = new Set(slugs);
    const goneSlugs = previouslyKnown.filter((s) => !currentSet.has(s));

    for (const slug of goneSlugs) {
      try {
        await repo.delete(`${DOC_ID_PREFIX}${slug}`);
        await removeDocVectors(env, `${DOC_ID_PREFIX}${slug}`);
        removed++;
      } catch (e) {
        console.error(`[importViventaProyectos] no se pudo borrar ${slug}:`, e);
      }
    }

    await settings.set(KNOWN_KEY, JSON.stringify(slugs));
    await settings.set(SLUGS_KEY, "");
    await settings.set(CURSOR_KEY, "0");
  } else {
    await settings.set(CURSOR_KEY, String(newCursor));
  }

  return { processed: batch.length, upserted, failed, passCompleted, removed };
}
