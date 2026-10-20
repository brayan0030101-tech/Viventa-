/**
 * Reglas de cotización del bot (aprobadas el 20 oct 2026): cuota del cliente a pesos, ciudades + área metropolitana, elección de proyectos y
 * texto del mensaje. También la lectura de las pantallas de ViveHome (fila de la Calculadora y página pública de la cotización).
 */
import { describe, it, expect } from "vitest";
import { leerCapacidad, ciudadesBuscadas, elegirProyectos, mensualidadEstimada, textoMensaje, primerNombre } from "../../src/vivehome/reglas";
import { filaATipologia, leerTextoPublico, type TipologiaCatalogo } from "../../src/vivehome/navegador";

const TASAS = { eur: 3563, usd: 3174.7 };

describe("cuota mensual del cliente a pesos", () => {
  it("convierte euros y dólares con la tasa de ViveHome y redondea hacia abajo a $50.000", () => {
    expect(leerCapacidad("500 euros mensuales", TASAS)).toMatchObject({ pesos: 1_750_000, moneda: "EUR" });
    expect(leerCapacidad("400€", TASAS)?.pesos).toBe(1_400_000);
    expect(leerCapacidad("1000 dólares", TASAS)).toMatchObject({ pesos: 3_150_000, moneda: "USD" });
  });
  it("entiende pesos escritos de muchas formas", () => {
    expect(leerCapacidad("2 millones COP mensuales", TASAS)?.pesos).toBe(2_000_000);
    expect(leerCapacidad("1.700.900 COP aproximadamente", TASAS)?.pesos).toBe(1_700_000);
    expect(leerCapacidad("600 mil COP", TASAS)?.pesos).toBe(600_000);
    expect(leerCapacidad("1 millón de pesos COP", TASAS)?.pesos).toBe(1_000_000);
    expect(leerCapacidad("3 millones COP o más", TASAS)?.pesos).toBe(3_000_000);
  });
  it("en un rango toma el número menor", () => {
    expect(leerCapacidad("400 a 500 € al mes", TASAS)?.pesos).toBe(1_400_000);
    expect(leerCapacidad("2 a 3 millones COP mensuales", TASAS)?.pesos).toBe(2_000_000);
    expect(leerCapacidad("200-500 dólares", TASAS)?.pesos).toBe(600_000);
    expect(leerCapacidad("Entre 1.000.000 y 1.500.000 COP", TASAS)?.pesos).toBe(1_000_000);
  });
  it("sin moneda clara o sin cifra no se cotiza", () => {
    expect(leerCapacidad("200 al mes", TASAS)).toBeNull();
    expect(leerCapacidad("800 mensual para empezar", TASAS)).toBeNull();
    expect(leerCapacidad("No sabe aún; quiere conocer valor de cuotas", TASAS)).toBeNull();
    expect(leerCapacidad("Flexible, según el proyecto", TASAS)).toBeNull();
    expect(leerCapacidad("", TASAS)).toBeNull();
  });
});

describe("ciudades y área metropolitana", () => {
  const cat = ["Cali", "Jamundí", "Bogotá D.C.", "Soacha", "Pereira", "Dosquebradas", "Medellín", "Bello", "Girón", "Ibagué"];
  it("suma las ciudades vecinas del mismo área, y solo esas", () => {
    expect(ciudadesBuscadas("Cali y alrededores", cat)?.conArea).toEqual(expect.arrayContaining(["Cali", "Jamundí", "Yumbo", "Candelaria", "Palmira"]));
    expect(ciudadesBuscadas("Cali", cat)?.conArea).not.toContain("Pereira");
    expect(ciudadesBuscadas("Ibagué", cat)?.conArea).toEqual(["Ibagué"]);
    expect(ciudadesBuscadas("Medellín y área metropolitana", cat)?.conArea).toContain("Bello");
  });
  it("entiende varias ciudades, tildes y «Bogotá» sin D.C.", () => {
    const r = ciudadesBuscadas("Bogota o Fusagasugá", cat);
    expect(r?.nombradas).toContain("Bogotá D.C.");
    expect(r?.conArea).toContain("Soacha");
    expect(ciudadesBuscadas("Pereira, Risaralda", cat)?.conArea).toContain("Dosquebradas");
  });
  it("«cualquiera menos Bogotá» no es una ciudad", () => {
    expect(ciudadesBuscadas("Cualquiera menos Bogotá", cat)).toBeNull();
  });
  it("una ciudad sin proyectos queda sin ciudades del catálogo", () => {
    expect(ciudadesBuscadas("Neiva, Huila", cat)?.conArea).toEqual([]);
  });
});

const t = (proyecto: string, ciudad: string, valor: number, meses: number, pctMin = 20, area = "50,00"): TipologiaCatalogo => ({ proyecto, ciudad, valor, meses, pctMin, area, segmento: "VIS" });

describe("elección de proyectos", () => {
  it("la mensualidad estimada coincide con una cotización real de ViveHome (Abedules, COT-2189)", () => {
    expect(mensualidadEstimada({ valor: 249_395_630, meses: 31 })).toBe(1_576_774);
  });

  const catalogo = [
    t("831 Pulso", "Cali", 342_554_000, 39),
    t("831 Pulso", "Cali", 321_345_000, 36, 20, "53,00"),
    t("Casas de la vega", "Cali", 175_322_130, 20),
    t("Abedules", "Cali", 249_395_630, 31),
    t("Ambar", "Jamundí", 203_333_000, 35),
    t("Afflora", "Cali", 150_000_000, 32, 15), // mínimo 15 %: no ofrece 20 % en ViveHome
    t("Altum 26", "Cali", 200_000_000, 38, 30),
  ];

  it("si le alcanza: hasta 3 proyectos, el más grande que le cabe de cada uno, los más cercanos a su cuota", () => {
    const e = elegirProyectos(catalogo, ["Cali", "Jamundí", "Yumbo", "Candelaria", "Palmira"], 1_750_000);
    expect(e.tipo).toBe("a_la_medida");
    expect(e.items.map((i) => i.proyecto)).toEqual(["831 Pulso", "Casas de la vega", "Abedules"]);
    expect(e.items[0].valor).toBe(342_554_000); // de 831 Pulso, el más caro que le cabe
    expect(e.items.every((i) => i.mensual <= 1_750_000)).toBe(true);
  });
  it("nunca elige proyectos que no ofrecen cuota inicial del 20 %", () => {
    const e = elegirProyectos(catalogo, ["Cali"], 5_000_000);
    expect(e.items.map((i) => i.proyecto)).not.toContain("Afflora");
    expect(e.items.map((i) => i.proyecto)).not.toContain("Altum 26");
  });
  it("si no le alcanza: las 2 opciones más económicas", () => {
    const e = elegirProyectos(catalogo, ["Cali"], 700_000);
    expect(e.tipo).toBe("mas_economicas");
    expect(e.items.map((i) => i.proyecto)).toEqual(["Abedules", "Casas de la vega"]);
  });
  it("sin proyectos al 20 % en su ciudad: no se cotiza", () => {
    expect(elegirProyectos(catalogo, ["Neiva"], 3_000_000)).toMatchObject({ tipo: "sin_proyectos", motivo: "sin_20" });
  });
  it("tope de seguridad: nunca ofrece algo que cueste más de 2,5 veces su cuota", () => {
    const neiva = [t("Primavera Verde", "Neiva", 180_000_000, 5)]; // $7.000.000 al mes
    expect(elegirProyectos(neiva, ["Neiva"], 700_000)).toMatchObject({ tipo: "sin_proyectos", motivo: "muy_caro" });
    const e = elegirProyectos(catalogo, ["Cali"], 640_000); // Abedules 2,46× entra; Casas de la vega 2,66× no
    expect(e.items.map((i) => i.proyecto)).toEqual(["Abedules"]);
  });
});

describe("mensaje al cliente", () => {
  it("a la medida: enlace, ejemplo con cifras y una sola pregunta", () => {
    const m = textoMensaje({ nombre: "Laura", tipo: "a_la_medida", enlace: "https://vivehome.viventa.co/quota-information?id=2500", ciudades: ["Cali", "Jamundí", "Cali"], n: 3, ejemplo: { proyecto: "Abedules", mensualidad: 1_576_774, meses: 31 } });
    expect(m).toContain("¡Hola, Laura!");
    expect(m).toContain("3 opciones en Cali y Jamundí");
    expect(m).toContain("quota-information?id=2500");
    expect(m).toContain("Abedules serían $1.576.774 al mes durante 31 meses");
    expect(m.match(/\?/g)?.length).toBe(2); // la del enlace y la única pregunta
  });
  it("no alcanza: texto honesto, sin prometer que le alcanza", () => {
    const m = textoMensaje({ nombre: "", tipo: "mas_economicas", enlace: "X", ciudades: ["Bogotá D.C."], n: 2, ejemplo: { proyecto: "Alborada", mensualidad: 1_731_643, meses: 28 } });
    expect(m).toContain("las 2 opciones más económicas que hay hoy en Bogotá");
    expect(m).toContain("queda por encima de lo que me comentaste");
    expect(m).not.toMatch(/se ajusta|puedes pagar/);
  });
  it("si las opciones son de una ciudad vecina, lo aclara", () => {
    const m = textoMensaje({ nombre: "Ana", tipo: "mas_economicas", enlace: "X", ciudades: ["Jamundí", "Jamundí"], ciudadCliente: "Cali", n: 2, ejemplo: { proyecto: "Ambar", mensualidad: 1_133_343, meses: 35 } });
    expect(m).toContain("que hay hoy en Jamundí, muy cerca de Cali:");
    const m2 = textoMensaje({ nombre: "Ana", tipo: "a_la_medida", enlace: "X", ciudades: ["Bogotá D.C."], ciudadCliente: "Bogotá D.C.", n: 1, ejemplo: { proyecto: "Alborada", mensualidad: 1, meses: 1 } });
    expect(m2).toContain("una opción en Bogotá que se ajusta");
    expect(m2).not.toContain("muy cerca");
    expect(m2).toContain("En Alborada serían");
    expect(m2).toContain("¿Qué te parece?");
    expect(m2).not.toContain("¿Cuál");
  });
  it("usa el primer nombre real (no un usuario de Instagram)", () => {
    expect(primerNombre("maria fernanda lópez")).toBe("Maria");
    expect(primerNombre("jhon_f", "Jhon")).toBe("Jhon");
  });
});

describe("pantallas de ViveHome", () => {
  it("lee una fila de la Calculadora", () => {
    const f = filaATipologia(["Abedules", "Cali", "50,00 m² 31 meses de plazo", "Renta tradicional", "$1.609.004 €452", "$249.395.630 €69.988", "20,0% $49.879.126", "VIS", "Seleccionar"]);
    expect(f).toEqual({ proyecto: "Abedules", ciudad: "Cali", area: "50,00", meses: 31, valor: 249_395_630, pctMin: 20, segmento: "VIS" });
  });
  it("lee la página pública de una cotización", () => {
    const texto = `Cotización para\n\nPRUEBA BOT\n\nTRM USD\n\n$3.174,70\n\nVerificado\nVer Galería\nCali\n20% inicial\n\nABEDULES\n\nValor del Proyecto\n$249.395.630\nValor Cuota Inicial (20%)\n$49.880.000\nValor Separación\n$1.000.000\nSaldo Cuota Inicial\n$48.880.000\nMensualidad (31 meses)\n$1.576.774\nSaldo Final (80%)\n$199.515.630\nHablar con Maricela`;
    expect(leerTextoPublico(texto)).toEqual({ cliente: "PRUEBA BOT", proyectos: [{ ciudad: "Cali", pct: 20, proyecto: "ABEDULES", valor: 249_395_630, meses: 31, mensualidad: 1_576_774 }] });
  });
});
