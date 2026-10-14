// member/cita-manual.local.ts — reserva puntual en Cal.com (temporal): si el ajuste `cita_manual_pedir` trae un JSON
// {start,name,email,phone,notes}, el cron hace la reserva con createBooking y deja el resultado en `cita_manual_resultado`.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { SettingsRepo } from "../src/db/settings";
import { calcomTimeZone, createBooking, resolveEventTypeId } from "../src/integrations/calcom";

export async function runCitaManual(env: Env): Promise<void> {
  const st = new SettingsRepo(new Db(env.DB));
  const raw = ((await st.get("cita_manual_pedir")) ?? "").trim();
  if (!raw.startsWith("{")) return;
  await st.set("cita_manual_pedir", "");
  let out: unknown;
  try {
    const p = JSON.parse(raw) as { start: string; name: string; email: string; phone?: string; notes?: string };
    const eventTypeId = resolveEventTypeId(env);
    if (!eventTypeId) out = { ok: false, reason: "sin_event_type" };
    else out = await createBooking(env, { ...p, eventTypeId, timeZone: calcomTimeZone(env) });
  } catch (e) {
    out = { ok: false, reason: String(e) };
  }
  await st.set("cita_manual_resultado", JSON.stringify(out).slice(0, 2000));
}
