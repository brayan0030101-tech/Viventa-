/** La cola de cotizaciones no escribe a quien dijo que no le interesa (caso del 21 oct), tampoco si lo dijo en la conversación enlazada de Instagram↔WhatsApp. */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { dijoQueNo } from "../../src/vivehome/cola";

let db: Db;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  db = new Db((await mf.getD1Database("DB")) as any);
});

describe("dijoQueNo", () => {
  it("detecta «Ya no estoy interesado/a» como último mensaje del cliente", async () => {
    const c = await new ConversationsRepo(db).getOrCreate("ycloud", "34600000090", "Daniel");
    await new MessagesRepo(db).append(c.id, "user", "Ya no estoy interesado/a", { createdAt: 1000 });
    expect(await dijoQueNo(db, c.id)).toBe(true);
  });

  it("detecta «por el momento no, muchas gracias» (caso Wendy, 27 oct 2026)", async () => {
    const c = await new ConversationsRepo(db).getOrCreate("ycloud", "34600000093", "Wendy");
    await new MessagesRepo(db).append(c.id, "user", "Hola ,por el momento no,muchas gracias", { createdAt: 1000 });
    expect(await dijoQueNo(db, c.id)).toBe(true);
  });

  it("no se activa con una conversación normal", async () => {
    const c = await new ConversationsRepo(db).getOrCreate("ycloud", "34600000091", "Ana");
    await new MessagesRepo(db).append(c.id, "user", "Sí, quiero continuar", { createdAt: 1000 });
    expect(await dijoQueNo(db, c.id)).toBe(false);
  });

  it("mira también la conversación enlazada (Instagram ↔ WhatsApp)", async () => {
    const ig = await new ConversationsRepo(db).getOrCreate("zernio", "9001", "dani");
    const wa = await new ConversationsRepo(db).getOrCreate("ycloud", "34600000092", "dani");
    await db.run("UPDATE conversations SET metadata = json_set(COALESCE(metadata,'{}'), '$.viventa_retomar_ig', ?) WHERE id = ?", [wa.id, ig.id]);
    await new MessagesRepo(db).append(wa.id, "user", "Ya no estoy interesado/a", { createdAt: 1000 });
    expect(await dijoQueNo(db, ig.id)).toBe(true);
    expect(await dijoQueNo(db, wa.id)).toBe(true);
  });
});
