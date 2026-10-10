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

export function aseguraConfirmacionLlamada(text: string, steps: any[]): string {
  let enlace: string | undefined;
  let startTime: string | undefined;
  for (const s of steps ?? []) {
    for (const tr of s?.toolResults ?? []) {
      if (tr?.toolName !== "agendarCita") continue;
      const out = tr.output ?? tr.result;
      if (out?.booked !== true) continue;
      enlace = typeof out.enlace === "string" ? out.enlace : undefined;
      const call = (s.toolCalls ?? []).find((c: any) => c?.toolCallId === tr.toolCallId);
      startTime = typeof call?.input?.startTime === "string" ? call.input.startTime : startTime;
    }
  }
  if (!enlace || text.includes(enlace)) return text;
  if (text.trim()) return `${text.trim()}\n\nEste es tu enlace para entrar a la videollamada:\n${enlace}`;
  const fechaHora = cuando(startTime);
  return (
    `¡Quedó agendada tu videollamada${fechaHora ? ` para ${fechaHora} (hora de España)` : ""}! 🙌 ` +
    `Maricela te llamará y también te llegó la invitación a tu correo.\n\n` +
    `Este es tu enlace para entrar:\n${enlace}`
  );
}
