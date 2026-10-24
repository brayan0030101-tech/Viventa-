import { describe, it, expect } from "vitest";
import { separarEnlaces } from "../../src/lib/enlaces";

describe("separarEnlaces", () => {
  it("no deja que una palabra se pegue al final del enlace de cotización", () => {
    expect(separarEnlaces("para Cali; https://vivehome.viventa.co/quota-information?id=2585por favor, revísalos")).toBe(
      "para Cali; https://vivehome.viventa.co/quota-information?id=2585 por favor, revísalos",
    );
  });
  it("deja un espacio antes del enlace si venía pegado", () => {
    expect(separarEnlaces("Cali;https://vivehome.viventa.co/quota-information?id=2585")).toBe("Cali; https://vivehome.viventa.co/quota-information?id=2585");
  });
  it("no toca los enlaces bien escritos ni los que van en su propia línea", () => {
    const t = "Hola Ana\n\nhttps://vivehome.viventa.co/quota-information?id=2585\n\nDime qué te parece.";
    expect(separarEnlaces(t)).toBe(t);
    expect(separarEnlaces("Escríbenos (https://wa.me/34611688609?text=Hola%20Ana)")).toBe("Escríbenos (https://wa.me/34611688609?text=Hola%20Ana)");
  });
  it("no parte un enlace que lleva otro enlace dentro", () => {
    const u = "https://x.co/r?u=https://vivehome.viventa.co/quota-information?id=25";
    expect(separarEnlaces(u)).toBe(u);
  });
});
