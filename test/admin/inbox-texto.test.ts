/**
 * El CRM (Seguimientos) abre la conversación del panel con el mensaje ya puesto en la caja de respuesta.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import type { Env } from "../../src/env";

const AUTH = { Authorization: `Basic ${Buffer.from("admin:secret123").toString("base64")}` };
let env: Env;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, BOT_NAME: "Bot", BUSINESS_NAME: "Negocio", BOT_LANGUAGE: "es", BOT_TIER: "pro", DASHBOARD_PASSWORD: "secret123" } as unknown as Env;
  await new Db(d1).run("INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at) VALUES (?,?,?,?,?,?)", ["ycloud:34600000009", "ycloud", "34600000009", "Ana", 1, Date.now()]);
});

describe("GET /conversations?texto=", () => {
  it("pone el texto en la caja de respuesta y protege contra </script>", async () => {
    const texto = 'Hola Ana, ¿sigues interesada? </script><b>x</b> "comillas"';
    const res = await adminApp.request(`/conversations?c=ycloud%3A34600000009&texto=${encodeURIComponent(texto)}`, { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("getElementById('reply-text')");
    expect(html).toContain("Hola Ana, ¿sigues interesada?");
    expect(html).not.toContain("</script><b>x</b>");
    expect(html).toContain("\\u003c/script>");
  });
  it("sin texto o sin conversación no agrega nada", async () => {
    const a = await (await adminApp.request("/conversations?c=ycloud%3A34600000009", { headers: AUTH }, env)).text();
    expect(a).not.toContain("getElementById('reply-text')");
    const b = await (await adminApp.request("/conversations?texto=hola", { headers: AUTH }, env)).text();
    expect(b).not.toContain("setInterval(function(){var e=document.getElementById('reply-text')");
  });
});
