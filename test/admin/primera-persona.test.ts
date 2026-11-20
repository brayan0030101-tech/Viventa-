import { describe, it, expect } from "vitest";
import { enPrimeraPersona } from "../../member/crm-zohoapi.local";

describe("notas y tareas en primera persona (como si las escribiera Maricela)", () => {
  it("«el equipo … enviará» pasa a «enviaré»", () => {
    expect(enPrimeraPersona("El equipo comercial de Maricela le enviará los proyectos de Medellín.")).toBe("Le enviaré los proyectos de Medellín.");
    expect(enPrimeraPersona("Quedó en que el equipo le presentará opciones el lunes.")).toBe("Quedó en que le presentaré opciones el lunes.");
    expect(enPrimeraPersona("Maricela le enviará la cotización mañana.")).toBe("Le enviaré la cotización mañana.");
  });

  it("«el equipo tiene que / debe enviar proyectos» pasa a «tengo que enviar proyectos»", () => {
    expect(enPrimeraPersona("El equipo tiene que enviar proyectos")).toBe("Tengo que enviar proyectos");
    expect(enPrimeraPersona("Nota: el equipo debe llamarle esta semana")).toBe("Nota: tengo que llamarle esta semana");
    expect(enPrimeraPersona("El equipo comercial va a revisar su caso")).toBe("Voy a revisar su caso");
    expect(enPrimeraPersona("El equipo quedó en llamarlo el jueves")).toBe("Quedé en llamarlo el jueves");
  });

  it("no toca lo citado entre « » ni textos sin equipo", () => {
    const citado = "Le escribí. Mensaje: «El equipo comercial de Maricela te enviará los proyectos».";
    expect(enPrimeraPersona(citado)).toBe(citado);
    expect(enPrimeraPersona("Enviar proyectos a la cliente y llamarla el viernes.")).toBe("Enviar proyectos a la cliente y llamarla el viernes.");
    expect(enPrimeraPersona("Habló con una persona del equipo de ventas de otra empresa.")).toBe("Habló con una persona del equipo de ventas de otra empresa.");
  });
});
