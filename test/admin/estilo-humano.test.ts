import { describe, it, expect } from "vitest";
import { saludoDelMomento, ESTILO_HUMANO, ANALISIS_PREVIO } from "../../member/estilo-humano.local";
import { leerBorrador } from "../../member/crm-seguimientos.local";

describe("estilo humano de los mensajes del panel", () => {
  it("el saludo cambia según la hora de España", () => {
    expect(saludoDelMomento(Date.parse("2026-11-24T08:00:00Z"))).toBe("buenos días");
    expect(saludoDelMomento(Date.parse("2026-11-24T14:00:00Z"))).toBe("buenas tardes");
    expect(saludoDelMomento(Date.parse("2026-11-24T21:30:00Z"))).toBe("buenas noches");
  });
  it("pide analizar al cliente antes de escribir y prohíbe inventar enlaces y frases de robot", () => {
    expect(ANALISIS_PREVIO).toMatch(/ANTES de escribir, analiza al cliente/);
    expect(ESTILO_HUMANO).toMatch(/NUNCA escribas ni inventes un enlace/);
    expect(ESTILO_HUMANO).toMatch(/Un abrazo/);
    expect(ESTILO_HUMANO).toMatch(/estimado cliente/);
  });
  it("el campo «analisis» de la IA no estorba al leer el borrador", () => {
    const json = JSON.stringify({ analisis: "Vive en Madrid; quedó en hablar con su esposo.", temperatura: "caliente", accion: "whatsapp", mensaje: "Hola [nombre], buenas tardes, ¿cómo estás? Un abrazo.", dias_siguiente: 2, nota: "Le escribí.", tarea_siguiente: "Llamarla para ver cómo va" });
    const b = leerBorrador(json, { tareaId: "t1", leadId: "1", nombre: "July Parra", creado: 1, modelo: "m" });
    expect(b?.mensaje).toBe("Hola July, buenas tardes, ¿cómo estás? Un abrazo.");
  });
});
