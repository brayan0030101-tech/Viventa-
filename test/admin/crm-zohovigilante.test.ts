/** Vigilante de Zoho: qué candidatos se vigilan (creados por el sistema o con nota reciente). */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { leadsVigilados } from "../../member/crm-zohovigilante.local";

const NOW = Date.UTC(2026, 9, 27, 12, 0);
let db: Db;
beforeEach(async () => {
  const mf = await createTestMiniflare();
  db = new Db((await mf.getD1Database("DB")) as any);
});
async function conv(id: string, meta: object) {
  await db.run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at, metadata) VALUES (?,?,?,?,?,?,?)", [id, "ycloud", id.slice(7), "Cliente " + id, 1, NOW, JSON.stringify(meta)]);
}

describe("leadsVigilados", () => {
  it("vigila los creados por el sistema (30 días) y los que recibieron nota (14 días); no los demás", async () => {
    await conv("ycloud:34600000001", { zoho_lead_id: "2259602000000000001", viventa_registrado_por: "bot", viventa_registrado: new Date(NOW - 5 * 86_400_000).toISOString() });
    await conv("ycloud:34600000002", { zoho_lead_id: "2259602000000000002", viventa_registrado_por: "bot", viventa_registrado: new Date(NOW - 40 * 86_400_000).toISOString() });
    await conv("ycloud:34600000003", { zoho_lead_id: "2259602000000000003", zoho_nota_seguimiento: "2026-10-24" });
    await conv("ycloud:34600000004", { zoho_lead_id: "2259602000000000004", zoho_nota_seguimiento: "2026-09-01" });
    await conv("ycloud:34600000005", { zoho_lead_id: "2259602000000000005", viventa_registrado_por: "Maricela Naranjo", viventa_registrado: new Date(NOW).toISOString() });
    const ids = (await leadsVigilados(db, NOW)).map((x) => x.leadId).sort();
    expect(ids).toEqual(["2259602000000000001", "2259602000000000003"]);
  });
});
