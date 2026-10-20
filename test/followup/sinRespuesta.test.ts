/**
 * Cortesías («vale», «gracias»): el auditor no avisa por ellas.
 */
import { describe, it, expect } from "vitest";
import { esCortesia } from "../../src/followup/sinRespuesta";

describe("esCortesia", () => {
  it("vale/gracias no necesitan respuesta; una pregunta sí", () => {
    for (const t of ["Vale", "Gracias 🙏", "Vale perfecto muchas gracias", "👍", "Ok"]) expect(esCortesia(t)).toBe(true);
    expect(esCortesia("Una pregunta para ir mi hermano a ver el proyecto")).toBe(false);
    expect(esCortesia("gracias, ¿y el jueves?")).toBe(false);
  });
});
