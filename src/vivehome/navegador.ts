/**
 * ViveHome (vivehome.viventa.co) manejado con un navegador. ViveHome es una app Blazor Server: no tiene API para cotizaciones, todo pasa por la
 * pantalla. Aquí están los pasos que hace Maricela, escritos para Playwright (en el Worker con Cloudflare Browser Rendering; en local con Playwright):
 *  · entrar con su cuenta;
 *  · leer el catálogo de la Calculadora (proyecto, ciudad, área, meses, valor, % mínimo de cuota inicial) y las tasas del euro y del dólar;
 *  · crear una cotización: Cliente → Inmuebles → Configuración (20 %, casilla «Reportar a la constructora» DESMARCADA) → «Crear Cotización»;
 *  · leer la página pública de la cotización (lo que ve el cliente) para usar en el mensaje las cifras exactas.
 * Si la pantalla cambia (no aparece un botón, un campo o un texto esperado) se lanza `ErrorPantalla` con el paso: el que llama lo convierte en
 * hallazgo del auditor y aviso al equipo, nunca falla callado. La contraseña nunca se escribe en errores ni registros.
 */
export const VIVEHOME = "https://vivehome.viventa.co";
export const URL_PUBLICA = `${VIVEHOME}/quota-information?id=`;

/** Lo mínimo de Playwright que se usa (sirve para @cloudflare/playwright y para el Playwright de Node). */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Pagina = any;

export class ErrorPantalla extends Error {
  constructor(
    public paso: string,
    detalle: string,
  ) {
    super(`ViveHome cambió o no respondió en «${paso}»: ${detalle}`);
    this.name = "ErrorPantalla";
  }
}

export interface TipologiaCatalogo {
  proyecto: string;
  ciudad: string;
  area: string;
  meses: number;
  valor: number;
  pctMin: number;
  segmento: string;
}

export interface Catalogo {
  tipologias: TipologiaCatalogo[];
  eur: number;
  usd: number;
}

const espera = (page: Pagina, ms: number) => page.waitForTimeout(ms);
const numero = (s: string) => Number(String(s).replace(/[^\d]/g, "")) || 0;

async function textoPagina(page: Pagina): Promise<string> {
  return (await page.innerText("body").catch(() => "")) as string;
}

/** Pulsa el primer botón visible cuyo texto sea exactamente `texto` (o el último, si `ultimo`). */
async function pulsarBoton(page: Pagina, texto: string, paso: string, ultimo = false): Promise<void> {
  const botones = await page.$$("button");
  const candidatos: Pagina[] = [];
  for (const b of botones) {
    const t = ((await b.innerText().catch(() => "")) as string).trim();
    if (t === texto && (await b.isVisible().catch(() => false))) candidatos.push(b);
  }
  const b = ultimo ? candidatos[candidatos.length - 1] : candidatos[0];
  if (!b) throw new ErrorPantalla(paso, `no aparece el botón «${texto}»`);
  await b.click({ force: true });
}

async function escribir(page: Pagina, campo: Pagina, valor: string): Promise<void> {
  await campo.click({ force: true });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  if (valor) await page.keyboard.type(valor, { delay: 15 });
}

export async function entrar(page: Pagina, usuario: string, clave: string): Promise<void> {
  if (!usuario || !clave) throw new ErrorPantalla("entrar", "faltan las credenciales de ViveHome (secretos VIVEHOME_USER / VIVEHOME_PASSWORD)");
  await page.goto(`${VIVEHOME}/login`, { waitUntil: "networkidle", timeout: 45_000 });
  const correo = await page.$("#viventa-login-credential");
  const pass = await page.$("#viventa-login-password");
  if (!correo || !pass) throw new ErrorPantalla("entrar", "no aparece el formulario de acceso");
  await correo.fill(usuario);
  await pass.fill(clave);
  await pulsarBoton(page, "Iniciar sesión", "entrar");
  for (let i = 0; i < 20; i++) {
    await espera(page, 1000);
    if (!/\/login/i.test(page.url())) return;
  }
  throw new ErrorPantalla("entrar", "no se pudo iniciar sesión (¿cambió la contraseña?)");
}

// ─── Catálogo de la Calculadora ──────────────────────────────────────────────

async function tasaVisible(page: Pagina, moneda: "USD" | "EUR"): Promise<number> {
  const botones = await page.$$("button");
  for (const b of botones) {
    const t = ((await b.innerText().catch(() => "")) as string).trim();
    if (t.startsWith(moneda)) {
      await b.click({ force: true });
      break;
    }
  }
  await espera(page, 2000);
  const valores = (await page.$$eval("input", (els: any[]) => els.map((e) => e.value))) as string[];
  // El primer campo es la tasa (p. ej. «3.563» o «3.174,70»).
  const v = Number(String(valores[0] ?? "").replace(/\./g, "").replace(",", "."));
  if (!(v > 1000 && v < 10000)) throw new ErrorPantalla("calculadora", `tasa ${moneda} ilegible («${valores[0] ?? ""}»)`);
  return v;
}

export function filaATipologia(celdas: string[]): TipologiaCatalogo | null {
  if (celdas.length < 8) return null;
  const [proyecto, ciudad, tip, , , precio, inicial, segmento] = celdas;
  const meses = Number(/(\d+)\s*meses/.exec(tip)?.[1] ?? 0);
  const pct = Number((/([\d,]+)\s*%/.exec(inicial)?.[1] ?? "").replace(",", "."));
  const valor = numero(precio.split("€")[0]);
  if (!proyecto || !ciudad || !meses || !valor || !pct) return null;
  return { proyecto: proyecto.trim(), ciudad: ciudad.trim(), area: tip.split("m²")[0].trim(), meses, valor, pctMin: pct, segmento: (segmento ?? "").trim() };
}

/** Lee todo el catálogo de la Calculadora (≈1.000 tipologías, 50 páginas) y las tasas del euro y del dólar. */
export async function leerCatalogo(page: Pagina): Promise<Catalogo> {
  await page.goto(`${VIVEHOME}/calculadora-viventa`, { waitUntil: "networkidle", timeout: 45_000 });
  await espera(page, 3000);
  if (!(await textoPagina(page)).includes("Proyectos dentro de la capacidad")) throw new ErrorPantalla("calculadora", "no carga la Calculadora");
  const usd = await tasaVisible(page, "USD");
  const eur = await tasaVisible(page, "EUR");
  // Capacidad muy alta para que entren todas las tipologías.
  const campos = await page.$$("input");
  if (!campos[1]) throw new ErrorPantalla("calculadora", "no aparece el campo de capacidad mensual");
  await escribir(page, campos[1], "90000000");
  await page.keyboard.press("Tab");
  await espera(page, 4000);
  const tipologias: TipologiaCatalogo[] = [];
  let anterior = "";
  for (let p = 0; p < 120; p++) {
    const filas = (await page.$$eval("table tr", (trs: any[]) =>
      trs.map((tr) => [...tr.querySelectorAll("td")].map((td: any) => String(td.innerText).replace(/\s+/g, " ").trim())).filter((r: string[]) => r.length > 5),
    )) as string[][];
    const clave = JSON.stringify(filas[0] ?? []);
    if (!filas.length || clave === anterior) break;
    anterior = clave;
    for (const f of filas) {
      const t = filaATipologia(f);
      if (t) tipologias.push(t);
    }
    const sig = await page.$('button[title="Pager_Next"], button[aria-label="Pager_Next"]');
    if (!sig || (await sig.evaluate((b: any) => b.disabled || b.classList.contains("k-disabled")))) break;
    await sig.click({ force: true });
    await espera(page, 1200);
  }
  if (tipologias.length < 50) throw new ErrorPantalla("calculadora", `solo se leyeron ${tipologias.length} tipologías`);
  return { tipologias, eur, usd };
}

// ─── Crear cotización ────────────────────────────────────────────────────────

export interface PedidoCotizacion {
  nombre: string;
  correo: string;
  telefono: string;
  /** Tipologías a cotizar (máx. 3): se buscan por nombre del proyecto y valor exacto. */
  items: Array<{ proyecto: string; valor: number }>;
}

export interface ResultadoCreacion {
  cotId: string | null;
  /** Ensayo: llegó hasta el último paso sin pulsar «Crear Cotización». */
  ensayo: boolean;
  resumen: string;
}

const pesos = (n: number) => `$ ${n.toLocaleString("es-CO").replace(/,/g, ".")}`;

async function elegirInmueble(page: Pagina, item: { proyecto: string; valor: number }, i: number): Promise<void> {
  const paso = `inmueble ${item.proyecto}`;
  // Buscador «Buscar proyecto...» encima de las tarjetas.
  const buscador = await page.$('input[placeholder^="Buscar proyecto"]');
  if (!buscador) throw new ErrorPantalla(paso, "no aparece el buscador «Buscar proyecto…»");
  await escribir(page, buscador, item.proyecto);
  await page.keyboard.press("Enter");
  await espera(page, 3500);
  // Tarjeta con ese proyecto y ese valor.
  const precio = pesos(item.valor);
  const tarjeta = page.locator("div", { hasText: item.proyecto }).filter({ hasText: precio }).last();
  if ((await tarjeta.count()) === 0) throw new ErrorPantalla(paso, `no aparece la tarjeta con valor ${precio}`);
  await tarjeta.click({ force: true });
  await espera(page, 2000);
  const n = Number(/Selecciona hasta 3 inmuebles \((\d)\/3\)/.exec(await textoPagina(page))?.[1] ?? -1);
  if (n !== i + 1) throw new ErrorPantalla(paso, `después de elegirlo el contador marca ${n}/3 (se esperaba ${i + 1}/3)`);
}

/** Deja cada «Cuota Inicial (%)» en 20 %. */
async function cuotaInicial20(page: Pagina): Promise<void> {
  const listas = await page.$$(".k-dropdownlist, .k-picker");
  for (const l of listas) {
    const t = ((await l.innerText().catch(() => "")) as string).trim();
    if (!/%/.test(t) || t.startsWith("20%")) continue;
    await l.click({ force: true });
    await espera(page, 800);
    const opcion = page.locator(".k-list-item, .k-popup li", { hasText: /^20%$/ }).first();
    if ((await opcion.count()) === 0) throw new ErrorPantalla("configuración", `el proyecto no permite cuota inicial del 20 % (muestra ${t})`);
    await opcion.click({ force: true });
    await espera(page, 800);
  }
  const textos = (await page.$$eval(".k-dropdownlist, .k-picker", (els: any[]) => els.map((e) => String(e.innerText).trim()))) as string[];
  const malos = textos.filter((t) => /%/.test(t) && !t.startsWith("20%"));
  if (malos.length) throw new ErrorPantalla("configuración", `cuota inicial distinta de 20 %: ${malos.join(", ")}`);
}

/**
 * Crea una cotización. Con `ensayo` llega hasta «Configuración» (deja todo listo y comprobado) y sale sin pulsar «Crear Cotización»:
 * sirve para probar sin dejar cotizaciones en ViveHome (no se pueden borrar).
 */
export async function crearCotizacion(page: Pagina, p: PedidoCotizacion, opts: { ensayo?: boolean } = {}): Promise<ResultadoCreacion> {
  if (!p.items.length || p.items.length > 3) throw new Error("una cotización lleva de 1 a 3 inmuebles");
  await page.goto(`${VIVEHOME}/home/quotes?action=wizard`, { waitUntil: "networkidle", timeout: 45_000 });
  await espera(page, 2500);
  if (!(await textoPagina(page)).includes("Información del Cliente")) throw new ErrorPantalla("cliente", "no carga el asistente «Nueva Cotización»");

  // 1. Cliente: nombre (el campo autocompleta prospectos: se escribe y se sale con un clic afuera), correo y teléfono.
  let campos = await page.$$("input");
  if (campos.length < 3) throw new ErrorPantalla("cliente", "faltan los campos nombre / correo / teléfono");
  const afuera = async () => {
    await page.getByText("Información del Cliente", { exact: true }).first().click({ force: true });
    await espera(page, 800);
  };
  await escribir(page, campos[0], p.nombre);
  await espera(page, 1200);
  await afuera();
  campos = await page.$$("input");
  await escribir(page, campos[1], p.correo);
  campos = await page.$$("input");
  await escribir(page, campos[2], p.telefono);
  await afuera();
  const valores = (await page.$$eval("input", (els: any[]) => els.slice(0, 3).map((e) => e.value))) as string[];
  if (valores[0] !== p.nombre || valores[1] !== p.correo || valores[2] !== p.telefono) throw new ErrorPantalla("cliente", `los datos del cliente no quedaron escritos (${valores.map((v) => (v ? "ok" : "vacío")).join(", ")})`);
  await pulsarBoton(page, "Siguiente", "cliente", true);
  await espera(page, 4000);
  if (!(await textoPagina(page)).includes("Selección de Inmuebles")) throw new ErrorPantalla("inmuebles", "no pasó al paso «Inmuebles»");

  // 2. Inmuebles.
  for (const [i, it] of p.items.entries()) await elegirInmueble(page, it, i);
  await pulsarBoton(page, "Siguiente", "inmuebles", true);
  await espera(page, 4000);
  const t3 = await textoPagina(page);
  if (!t3.includes("Resumen y Configuración Final")) throw new ErrorPantalla("configuración", "no pasó al paso «Configuración»");

  // 3. Configuración: 20 % y casilla de la constructora desmarcada.
  await cuotaInicial20(page);
  const casillas = await page.$$("input[type=checkbox]");
  if (casillas.length !== 1) throw new ErrorPantalla("configuración", `se esperaba una sola casilla («Reportar a la constructora») y hay ${casillas.length}`);
  if (await casillas[0].isChecked()) await casillas[0].click({ force: true });
  await espera(page, 1000);
  if (await casillas[0].isChecked()) throw new ErrorPantalla("configuración", "no se pudo desmarcar «Reportar a la constructora»");
  const resumen = (t3.split("Configuración de Proyectos")[1] ?? "").split("Reportar a la constructora")[0].replace(/\s+/g, " ").trim();
  if (opts.ensayo) return { cotId: null, ensayo: true, resumen };

  // 4. Crear y buscar el número en el listado (el más nuevo con este nombre y correo).
  await pulsarBoton(page, "Crear Cotización", "crear");
  let creada = false;
  for (let i = 0; i < 20 && !creada; i++) {
    await espera(page, 1000);
    creada = (await textoPagina(page)).includes("Cotización Creada");
  }
  if (!creada) throw new ErrorPantalla("crear", "no apareció el aviso «¡Cotización Creada!»");
  const cotId = await buscarNumero(page, p);
  return { cotId, ensayo: false, resumen };
}

async function buscarNumero(page: Pagina, p: PedidoCotizacion): Promise<string> {
  await page.goto(`${VIVEHOME}/home/quotes`, { waitUntil: "networkidle", timeout: 45_000 });
  await espera(page, 3000);
  const filas = (await page.$$eval("tr", (trs: any[]) => trs.map((tr) => String(tr.innerText).replace(/\s+/g, " ").trim()))) as string[];
  const fila = filas.find((f) => f.includes(p.nombre) && f.toLowerCase().includes(p.correo.toLowerCase()) && /^COT-\d+/.test(f));
  const id = /^COT-(\d+)/.exec(fila ?? "")?.[1];
  if (!id) throw new ErrorPantalla("crear", "se creó la cotización pero no aparece en el listado (revisarla a mano en ViveHome)");
  return id;
}

// ─── Página pública (lo que ve el cliente) ───────────────────────────────────

export interface ProyectoPublico {
  proyecto: string;
  ciudad: string;
  pct: number;
  valor: number;
  mensualidad: number;
  meses: number;
}

export function leerTextoPublico(t: string): { cliente: string; proyectos: ProyectoPublico[] } {
  const cliente = (/Cotización para\s*\n+\s*([^\n]+)/.exec(t)?.[1] ?? "").trim();
  const proyectos: ProyectoPublico[] = [];
  const re = /\n([^\n]+)\n(\d+)% inicial\s*\n+([^\n]+)\n[\s\S]*?Valor del Proyecto\s*\n\$([\d.]+)[\s\S]*?Mensualidad \((\d+) meses\)\s*\n\$([\d.]+)/g;
  for (const m of t.matchAll(re)) {
    proyectos.push({ ciudad: m[1].trim(), pct: Number(m[2]), proyecto: m[3].trim(), valor: numero(m[4]), meses: Number(m[5]), mensualidad: numero(m[6]) });
  }
  return { cliente, proyectos };
}

export async function leerCotizacionPublica(page: Pagina, cotId: string): Promise<{ cliente: string; proyectos: ProyectoPublico[] }> {
  await page.goto(`${URL_PUBLICA}${cotId}`, { waitUntil: "networkidle", timeout: 45_000 });
  let r = { cliente: "", proyectos: [] as ProyectoPublico[] };
  for (let i = 0; i < 10 && !r.proyectos.length; i++) {
    await espera(page, 1000);
    r = leerTextoPublico(await textoPagina(page));
  }
  if (!r.proyectos.length) throw new ErrorPantalla("página pública", `no se pudieron leer los proyectos de COT-${cotId}`);
  return r;
}
