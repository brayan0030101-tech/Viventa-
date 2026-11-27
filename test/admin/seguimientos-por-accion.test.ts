import { describe, it, expect } from "vitest";
import { ACCIONES, GUIA_ACCION, leerBorrador, tarjetaBorrador, type Borrador } from "../../member/crm-seguimientos.local";

const base = { tareaId: "t1", leadId: "123456", nombre: "Dani Pérez", creado: 1, modelo: "m" };
const json = (o: Record<string, unknown>) => JSON.stringify({ temperatura: "tibio", accion: "whatsapp", mensaje: "Hola [nombre], ¿cómo estás?", dias_siguiente: 5, nota: "Le escribí.", tarea_siguiente: "Llamarlo", ...o });

describe("cada acción pide su propio mensaje, nota y tarea", () => {
  it("existe la acción «mensaje» (escribir sin llamar) y cada acción tiene su guía", () => {
    expect(ACCIONES).toContain("mensaje");
    for (const a of ACCIONES) expect(GUIA_ACCION[a]).toMatch(new RegExp(`accion = "${a}"`));
    expect(GUIA_ACCION.mensaje).toMatch(/NO menciona ninguna llamada/);
    expect(GUIA_ACCION.whatsapp).toMatch(/intentaste llamar/);
    expect(GUIA_ACCION.futuro).toMatch(/no quieres llenarlo de mensajes/);
    expect(GUIA_ACCION.perdido).toMatch(/despedida/);
    expect(GUIA_ACCION.descartado).toMatch(/NO se escribe mensaje/);
  });
  it("la IA puede proponer «mensaje» y la acción elegida por Maricela manda sobre la de la IA", () => {
    expect(leerBorrador(json({ accion: "mensaje" }), base)?.accion).toBe("mensaje");
    expect(leerBorrador(json({ accion: "whatsapp" }), { ...base, accionForzada: "mensaje" })?.accion).toBe("mensaje");
    expect(leerBorrador(json({ accion: "whatsapp", mensaje: "texto" }), { ...base, accionForzada: "descartado" })?.mensaje).toBe("");
  });
  it("con «escribir sin llamar» la tarjeta no pide llamar primero", () => {
    const b = leerBorrador(json({ accion: "mensaje" }), base) as Borrador;
    const h = tarjetaBorrador(b, { movil: "+34600000000", telefono: "" }, "2026-11-27");
    expect(h).not.toMatch(/Primero llámalo/);
    expect(h).toMatch(/Escríbele directo, sin llamar/);
    const h2 = tarjetaBorrador({ ...b, accion: "whatsapp" }, { movil: "+34600000000", telefono: "" }, "2026-11-27");
    expect(h2).toMatch(/Primero llámalo/);
  });
});
