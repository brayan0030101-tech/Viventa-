import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { sendChunkedReply } from "../../src/replies/sender";
import { AJUSTE_BOTONES, botonesApagados } from "../../src/lib/botones";
import { listaDeDias } from "../../member/llamada.local";
import type { ChannelAdapter } from "../../src/channels/shared";
import type { Env } from "../../src/env";

let db: Db;
let env: Env;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  db = new Db(d1);
  env = { DB: d1 } as unknown as Env;
});

describe("viventa_botones = apagado (Maricela, 16 nov 2026: el bot no debe parecer un robot)", () => {
  it("sin el ajuste los botones salen como siempre", async () => {
    const sendReply = vi.fn(async () => {});
    const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
    await sendChunkedReply(adapter, "ycloud", "34600000000", ["¿Qué día te queda mejor? [[botones: Lun 12 oct | Mar 13 oct]]"], env);
    expect((sendReply.mock.calls[0] as any[])[0].buttons).toHaveLength(2);
  });

  it("apagado: el marcador desaparece, no hay botones y NO se convierte en lista numerada", async () => {
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)", [AJUSTE_BOTONES, "apagado", Date.now()]);
    expect(await botonesApagados(env)).toBe(true);
    for (const canal of ["ycloud", "telegram"] as const) {
      const sendReply = vi.fn(async () => {});
      const adapter = { sendReply, parseIncoming: vi.fn() } as unknown as ChannelAdapter;
      await sendChunkedReply(adapter, canal, "u", ["¿Cuál es tu objetivo: vivir, tu familia o invertir? [[botones: 🏡 Vivir | 👪 Familia | 💰 Invertir]]"], env);
      const arg = (sendReply.mock.calls[0] as any[])[0];
      expect(arg.buttons).toBeUndefined();
      expect(arg.chunks.join(" ")).not.toMatch(/\[\[|1\)|2\)/);
      expect(arg.chunks.join(" ")).toContain("¿Cuál es tu objetivo");
    }
  });

  it("los días se ofrecen dentro de una frase natural", () => {
    const t = listaDeDias(["2026-11-18T18:00:00.000Z", "2026-11-19T18:00:00.000Z", "2026-11-20T18:00:00.000Z"]);
    expect(t).toMatch(/^el miércoles 18 de noviembre, el jueves 19 de noviembre o el viernes 20 de noviembre$/);
  });
});
