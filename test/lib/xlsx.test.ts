import { describe, it, expect } from "vitest";
import { buildXlsx, zipStore } from "../../src/lib/xlsx";

const texto = (b: Uint8Array) => new TextDecoder().decode(b);

describe("buildXlsx", () => {
  it("arma un zip válido con las partes del libro y escapa el texto", () => {
    const b = buildXlsx([{ name: "Listos", rows: [["#", "Nombre"], [1, "Ana & <Co>"]] }]);
    expect([b[0], b[1]]).toEqual([0x50, 0x4b]); // "PK"
    const t = texto(b);
    for (const parte of ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) expect(t).toContain(parte);
    expect(t).toContain("Ana &amp; &lt;Co&gt;");
  });
  it("los enlaces van como relaciones externas (sin límite de 255 caracteres)", () => {
    const url = "https://x.example/f?" + "a=1&".repeat(200);
    const t = texto(buildXlsx([{ name: "L", rows: [["Enlace"], [{ text: "Abrir", url }]] }]));
    expect(t).toContain("worksheets/_rels/sheet1.xml.rels");
    expect(t).toContain('TargetMode="External"');
    expect(t).toContain("a=1&amp;a=1");
    expect(t).toContain('<hyperlink ref="A2" r:id="rId1"/>');
  });
  it("zipStore guarda la longitud y el CRC de cada archivo", () => {
    const z = zipStore([{ name: "a.txt", data: new TextEncoder().encode("hola") }]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(14, true)).toBe(0x6fa0f988); // CRC-32 de «hola»
    expect(dv.getUint32(18, true)).toBe(4); // tamaño comprimido = tamaño real (store)
    expect(dv.getUint32(22, true)).toBe(4);
  });
});
