/**
 * Escritor mínimo de .xlsx para el Worker (sin dependencias): un libro de una o
 * más hojas con texto, números y enlaces clicables (relaciones externas, sin el
 * límite de 255 caracteres de la función HYPERLINK). El .xlsx es un zip; aquí se
 * arma sin compresión («store»), que Excel/Sheets/LibreOffice abren sin problema.
 */

export type Celda = string | number | { text: string; url: string } | null;

export interface Hoja {
  name: string;
  rows: Celda[][];
  /** Anchos de columna en caracteres (opcional). */
  widths?: number[];
}

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip sin compresión. */
export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...p: Uint8Array[]) => {
    const out = new Uint8Array(p.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const x of p) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = cat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name, f.data,
    );
    central.push(
      cat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
        u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset), name,
      ),
    );
    chunks.push(local);
    offset += local.length;
  }
  const centralBytes = cat(...central);
  const end = cat(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0),
  );
  return cat(...chunks, centralBytes, end);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Estilos: 0 normal, 1 encabezado (blanco negrita sobre azul), 2 enlace. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sheetXml(h: Hoja): { xml: string; links: string[] } {
  const links: string[] = [];
  const linkRefs: string[] = [];
  const cols = h.widths?.length
    ? `<cols>${h.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const rows = h.rows
    .map((row, r) => {
      const cells = row
        .map((c, i) => {
          const ref = `${colName(i)}${r + 1}`;
          if (c === null || c === "") return "";
          if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
          if (typeof c === "string") return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(c)}</t></is></c>`;
          links.push(c.url);
          linkRefs.push(`<hyperlink ref="${ref}" r:id="rId${links.length}"/>`);
          return `<c r="${ref}" s="2" t="inlineStr"><is><t xml:space="preserve">${esc(c.text)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}"${r === 0 ? ' ht="30" customHeight="1"' : ""}>${cells}</row>`;
    })
    .join("");
  const lastCol = colName(Math.max(0, (h.rows[0]?.length ?? 1) - 1));
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${Math.max(1, h.rows.length)}"/>` +
    (linkRefs.length ? `<hyperlinks>${linkRefs.join("")}</hyperlinks>` : "") +
    `</worksheet>`;
  return { xml, links };
}

export function buildXlsx(sheets: Hoja[]): Uint8Array {
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const add = (name: string, text: string) => files.push({ name, data: enc.encode(text) });

  add(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("")}</Types>`,
  );
  add(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  add("xl/styles.xml", STYLES);
  sheets.forEach((h, i) => {
    const { xml, links } = sheetXml(h);
    add(`xl/worksheets/sheet${i + 1}.xml`, xml);
    if (links.length) {
      add(
        `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links
          .map((u, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(u)}" TargetMode="External"/>`)
          .join("")}</Relationships>`,
      );
    }
  });
  return zipStore(files);
}
