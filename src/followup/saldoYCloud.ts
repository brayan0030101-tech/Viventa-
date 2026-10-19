/**
 * Vigila el saldo de la billetera de YCloud. Desde el 1 de octubre de 2026 las respuestas del bot por WhatsApp
 * se cobran después de 1.000 gratis al mes, y con la billetera en cero YCloud RECHAZA los envíos (BALANCE_INSUFFICIENT):
 * el bot calla sin que nadie lo note. Aquí se consulta el saldo (GET /v2/balance) cada hora y se avisa al equipo
 * por Telegram cuando baja de un mínimo, antes de que se acabe.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";

const HORA = 3600_000;
const UMBRAL_USD = 3;
const CRITICO_USD = 0.5;
const REAVISO_MS = 12 * HORA;

export async function runSaldoYCloud(env: Env, now = Date.now()): Promise<{ saldo: number | null; avisado: boolean }> {
  if (!env.YCLOUD_API_KEY) return { saldo: null, avisado: false };
  const settings = new SettingsRepo(new Db(env.DB));
  const ultimaVez = Number((await settings.get("ycloud_saldo_chequeo")) ?? 0) || 0;
  if (now - ultimaVez < HORA - 60_000) return { saldo: null, avisado: false };
  await settings.set("ycloud_saldo_chequeo", String(now)); // se marca antes: si la consulta falla, no se reintenta cada 5 minutos

  let saldo: number;
  try {
    const res = await fetch("https://api.ycloud.com/v2/balance", { headers: { "X-API-Key": env.YCLOUD_API_KEY } });
    if (!res.ok) {
      console.error(`[saldo-ycloud] http ${res.status}`);
      return { saldo: null, avisado: false };
    }
    const j = (await res.json()) as { amount?: number | string; currency?: string };
    saldo = Number(j.amount);
    if (!Number.isFinite(saldo)) return { saldo: null, avisado: false };
    await settings.set("ycloud_saldo_ultimo", `${saldo} ${j.currency ?? "USD"} (${new Date(now).toISOString()})`);
    // Historial para «Gastos ChatBot» del CRM (lo gastado = bajadas de saldo). Nunca tumba la vigilancia.
    try {
      const { registrarSaldo } = await import("../../member/crm-consumo.local");
      await registrarSaldo(env, saldo, now);
    } catch (e) {
      console.error("[saldo-ycloud] historial:", e);
    }
  } catch (e) {
    console.error("[saldo-ycloud]", e);
    return { saldo: null, avisado: false };
  }

  if (saldo >= UMBRAL_USD) {
    await settings.set("ycloud_saldo_aviso", "0"); // al recargar, el próximo aviso vuelve a salir sin esperar
    return { saldo, avisado: false };
  }
  const ultimoAviso = Number((await settings.get("ycloud_saldo_aviso")) ?? 0) || 0;
  if (ultimoAviso && now - ultimoAviso < REAVISO_MS) return { saldo, avisado: false };
  await settings.set("ycloud_saldo_aviso", String(now));
  const { notifyCamila } = await import("../lib/camila");
  await notifyCamila(env, {
    heading: saldo <= CRITICO_USD ? "🔴 Saldo de YCloud casi en cero" : "🟡 Saldo de YCloud bajo",
    body: `Quedan ${saldo.toFixed(2)} USD en la billetera de YCloud. Cada respuesta del bot por WhatsApp cuesta unos 0,02 USD (pasados los 1.000 gratis del mes) y con el saldo en cero el bot NO puede mandar mensajes. Recarga en ycloud.com → Recargar (con 10 a 20 USD alcanza para unas dos semanas).`,
  }).catch(() => false);
  return { saldo, avisado: true };
}
