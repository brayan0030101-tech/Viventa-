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
