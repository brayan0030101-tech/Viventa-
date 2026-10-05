import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { INTER_REGULAR_B64 } from "./fonts/inter-regular";
import { INTER_BOLD_B64 } from "./fonts/inter-bold";

let ready: Promise<void> | undefined;
let fonts: Uint8Array[] | undefined;

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function svgToPng(svg: string): Promise<Uint8Array> {
  ready ??= initWasm(resvgWasm);
  await ready;
  fonts ??= [b64ToBytes(INTER_REGULAR_B64), b64ToBytes(INTER_BOLD_B64)];
  const resvg = new Resvg(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: "Inter", loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
