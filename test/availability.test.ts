import { describe, it, expect, vi, afterEach } from "vitest";
import {
  availabilityText,
  buildAvailabilityDays,
  buildAvailabilitySvg,
  dayLabel,
  localParts,
} from "../src/media/availability";
import { extraeDisponibilidad } from "../src/replies/sender";
import { signedAvailabilityUrl, verifyAvailabilitySignature } from "../src/media/availability-service";
import type { Env } from "../src/env";

afterEach(() => vi.useRealTimers());

const mk = (date: string, times: string[]) => times.map((t) => `${date}T${t}:00.000+02:00`);

describe("buildAvailabilityDays — solo se tachan reservas reales", () => {
  const base = { timeZone: "Europe/Madrid", fromDate: "2026-10-02", toDate: "2026-10-12" };

  it("un horario con reserva real sale tachado y el resto libre", () => {
    const days = buildAvailabilityDays({
      ...base,
      freeByDate: { "2026-10-05": mk("2026-10-05", ["10:30", "11:00"]) },
      bookedStarts: ["2026-10-05T08:00:00.000Z"],
    });
    expect(days).toHaveLength(1);
    expect(days[0].slots).toEqual([
      { time: "10:00", booked: true },
      { time: "10:30", booked: false },
      { time: "11:00", booked: false },
    ]);
  });

  it("sin reservas no se tacha nada (nunca se inventa ocupación)", () => {
    const days = buildAvailabilityDays({
      ...base,
      freeByDate: { "2026-10-05": mk("2026-10-05", ["10:00", "10:30"]) },
      bookedStarts: [],
    });
    expect(days[0].slots.every((s) => !s.booked)).toBe(true);
  });

  it("convierte las reservas (UTC) a la hora local de la zona", () => {
    expect(localParts("2026-10-05T08:00:00.000Z", "Europe/Madrid")).toEqual({ date: "2026-10-05", time: "10:00" });
    expect(localParts("2026-10-05T22:30:00.000Z", "Europe/Madrid")).toEqual({ date: "2026-10-06", time: "00:30" });
  });

  it("limita a 4 días, descarta fechas fuera del rango y ordena", () => {
    const freeByDate: Record<string, string[]> = {};
    for (const d of ["05", "06", "07", "08", "09"]) freeByDate[`2026-10-${d}`] = mk(`2026-10-${d}`, ["10:00"]);
    freeByDate["2026-09-30"] = mk("2026-09-30", ["10:00"]);
    const days = buildAvailabilityDays({ ...base, freeByDate, bookedStarts: [] });
    expect(days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  });

  it("un día completamente reservado se muestra todo tachado", () => {
    const days = buildAvailabilityDays({
      ...base,
      freeByDate: {},
      bookedStarts: ["2026-10-06T08:00:00.000Z", "2026-10-06T08:30:00.000Z"],
    });
    expect(days[0].slots).toEqual([
      { time: "10:00", booked: true },
      { time: "10:30", booked: true },
    ]);
  });

  it("etiqueta el día en español", () => {
    expect(dayLabel("2026-10-05")).toBe("Lun 5 oct");
    expect(dayLabel("2026-10-07")).toBe("Mié 7 oct");
  });
});

describe("modos día y noche", () => {
  const base = { timeZone: "Europe/Madrid", fromDate: "2026-10-02", toDate: "2026-10-12" };
  const freeByDate = { "2026-10-06": mk("2026-10-06", ["10:00", "15:30", "18:00", "19:30"]) };
  const bookedStarts = ["2026-10-06T08:00:00.000Z", "2026-10-06T16:00:00.000Z"];

  it("por defecto solo muestra horas de día (antes de las 17:00)", () => {
    const days = buildAvailabilityDays({ ...base, freeByDate, bookedStarts });
    expect(days[0].slots).toEqual([
      { time: "10:00", booked: true },
      { time: "15:30", booked: false },
    ]);
  });

  it("modo noche solo muestra desde las 17:00 y tacha las reservas nocturnas", () => {
    const days = buildAvailabilityDays({ ...base, freeByDate, bookedStarts, mode: "noche" });
    expect(days[0].slots).toEqual([
      { time: "18:00", booked: true },
      { time: "19:30", booked: false },
    ]);
  });

  it("un día sin horas en ese modo no aparece", () => {
    const days = buildAvailabilityDays({
      ...base,
      freeByDate: { "2026-10-05": mk("2026-10-05", ["10:00"]), ...freeByDate },
      bookedStarts: [],
      mode: "noche",
    });
    expect(days.map((d) => d.date)).toEqual(["2026-10-06"]);
  });

  it("el subtítulo del SVG cambia en modo noche", () => {
    const days = buildAvailabilityDays({ ...base, freeByDate, bookedStarts, mode: "noche" });
    expect(buildAvailabilitySvg(days, undefined, "noche")).toContain("Horarios nocturnos");
    expect(buildAvailabilitySvg(days)).not.toContain("Horarios nocturnos");
  });

  it("el marcador [[disponibilidad: noche]] activa el modo noche", () => {
    expect(extraeDisponibilidad(["Hola\n[[disponibilidad: noche]]"]).modo).toBe("noche");
    expect(extraeDisponibilidad(["Hola\n[[disponibilidad]]"]).modo).toBe("dia");
  });

  it("la firma depende del modo: una URL de día no vale para noche", async () => {
    const env = { YCLOUD_WEBHOOK_SECRET: "whsec" } as unknown as Env;
    const url = new URL((await signedAvailabilityUrl(env, "https://bot.example.dev", "dia"))!);
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    expect(await verifyAvailabilitySignature(env, exp, sig, "dia")).toBe("ok");
    expect(await verifyAvailabilitySignature(env, exp, sig, "noche")).toBe("invalid");
  });
});

describe("salidas visuales", () => {
  const days = buildAvailabilityDays({
    timeZone: "Europe/Madrid",
    fromDate: "2026-10-02",
    toDate: "2026-10-12",
    freeByDate: { "2026-10-05": mk("2026-10-05", ["10:30"]) },
    bookedStarts: ["2026-10-05T08:00:00.000Z"],
  });

  it("el texto de respaldo usa ~tachado~ de WhatsApp solo en las reservadas", () => {
    expect(availabilityText(days)).toBe("*Lun 5 oct*\n~10:00~  ·  10:30");
  });

  it("el SVG trae una raya por cada horario reservado y declara la zona horaria", () => {
    const svg = buildAvailabilitySvg(days);
    expect(svg.match(/stroke="#C0392B" stroke-width="2.5"/g)).toHaveLength(1);
    expect(svg).toContain("hora de España");
  });
});

describe("marcador [[disponibilidad]]", () => {
  it("lo detecta, lo limpia del texto y no deja el chunk vacío si hay más texto", () => {
    const r = extraeDisponibilidad(["¿Cuál te viene mejor?\n[[disponibilidad]]"]);
    expect(r.pedida).toBe(true);
    expect(r.chunks).toEqual(["¿Cuál te viene mejor?"]);
  });

  it("sin marcador no pide nada", () => {
    const r = extraeDisponibilidad(["Hola"]);
    expect(r.pedida).toBe(false);
    expect(r.chunks).toEqual(["Hola"]);
  });
});

describe("URL firmada de la imagen", () => {
  const env = { YCLOUD_WEBHOOK_SECRET: "whsec" } as unknown as Env;

  it("firma válida pasa y el parámetro alterado falla", async () => {
    const url = new URL((await signedAvailabilityUrl(env, "https://bot.example.dev"))!);
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    expect(url.pathname).toBe("/disponibilidad.png");
    expect(await verifyAvailabilitySignature(env, exp, sig)).toBe("ok");
    expect(await verifyAvailabilitySignature(env, String(Number(exp) + 1), sig)).toBe("invalid");
  });

  it("expira", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
    const url = new URL((await signedAvailabilityUrl(env, "https://bot.example.dev"))!);
    vi.setSystemTime(new Date("2026-10-05T11:00:00Z"));
    expect(await verifyAvailabilitySignature(env, url.searchParams.get("exp"), url.searchParams.get("sig"))).toBe("expired");
  });

  it("sin secreto no firma (fail-closed)", async () => {
    expect(await signedAvailabilityUrl({} as unknown as Env, "https://bot.example.dev")).toBeNull();
  });
});
