/**
 * GUARDIÁN DE LAS INSTRUCCIONES DEL BOT. Las instrucciones viven en D1 (`settings.custom_instructions`) y han sido editadas desde dos sesiones:
 * el 21 oct una regla desapareció sin que nadie lo notara. Este guardián, en cada pasada del cron:
 *  · guarda una copia (tabla `instrucciones_historial`) cada vez que el texto cambia (se conservan las últimas 40);
 *  · comprueba que sigan las reglas imprescindibles (MARCADORES) y, si falta alguna, avisa a Camila/Brayan una sola vez por versión.
 * En el CRM → «Instrucciones del bot» el administrador ve las versiones y puede restaurar una (siempre guardando antes la actual).
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { notifyCamila } from "../lib/camila";

export const MARCADORES: Array<{ clave: string; texto: string }> = [
  { clave: "base", texto: "SISTEMA DE ATENCION VIVENTA" },
  { clave: "equipo", texto: "NUNCA DIGAS \"ESO ME LO CONFIRMA EL EQUIPO\"" },
  { clave: "cancelacion", texto: "VIDEOLLAMADA CANCELADA O PEDIDA DE NUEVO" },
  { clave: "calificacion", texto: "REGLAS DE CALIFICACION" },
  { clave: "flujo", texto: "FLUJO DESPUES DEL GUION" },
  { clave: "reagendar", texto: "REAGENDAR SIEMPRE LO HACES TU" },
  { clave: "ahorros", texto: "NADIE CON AHORROS O CON BUEN INGRESO SE DESCARTA" },
];

export async function asegurarTablaInstrucciones(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS instrucciones_historial (id INTEGER PRIMARY KEY AUTOINCREMENT, creado INTEGER NOT NULL, largo INTEGER NOT NULL, hash TEXT NOT NULL UNIQUE, texto TEXT NOT NULL, faltan TEXT NOT NULL DEFAULT '', avisado INTEGER NOT NULL DEFAULT 0)");
}

export async function hashTexto(t: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const marcadoresQueFaltan = (texto: string): string[] => MARCADORES.filter((m) => !texto.includes(m.texto)).map((m) => m.clave);

export async function runGuardianInstrucciones(env: Env, now = Date.now()): Promise<{ guardada: boolean; faltan: string[] }> {
  const db = new Db(env.DB);
  await asegurarTablaInstrucciones(db);
  const texto = (await new SettingsRepo(db).get("custom_instructions")) ?? "";
  if (!texto.trim()) return { guardada: false, faltan: [] };
  const hash = await hashTexto(texto);
  const faltan = marcadoresQueFaltan(texto);
  const ya = await db.first<{ id: number }>("SELECT id FROM instrucciones_historial WHERE hash = ?", [hash]);
  if (ya) return { guardada: false, faltan };
  const previa = await db.first<{ largo: number }>("SELECT largo FROM instrucciones_historial ORDER BY id DESC LIMIT 1");
  await db.run("INSERT INTO instrucciones_historial (creado, largo, hash, texto, faltan) VALUES (?,?,?,?,?)", [now, texto.length, hash, texto, faltan.join(",")]);
  await db.run("DELETE FROM instrucciones_historial WHERE id NOT IN (SELECT id FROM instrucciones_historial ORDER BY id DESC LIMIT 40)");
  const encoge = previa && texto.length < previa.largo * 0.9;
  if (faltan.length || encoge) {
    await notifyCamila(env, {
      heading: "⚠️ Las instrucciones del bot cambiaron y falta algo",
      body: `${faltan.length ? `Faltan reglas imprescindibles: ${faltan.join(", ")}.` : ""}${encoge ? ` El texto se hizo ${Math.round((1 - texto.length / previa!.largo) * 100)}% más corto.` : ""}\nEn el CRM → «Instrucciones del bot» (solo administrador) puedes ver las versiones y restaurar la anterior.`,
    }).catch(() => false);
  }
  return { guardada: true, faltan };
}

export interface VersionInstrucciones { id: number; creado: number; largo: number; faltan: string[]; actual: boolean }

export async function versionesInstrucciones(env: Env): Promise<VersionInstrucciones[]> {
  const db = new Db(env.DB);
  await asegurarTablaInstrucciones(db);
  const actual = await hashTexto((await new SettingsRepo(db).get("custom_instructions")) ?? "");
  return (await db.all<{ id: number; creado: number; largo: number; faltan: string; hash: string }>("SELECT id, creado, largo, faltan, hash FROM instrucciones_historial ORDER BY id DESC LIMIT 40"))
    .map((r) => ({ id: r.id, creado: r.creado, largo: r.largo, faltan: r.faltan ? r.faltan.split(",") : [], actual: r.hash === actual }));
}

/** Restaura una versión. Antes guarda la actual (si no estaba ya en el historial). */
export async function restaurarInstrucciones(env: Env, id: number, now = Date.now()): Promise<{ ok: boolean; error?: string }> {
  const db = new Db(env.DB);
  await asegurarTablaInstrucciones(db);
  const v = await db.first<{ texto: string }>("SELECT texto FROM instrucciones_historial WHERE id = ?", [id]);
  if (!v) return { ok: false, error: "No existe esa versión." };
  await runGuardianInstrucciones(env, now); // copia de la actual
  const st = new SettingsRepo(db);
  await st.set("custom_instructions", v.texto);
  await runGuardianInstrucciones(env, now + 1);
  return { ok: true };
}
