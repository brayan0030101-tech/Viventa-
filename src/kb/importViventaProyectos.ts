import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { KbDocsRepo, indexDoc, removeDocVectors, MAX_DOC_CHARS } from "./docs";

const SITEMAP_URL = "https://www.viventa.co/sitemap.xml";
const PROYECTOS_RE = /<loc>\s*(https?:\/\/(?:www\.)?viventa\.co\/proyectos\/([a-z0-9-]+))\s*<\/loc>/gi;
// Medido con logs reales (2026-09-28): indexDoc (embedding + Vectorize) cuesta
// ~1.3-2.7s por proyecto SOLO — es el costo real, no un bug. Con 15/tanda el
// tick pasaba de 40s y Cloudflare lo cortaba. 6 deja margen amplio.
const BATCH_SIZE = 6;
const FETCH_TIMEOUT_MS = 12_000;
const DOC_ID_PREFIX = "proyecto:";

const SLUGS_KEY = "viventa_proyectos_slugs_pass";
const CURSOR_KEY = "viventa_proyectos_cursor";
const KNOWN_KEY = "viventa_proyectos_known_slugs";
// Seguro anti-trabe: si el mismo slug tira el tick 2 veces seguidas (lo que
// sea — CPU, memoria, un bug futuro), a la tercera se lo salta directo, sin
// ni intentar procesarlo. Nunca más se puede quedar pegado para siempre en
// un solo proyecto — pase lo que pase ahí, el catálogo sigue avanzando.
const ATTEMPT_SLUG_KEY = "viventa_proyectos_attempt_slug";
const ATTEMPT_COUNT_KEY = "viventa_proyectos_attempt_count";
const MAX_ATTEMPTS_PER_SLUG = 2;

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

// Saca el contenido de un tipo de tag (script/style/noscript). Primer intento
// (regex con backreferencia + [\s\S]*?) causó backtracking catastrófico en
// una página real. El segundo intento (indexOf con rest.toLowerCase() en cada
// vuelta) seguía copiando el string remanente ENTERO en cada tag encontrado —
// en una página con muchos scripts eso es igual de lento. Esta versión busca
// con regex.exec + lastIndex sobre el string ORIGINAL: nunca copia ni
// recorta el string durante la búsqueda, solo arma `out` por trozos al final.
function stripTagBlocks(html: string, tag: string): string {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`<\\/${tag}\\s*>`, "gi");
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    if (m.index < cursor) continue; // ya quedó cubierto por un bloque anterior
    out += html.slice(cursor, m.index);
    closeRe.lastIndex = openRe.lastIndex;
    const cm = closeRe.exec(html);
    if (!cm) {
      cursor = html.length; // sin cierre: se descarta el resto, nunca se cuelga
      break;
    }
    cursor = closeRe.lastIndex;
    openRe.lastIndex = cursor;
  }
  out += html.slice(cursor);
  return out;
}

// Cap defensivo: una página fuera de lo normal (mucho más pesada que las
// ~100-150KB típicas de este sitio) se salta entera en vez de arriesgar CPU.
const MAX_HTML_BYTES = 250_000;

function htmlToLines(html: string): string[] {
  let noScripts = html;
  for (const tag of ["script", "style", "noscript"]) {
    noScripts = stripTagBlocks(noScripts, tag);
  }
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

  // REGLA DE ORO del dueño (2026-09-25): el bot NUNCA debe decir el nombre del
  // proyecto ni el de la constructora — por eso ninguno de los dos entra acá.
  // El nombre comercial del proyecto tampoco se captura en ningún otro campo.

  const parts: string[] = [ciudadBarrio];
  if (habMatch) parts.push(`Habitaciones: ${habMatch[1]}`);
  if (banosMatch) parts.push(`Baños: ${banosMatch[1]}`);
  if (areaMatch) parts.push(`Área: ${areaMatch[1]} m²`);
  if (precioMatch) parts.push(`Precio desde: $${precioMatch[1]} millones de pesos colombianos`);
  if (entregaMatch) parts.push(entregaMatch[1]);
  if (floorplans.length) parts.push(`Tipos de apartamento disponibles:\n- ${floorplans.join("\n- ")}`);
  if (amenities.length) parts.push(`Amenidades: ${amenities.join(", ")}`);
  if (puntosCercanos.length) parts.push(`Puntos de interés cercanos: ${puntosCercanos.join(", ")}`);

  const content = parts.join("\n\n");
  if (content.length < 30) return null;

  const titleBits = [
    ciudadBarrio,
    habMatch ? `${habMatch[1]} hab` : "",
    precioMatch ? `desde $${precioMatch[1]} millones` : "",
  ].filter(Boolean);

  return { title: titleBits.join(" · ") || ciudadBarrio, content: content.slice(0, MAX_DOC_CHARS) };
}

// Foto de portada (render/fachada) — es la que muestra la página como imagen
// principal del proyecto. Se busca en el HTML crudo (antes de sacar las
// etiquetas), no en las líneas de texto.
function extractCoverImageUrl(html: string): string | null {
  const m = html.match(/<img[^>]*class="det-main-img"[^>]*\ssrc="([^"]+)"/i);
  return m ? decodeEntities(m[1]) : null;
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

  for (let i = 0; i < batch.length; i++) {
    const slug = batch[i];

    // Seguro anti-trabe: si este slug ya falló MAX_ATTEMPTS_PER_SLUG veces
    // seguidas (el tick se cortó antes de terminarlo, sea cual sea la razón),
    // se lo salta sin ni intentarlo — nunca más se puede quedar pegado para
    // siempre en un solo proyecto.
    const attemptSlugRaw = await settings.get(ATTEMPT_SLUG_KEY);
    const attemptCountRaw = await settings.get(ATTEMPT_COUNT_KEY);
    const priorAttempts = attemptSlugRaw === slug ? parseInt(attemptCountRaw ?? "0", 10) || 0 : 0;

    if (priorAttempts >= MAX_ATTEMPTS_PER_SLUG) {
      console.error(`[importViventaProyectos] ${slug}: se salta tras ${priorAttempts} fallos seguidos (seguro anti-trabe)`);
      failed++;
      await settings.set(ATTEMPT_SLUG_KEY, "");
      await settings.set(ATTEMPT_COUNT_KEY, "0");
      await settings.set(CURSOR_KEY, String(cursor + i + 1));
      continue;
    }
    // Se marca el intento ANTES de arriesgar el trabajo pesado (fetch +
    // extracción), para que sobreviva aunque el tick se corte a mitad.
    await settings.set(ATTEMPT_SLUG_KEY, slug);
    await settings.set(ATTEMPT_COUNT_KEY, String(priorAttempts + 1));

    // Medición temporal (2026-09-28): "Exceeded CPU Limit" real en el cron sin
    // saber en qué paso — se saca apenas se confirme dónde está.
    const tSlug = Date.now();
    try {
      const res = await fetchWithTimeout(`https://www.viventa.co/proyectos/${slug}`, FETCH_TIMEOUT_MS);
      console.log(`[importViventaProyectos] ${slug} fetch: ${Date.now() - tSlug}ms`);
      if (!res.ok) {
        failed++;
      } else {
        const tText = Date.now();
        const html = await res.text();
        console.log(`[importViventaProyectos] ${slug} res.text(): ${Date.now() - tText}ms (${html.length} bytes)`);
        if (html.length > MAX_HTML_BYTES) {
          console.error(`[importViventaProyectos] ${slug}: página de ${html.length} bytes, se salta (cap ${MAX_HTML_BYTES})`);
          failed++;
        } else {
          const tExtract = Date.now();
          const fields = extractProjectFields(html);
          console.log(`[importViventaProyectos] ${slug} extractProjectFields: ${Date.now() - tExtract}ms`);
          if (!fields) {
            failed++;
          } else {
            const doc = { id: `${DOC_ID_PREFIX}${slug}`, title: fields.title, content: fields.content, updated_at: Date.now() };
            const tUpsert = Date.now();
            await repo.upsert(doc);
            console.log(`[importViventaProyectos] ${slug} repo.upsert: ${Date.now() - tUpsert}ms`);
            const tIndex = Date.now();
            await indexDoc(env, doc);
            console.log(`[importViventaProyectos] ${slug} indexDoc: ${Date.now() - tIndex}ms`);

            const coverUrl = extractCoverImageUrl(html);
            if (coverUrl) {
              await db.run(
                `INSERT INTO project_photos (slug, title, cover_url, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(slug) DO UPDATE SET title = excluded.title, cover_url = excluded.cover_url, updated_at = excluded.updated_at`,
                [slug, fields.title, coverUrl, Date.now()],
              );
            }
            upserted++;
          }
        }
      }
    } catch (e) {
      console.error(`[importViventaProyectos] fallo con ${slug}:`, e);
      failed++;
    }
    // Progreso guardado DESPUÉS DE CADA slug, no solo al final del lote: si un
    // tick se corta a mitad de camino (CPU/red), el próximo arranca justo
    // donde quedó — nunca reprocesa el lote entero ni queda pegado por uno solo.
    await settings.set(CURSOR_KEY, String(cursor + i + 1));
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
        await db.run("DELETE FROM project_photos WHERE slug = ?", [slug]);
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
