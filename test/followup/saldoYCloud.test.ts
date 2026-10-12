import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyMock = vi.fn();
vi.mock("../../src/lib/camila", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/camila")>();
  return { ...actual, notifyCamila: (...a: unknown[]) => notifyMock(...a), camilaConfigured: () => true };
});

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { runSaldoYCloud } from "../../src/followup/saldoYCloud";
import { SettingsRepo } from "../../src/db/settings";
import { Db } from "../../src/db/client";
import type { Env } from "../../src/env";

let env: Env;
const H = 3600_000;
const T0 = Date.UTC(2026, 9, 13, 10, 0);
const saldoDe = (amount: number | string, ok = true) => vi.fn(async () => (ok ? new Response(JSON.stringify({ amount, currency: "USD" }), { status: 200 }) : new Response("no", { status: 500 })));

beforeEach(async () => {
  const mf = await createTestMiniflare();
  env = { DB: (await mf.getD1Database("DB")) as any, BUSINESS_NAME: "Viventa", BOT_TIER: "pro", YCLOUD_API_KEY: "k" } as unknown as Env;
  notifyMock.mockReset().mockResolvedValue(true);
  vi.unstubAllGlobals();
});

describe("vigilancia del saldo de YCloud", () => {
  it("avisa cuando el saldo es bajo y no repite el aviso en 12 horas", async () => {
    vi.stubGlobal("fetch", saldoDe(0.42));
    expect((await runSaldoYCloud(env, T0)).avisado).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1].heading).toContain("casi en cero");
    expect((await runSaldoYCloud(env, T0 + 2 * H)).avisado).toBe(false); // ya avisó hace 2 h
    expect((await runSaldoYCloud(env, T0 + 13 * H)).avisado).toBe(true); // pasaron 12 h
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(await new SettingsRepo(new Db(env.DB)).get("ycloud_saldo_ultimo")).toContain("0.42");
  });

  it("no avisa con saldo suficiente, consulta como máximo una vez por hora y tolera errores", async () => {
    const f = saldoDe("15.00");
    vi.stubGlobal("fetch", f);
    expect((await runSaldoYCloud(env, T0)).saldo).toBe(15);
    expect(notifyMock).not.toHaveBeenCalled();
    await runSaldoYCloud(env, T0 + 10 * 60_000);
    expect(f).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", saldoDe(1, false));
    expect((await runSaldoYCloud(env, T0 + 2 * H)).saldo).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("sin llave de YCloud no hace nada", async () => {
    const f = saldoDe(1);
    vi.stubGlobal("fetch", f);
    expect((await runSaldoYCloud({ ...env, YCLOUD_API_KEY: undefined } as Env, T0)).saldo).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
