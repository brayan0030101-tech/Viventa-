/** Nota de seguimiento en Zoho: sin la palabra «bot», una por día, solo si el cliente ya está en Zoho. */
import { describe, it, expect } from "vitest";
import { textoNotaSeguimiento } from "../../member/crm-zohoseguimiento.local";
import { notaSeguimientoZoho } from "../../member/crm-zohoseguimiento.local";

describe("textoNotaSeguimiento", () => {
  it("dice qué se hizo, el canal y el mensaje, sin nombrar al bot", () => {
    const t = textoNotaSeguimiento("ycloud", "Hola Ana, ¿pudiste ver la cotización?", "2026-10-22");
    expect(t).toContain("Seguimiento (2026-10-22)");
    expect(t).toContain("WhatsApp");
    expect(t).toContain("pudiste ver la cotización");
    expect(t.toLowerCase()).not.toMatch(/\bbot\b/);
  });
  it("sin mensaje, queda una frase simple", () => {
    expect(textoNotaSeguimiento("zernio", "", "2026-10-22")).toBe("Seguimiento (2026-10-22): se le volvió a escribir por Instagram para retomar el contacto.");
  });
  it("recorta mensajes largos", () => {
    expect(textoNotaSeguimiento("ycloud", "x".repeat(900), "2026-10-22").length).toBeLessThan(400);
  });
});

describe("notaSeguimientoZoho", () => {
  it("sin credenciales de Zoho no hace nada y no lanza", async () => {
    expect(await notaSeguimientoZoho({ DB: {} } as never, "ycloud:34600000001", "ycloud", "hola")).toBe(false);
  });
});
