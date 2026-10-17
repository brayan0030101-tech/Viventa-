import { describe, it, expect } from "vitest";
import { enHorarioDe, horaLocal, zonaPorTelefono, zonaDelCliente } from "../../src/lib/horarioCliente";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";

describe("horario de contacto del cliente", () => {
  it("de madrugada (hora local) no, de día sí", () => {
    const t = Date.UTC(2026, 9, 17, 0, 15); // 02:15 en Madrid, 19:15 en Bogotá (día anterior)
    expect(horaLocal(t, "Europe/Madrid")).toBe(2);
    expect(enHorarioDe(t, "Europe/Madrid")).toBe(false);
    expect(enHorarioDe(t, "America/Bogota")).toBe(true);
    expect(enHorarioDe(Date.UTC(2026, 9, 17, 7, 0), "Europe/Madrid")).toBe(true); // 09:00
    expect(enHorarioDe(Date.UTC(2026, 9, 17, 19, 0), "Europe/Madrid")).toBe(false); // 21:00
    expect(enHorarioDe(Date.UTC(2026, 9, 17, 6, 59), "Europe/Madrid")).toBe(false); // 08:59
  });

  it("zona por prefijo de teléfono (solo WhatsApp)", () => {
    expect(zonaPorTelefono("ycloud", "34624082792")).toBe("Europe/Madrid");
    expect(zonaPorTelefono("ycloud", "573001234567")).toBe("America/Bogota");
    expect(zonaPorTelefono("ycloud", "593991234567")).toBe("America/Guayaquil");
    expect(zonaPorTelefono("ycloud", "13055550100")).toBe("America/New_York");
    expect(zonaPorTelefono("zernio", "34624082792")).toBeNull();
  });

  it("la ficha manda sobre el teléfono; sin datos, España", async () => {
    const mf = await createTestMiniflare();
    const d1 = (await mf.getD1Database("DB")) as any;
    const db = new Db(d1);
    const conv = { id: "ycloud:34600000001", channel: "ycloud", channel_user_id: "34600000001" };
    expect(await zonaDelCliente(db, conv)).toBe("Europe/Madrid");
    await db.run("INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?,?,?,?,?)", [conv.id, "ycloud", "34600000001", 1, 1]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, metadata, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", ["l1", conv.id, "X", "", "compra", JSON.stringify({ ciudadResidencia: "Miami, EE. UU." }), "new", 1, 1]);
    expect(await zonaDelCliente(db, conv)).toBe("America/New_York");
    expect(await zonaDelCliente(db, { id: "zernio:zz", channel: "zernio", channel_user_id: "zz" })).toBe("Europe/Madrid");
  });
});
