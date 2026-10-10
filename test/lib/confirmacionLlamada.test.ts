import { describe, it, expect } from "vitest";
import { aseguraConfirmacionLlamada } from "../../src/lib/confirmacionLlamada";

const LINK = "https://meet.google.com/abc-defg-hij";
const pasos = (booked: boolean, enlace?: string) => [
  {
    toolCalls: [{ toolCallId: "t1", toolName: "agendarCita", input: { startTime: "2026-10-14T09:30:00.000Z" } }],
    toolResults: [{ toolCallId: "t1", toolName: "agendarCita", output: { booked, ...(enlace ? { enlace } : {}) } }],
  },
];

describe("aseguraConfirmacionLlamada", () => {
  it("sin texto: arma la confirmación con día, hora de España y enlace", () => {
    const t = aseguraConfirmacionLlamada("", pasos(true, LINK));
    expect(t).toContain("miércoles 14 de octubre a las 11:30");
    expect(t).toContain(LINK);
  });
  it("con texto sin enlace: agrega el enlace", () => {
    const t = aseguraConfirmacionLlamada("¡Listo, quedó agendada!", pasos(true, LINK));
    expect(t.startsWith("¡Listo, quedó agendada!")).toBe(true);
    expect(t).toContain(LINK);
  });
  it("si el texto ya trae el enlace, no lo repite", () => {
    const base = `Entra aquí ${LINK}`;
    expect(aseguraConfirmacionLlamada(base, pasos(true, LINK))).toBe(base);
  });
  it("si no se reservó, no toca nada", () => {
    expect(aseguraConfirmacionLlamada("", pasos(false))).toBe("");
    expect(aseguraConfirmacionLlamada("hola", [])).toBe("hola");
  });
});

describe("nota de hora de España en la reserva", () => {
  it("el mismo instante se escribe en hora de España", async () => {
    const { notaHoraEspana } = await import("../../src/tools/servicios");
    // 16:30 UTC = 18:30 en España (CEST) = 11:30 en Colombia: es la MISMA hora, solo cambia la zona.
    expect(notaHoraEspana("2026-10-15T16:30:00.000Z")).toBe("Hora acordada con el cliente: jueves 15 de octubre, 18:30 (hora de España)");
    expect(notaHoraEspana("no es fecha")).toBe("");
  });
});

describe("zona horaria del cliente", () => {
  it("deduce la zona de «País, Ciudad» y muestra la hora local", async () => {
    const { zonaDeResidencia, horaEn, esEspana } = await import("../../src/lib/zonaCliente");
    expect(esEspana(zonaDeResidencia("España, Madrid"))).toBe(true);
    const co = zonaDeResidencia("Colombia, Medellín");
    expect(co?.tz).toBe("America/Bogota");
    expect(horaEn("2026-10-15T17:00:00.000Z", co!.tz)).toBe("12:00");
    expect(zonaDeResidencia("Estados Unidos, Miami")?.tz).toBe("America/New_York");
    expect(zonaDeResidencia("Estados Unidos, Los Ángeles")?.tz).toBe("America/Los_Angeles");
    expect(zonaDeResidencia("")).toBeNull();
    expect(zonaDeResidencia("Narnia")).toBeNull();
  });
  it("la confirmación de respaldo incluye la hora local", () => {
    const pasos = [{
      toolCalls: [{ toolCallId: "t1", toolName: "agendarCita", input: { startTime: "2026-10-15T17:00:00.000Z" } }],
      toolResults: [{ toolCallId: "t1", toolName: "agendarCita", output: { booked: true, enlace: "https://meet.google.com/x", horaLocal: "12:00 en Colombia" } }],
    }];
    expect(aseguraConfirmacionLlamada("", pasos)).toContain("hora de España; 12:00 en Colombia");
  });
});
