/**
 * Red de seguridad de la videollamada: si agendarCita reservó de verdad en
 * Cal.com, el cliente SIEMPRE recibe la confirmación con el enlace, aunque el
 * modelo cierre el turno sin escribir nada (pasó en vivo: llegó el correo de
 * Cal.com pero el cliente no recibió ningún mensaje) o se olvide del enlace.
 */

const DIA_HORA = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function cuando(iso: string | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(DIA_HORA.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `el ${p.weekday} ${p.day} de ${p.month} a las ${p.hour}:${p.minute}`;
}

/** ¿Se reservó una videollamada de verdad en este turno? (agendarCita devolvió booked=true) */
export function huboReserva(steps: any[]): boolean {
  return (steps ?? []).some((s) => (s?.toolResults ?? []).some((tr: any) => tr?.toolName === "agendarCita" && (tr.output ?? tr.result)?.booked === true));
}

export function aseguraConfirmacionLlamada(text: string, steps: any[]): string {
  let enlace: string | undefined;
  let startTime: string | undefined;
  let horaLocal: string | undefined;
  for (const s of steps ?? []) {
    for (const tr of s?.toolResults ?? []) {
      if (tr?.toolName !== "agendarCita") continue;
      const out = tr.output ?? tr.result;
      if (out?.booked !== true) continue;
      enlace = typeof out.enlace === "string" ? out.enlace : undefined;
      horaLocal = typeof out.horaLocal === "string" ? out.horaLocal : undefined;
      const call = (s.toolCalls ?? []).find((c: any) => c?.toolCallId === tr.toolCallId);
      startTime = typeof call?.input?.startTime === "string" ? call.input.startTime : startTime;
    }
  }
  if (!enlace || text.includes(enlace)) return text;
  if (text.trim()) return `${text.trim()}\n\nEste es tu enlace para entrar:\n${enlace}`;
  return textoConfirmacion({ startTime, enlace, horaLocal });
}

/** Mensaje de confirmación de la videollamada (el mismo que usa el respaldo del agente y el cron). */
export function textoConfirmacion(args: { startTime?: string; enlace: string; horaLocal?: string }): string {
  const fechaHora = cuando(args.startTime);
  return (
    `¡Listo, quedó agendada tu videollamada${fechaHora ? ` para ${fechaHora} (hora de España${args.horaLocal ? `; ${args.horaLocal}` : ""})` : ""}! 🙌 ` +
    `Maricela te espera en la llamada y estará a tu disposición para darte toda la información que necesitas y aclarar todas tus dudas. ` +
    `Cada vez estás más cerca de cumplir tu sueño de tener tu casa en Colombia 🏡✨\n\n` +
    `Este es tu enlace para entrar:\n${args.enlace}`
  );
}
