import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";

/** Ajuste (D1, sin desplegar): `viventa_botones = apagado` quita TODOS los botones de respuesta (el bot habla solo con texto natural). Sin el ajuste, los botones siguen como siempre. */
export const AJUSTE_BOTONES = "viventa_botones";

export async function botonesApagados(env: Env): Promise<boolean> {
  try {
    return (((await new SettingsRepo(new Db(env.DB)).get(AJUSTE_BOTONES)) ?? "").trim().toLowerCase() === "apagado");
  } catch {
    return false;
  }
}
