/**
 * Si un mensaje se marcó como procesado pero no llegó al agente, hay que poder olvidarlo para que el reintento del proveedor entre.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { seenBefore, olvidarMensaje } from "../../src/db/dedup";

let db: Db;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  db = new Db((await mf.getD1Database("DB")) as any);
});

describe("olvidarMensaje", () => {
  it("tras olvidarlo, el mismo id vuelve a procesarse; sin olvidarlo es duplicado", async () => {
    expect(await seenBefore(db, "wamid.X")).toBe(false);
    expect(await seenBefore(db, "wamid.X")).toBe(true);
    await olvidarMensaje(db, "wamid.X");
    expect(await seenBefore(db, "wamid.X")).toBe(false);
  });
});
