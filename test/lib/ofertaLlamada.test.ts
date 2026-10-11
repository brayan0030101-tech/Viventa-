import { describe, it, expect } from "vitest";
import { esOfertaVideollamada } from "../../src/lib/ofertaLlamada";

describe("oferta de videollamada del equipo", () => {
  it("reconoce la invitación a agendar la videollamada", () => {
    expect(esOfertaVideollamada("¡Hola Ana☘️! 😊 Maricela puede llamarte en una videollamada de 30 minutos para orientarte con tu caso. Te parece bien si la agendamos?")).toBe(true);
    expect(esOfertaVideollamada("Podemos programar la videollamada cuando quieras")).toBe(true);
  });
  it("no suelta al bot en una charla normal del equipo", () => {
    expect(esOfertaVideollamada("Hola Ana, ya te envié los proyectos por correo")).toBe(false);
    expect(esOfertaVideollamada("La videollamada fue muy útil, gracias")).toBe(false);
    expect(esOfertaVideollamada("agendamos mañana " + "x".repeat(600) + " videollamada")).toBe(false);
  });
});
