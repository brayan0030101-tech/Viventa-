export interface AvailabilitySlot {
  time: string;
  booked: boolean;
}

export interface AvailabilityDay {
  date: string;
  label: string;
  slots: AvailabilitySlot[];
}

export type AvailabilityMode = "dia" | "noche";
export const NIGHT_FROM = "17:00";

const inMode = (time: string, mode: AvailabilityMode): boolean =>
  mode === "noche" ? time >= NIGHT_FROM : time < NIGHT_FROM;

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}

export function localParts(iso: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/**
 * Cruza los horarios libres con las reservas REALES. Un horario sale tachado
 * solo si existe una reserva en ese minuto: nunca se inventa ocupación.
 * `freeByDate` trae los ISO con la hora local ya aplicada (así los devuelve Cal.com).
 */
export function buildAvailabilityDays(args: {
  freeByDate: Record<string, string[]>;
  bookedStarts: string[];
  timeZone: string;
  fromDate: string;
  toDate: string;
  maxDays?: number;
  mode?: AvailabilityMode;
}): AvailabilityDay[] {
  const { freeByDate, bookedStarts, timeZone, fromDate, toDate, maxDays = 4, mode = "dia" } = args;
  const free = new Map<string, Set<string>>();
  for (const [date, list] of Object.entries(freeByDate)) {
    if (date < fromDate || date > toDate) continue;
    free.set(date, new Set(list.map((s) => s.slice(11, 16)).filter((t) => inMode(t, mode))));
  }
  const booked = new Map<string, Set<string>>();
  for (const iso of bookedStarts) {
    const { date, time } = localParts(iso, timeZone);
    if (date < fromDate || date > toDate || !inMode(time, mode)) continue;
    if (!booked.has(date)) booked.set(date, new Set());
    booked.get(date)!.add(time);
  }
  const dates = [...new Set([...free.keys(), ...booked.keys()])]
    .filter((d) => (free.get(d)?.size ?? 0) + (booked.get(d)?.size ?? 0) > 0)
    .sort()
    .slice(0, maxDays);
  const days: AvailabilityDay[] = [];
  for (const date of dates) {
    const f = free.get(date) ?? new Set<string>();
    const b = booked.get(date) ?? new Set<string>();
    const times = [...new Set([...f, ...b])].sort();
    const slots = times.map((time) => ({ time, booked: b.has(time) }));
    if (slots.length) days.push({ date, label: dayLabel(date), slots });
  }
  return days;
}

export function availabilityText(days: AvailabilityDay[]): string {
  return days
    .map((d) => `*${d.label}*\n${d.slots.map((s) => (s.booked ? `~${s.time}~` : s.time)).join("  ·  ")}`)
    .join("\n\n");
}

const COL_W = 210;
const ROW_H = 36;
const PAD = 28;
const HEAD_H = 118;
const FOOT_H = 64;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildAvailabilitySvg(
  days: AvailabilityDay[],
  tzLabel = "hora de España",
  mode: AvailabilityMode = "dia",
): string {
  const rows = [...new Set(days.flatMap((d) => d.slots.map((s) => s.time)))].sort();
  const width = PAD * 2 + COL_W * Math.max(days.length, 2);
  const height = HEAD_H + 52 + rows.length * ROW_H + FOOT_H;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter">`,
    `<rect width="${width}" height="${height}" fill="#FFFFFF"/>`,
    `<rect width="${width}" height="${HEAD_H}" fill="#12343B"/>`,
    `<text x="${PAD}" y="52" font-size="27" font-weight="700" fill="#FFFFFF">Horarios para tu videollamada</text>`,
    `<text x="${PAD}" y="86" font-size="17" fill="#BFD9D4">${mode === "noche" ? "Horarios nocturnos · " : ""}Videollamada de 30 min · ${esc(tzLabel)}</text>`,
  );
  days.forEach((d, i) => {
    const x = PAD + i * COL_W;
    out.push(
      `<text x="${x + (COL_W - 16) / 2}" y="${HEAD_H + 34}" font-size="18" font-weight="700" fill="#12343B" text-anchor="middle">${esc(d.label)}</text>`,
    );
    rows.forEach((time, r) => {
      const slot = d.slots.find((s) => s.time === time);
      if (!slot) return;
      const y = HEAD_H + 52 + r * ROW_H;
      const w = COL_W - 16;
      if (slot.booked) {
        out.push(
          `<rect x="${x}" y="${y}" width="${w}" height="${ROW_H - 8}" rx="8" fill="#EEF0F2"/>`,
          `<text x="${x + w / 2}" y="${y + 19}" font-size="17" fill="#9AA3AB" text-anchor="middle">${time}</text>`,
          `<line x1="${x + w / 2 - 26}" y1="${y + 13}" x2="${x + w / 2 + 26}" y2="${y + 13}" stroke="#C0392B" stroke-width="2.5" stroke-linecap="round"/>`,
        );
      } else {
        out.push(
          `<rect x="${x}" y="${y}" width="${w}" height="${ROW_H - 8}" rx="8" fill="#E3F4EC"/>`,
          `<text x="${x + w / 2}" y="${y + 19}" font-size="17" font-weight="700" fill="#0B6B4F" text-anchor="middle">${time}</text>`,
        );
      }
    });
  });
  const fy = height - FOOT_H + 30;
  out.push(
    `<rect x="${PAD}" y="${fy - 13}" width="16" height="16" rx="4" fill="#E3F4EC"/>`,
    `<text x="${PAD + 24}" y="${fy}" font-size="15" fill="#4A5A5E">Disponible</text>`,
    `<rect x="${PAD + 130}" y="${fy - 13}" width="16" height="16" rx="4" fill="#EEF0F2"/>`,
    `<line x1="${PAD + 133}" y1="${fy - 5}" x2="${PAD + 143}" y2="${fy - 5}" stroke="#C0392B" stroke-width="2"/>`,
    `<text x="${PAD + 154}" y="${fy}" font-size="15" fill="#4A5A5E">Ya reservado</text>`,
    `</svg>`,
  );
  return out.join("");
}
