import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks de DB/settings para probar la coexistencia sin tocar D1.
const { setPausedUntil, getOrCreate, resolveTakeoverMs } = vi.hoisted(() => ({
  setPausedUntil: vi.fn(async () => {}),
  getOrCreate: vi.fn(async () => ({ id: "ycloud:5218145803756" })),
  resolveTakeoverMs: vi.fn(async () => 3_600_000),
}));
vi.mock("../../src/db/client", () => ({ Db: class {} }));
vi.mock("../../src/db/conversations", () => ({
  ConversationsRepo: class {
    getOrCreate = getOrCreate;
    setPausedUntil = setPausedUntil;
  },
}));
vi.mock("../../src/db/settings", () => ({ resolveTakeoverMs }));

// Mocks para la transcripción + guardado del audio del dueño (coexistencia).
const { transcribeAudio, appendMock } = vi.hoisted(() => ({
  transcribeAudio: vi.fn(async () => ({ text: "Hola, te confirmo que sí tenemos ese proyecto" })),
  appendMock: vi.fn(async () => "msg_1"),
}));
vi.mock("../../src/media/transcribe", () => ({ transcribeAudio }));
vi.mock("../../src/db/messages", () => ({
  MessagesRepo: class {
    append = appendMock;
  },
}));

import {
  parseYCloudEvents,
  verifyYCloudSignature,
  ycloudOwnerTakeover,
  normalizeYCloudEvents,
  isForThisNumber,
  serveYCloudMedia,
} from "../../src/channels/ycloud";

const ORIGIN = "https://bot.example.workers.dev";
const env = { YCLOUD_WEBHOOK_SECRET: "whsec", YCLOUD_API_KEY: "k", DASHBOARD_BASE_URL: ORIGIN } as any;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function inbound(message: any) {
  return { id: "evt_1", type: "whatsapp.inbound_message.received", apiVersion: "v2", whatsappInboundMessage: message };
}

function echo(to = "+52 81 4580 3756") {
  return {
    id: "evt_e",
    type: "whatsapp.smb.message.echoes",
    whatsappMessage: { wamid: "wamid.x", status: "sent", from: "+528100000000", to, type: "text", customerProfile: { name: "Joe" } },
  };
}

describe("parseYCloudEvents", () => {
  it("parsea texto entrante y normaliza el número; dedup por wamid", async () => {
    const out = await parseYCloudEvents(
      inbound({ id: "id1", wamid: "wamid.1", from: "+52 1 55 1234 5678", type: "text", text: { body: "hola" }, customerProfile: { name: "Joe" } }) as any,
      env,
      ORIGIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe("ycloud");
    expect(out[0].channelUserId).toBe("5215512345678");
    expect(out[0].text).toBe("hola");
    expect(out[0].displayName).toBe("Joe");
    expect(out[0].providerMessageId).toBe("wamid.1");
  });

  it("imagen → imageUrl firmada por el proxy + caption como texto", async () => {
    const out = await parseYCloudEvents(
      inbound({ wamid: "wamid.2", from: "5215512345678", type: "image", image: { id: "IMG1", caption: "mira" } }) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("mira");
    expect(out[0].imageUrl).toContain(`${ORIGIN}/webhooks/ycloud/media/IMG1`);
    expect(out[0].imageUrl).toMatch(/[?&]sig=/);
    expect(out[0].imageUrl).toMatch(/[?&]exp=/);
  });

  it("audio → audioUrl firmada (Forja transcribe; YCloud no transcribe)", async () => {
    const out = await parseYCloudEvents(
      inbound({ wamid: "wamid.3", from: "5215512345678", type: "audio", audio: { id: "AUD1" } }) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBeUndefined();
    expect(out[0].audioUrl).toContain(`${ORIGIN}/webhooks/ycloud/media/AUD1`);
  });

  it("ignora eventos que no son inbound (echoes/status)", async () => {
    expect(await parseYCloudEvents(echo() as any, env, ORIGIN)).toHaveLength(0);
  });
});

describe("verifyYCloudSignature (tipo Stripe, anti-replay)", () => {
  it("acepta firma válida con timestamp reciente", async () => {
    const t = "1762224357";
    const raw = JSON.stringify({ a: 1 });
    const s = await hmacHex("whsec", `${t}.${raw}`);
    const nowMs = Number(t) * 1000 + 1000;
    expect(await verifyYCloudSignature(raw, `t=${t},s=${s}`, "whsec", nowMs)).toBe(true);
  });

  it("rechaza timestamp viejo (replay)", async () => {
    const t = "1000000000"; // muy viejo
    const raw = "{}";
    const s = await hmacHex("whsec", `${t}.${raw}`);
    const nowMs = 1762224357000;
    expect(await verifyYCloudSignature(raw, `t=${t},s=${s}`, "whsec", nowMs)).toBe(false);
  });

  it("rechaza firma incorrecta y fail-closed sin secret/header", async () => {
    const t = "1762224357";
    const nowMs = Number(t) * 1000;
    expect(await verifyYCloudSignature("{}", `t=${t},s=deadbeef`, "whsec", nowMs)).toBe(false);
    expect(await verifyYCloudSignature("{}", `t=${t},s=x`, undefined, nowMs)).toBe(false);
    expect(await verifyYCloudSignature("{}", null, "whsec", nowMs)).toBe(false);
  });
});

describe("ycloudOwnerTakeover (coexistencia)", () => {
  beforeEach(() => {
    setPausedUntil.mockClear();
    getOrCreate.mockClear();
  });

  it("echo del business app → pausa la conversación del cliente (to)", async () => {
    const paused = await ycloudOwnerTakeover(echo("+52 81 4580 3756") as any, env, "https://example.com");
    expect(paused).toBe(true);
    expect(getOrCreate).toHaveBeenCalledWith("ycloud", "528145803756", "Joe");
    expect(setPausedUntil).toHaveBeenCalledWith("ycloud:5218145803756", expect.any(Number));
  });

  it("un evento que no es echo → NO pausa", async () => {
    const paused = await ycloudOwnerTakeover(inbound({ from: "1", type: "text", text: { body: "x" } }) as any, env, "https://example.com");
    expect(paused).toBe(false);
    expect(setPausedUntil).not.toHaveBeenCalled();
  });

  it("echo de AUDIO → transcribe y guarda el texto como mensaje 'owner' (memoria del bot)", async () => {
    appendMock.mockClear();
    transcribeAudio.mockClear();
    const audioEcho = {
      id: "evt_e2",
      type: "whatsapp.smb.message.echoes",
      whatsappMessage: {
        wamid: "wamid.y",
        status: "sent",
        from: "+528100000000",
        to: "+52 81 4580 3756",
        type: "audio",
        customerProfile: { name: "Joe" },
        audio: { id: "aud_1", link: "https://api.ycloud.com/v2/whatsapp/media/download/aud_1", mime_type: "audio/ogg" },
      },
    };
    const paused = await ycloudOwnerTakeover(audioEcho as any, env, ORIGIN);
    expect(paused).toBe(true);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      "ycloud:5218145803756",
      "owner",
      "Hola, te confirmo que sí tenemos ese proyecto",
    );
  });

  it("echo de TEXTO → pausa pero NO intenta guardar texto (YCloud no lo manda)", async () => {
    appendMock.mockClear();
    transcribeAudio.mockClear();
    await ycloudOwnerTakeover(echo("+52 81 4580 3756") as any, env, ORIGIN);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(appendMock).not.toHaveBeenCalled();
  });
});

describe("normalizeYCloudEvents", () => {
  it("evento único → lista de 1", () => {
    expect(normalizeYCloudEvents(inbound({ from: "1", type: "text", text: { body: "a" } }))).toHaveLength(1);
  });
  it("array o { items: [...] } → expande", () => {
    expect(normalizeYCloudEvents([{}, {}])).toHaveLength(2);
    expect(normalizeYCloudEvents({ items: [{}] })).toHaveLength(1);
  });
});

describe("filtro por número (cuenta de YCloud compartida con otro bot)", () => {
  const VIVENTA = "+34611688609";
  const OTRO = "+34603039032";
  const envNum = { ...env, YCLOUD_WA_FROM: VIVENTA } as any;
  const msg = (to: string) =>
    inbound({ id: "id9", wamid: "wamid.9", from: "+57 300 123 4567", to, type: "text", text: { body: "hola" } }) as any;
  const eco = (from: string) =>
    ({
      id: "evt_e9",
      type: "whatsapp.smb.message.echoes",
      whatsappMessage: { wamid: "wamid.e9", status: "sent", from, to: "+57 300 123 4567", type: "text", customerProfile: { name: "Ana" } },
    }) as any;

  beforeEach(() => {
    setPausedUntil.mockClear();
    getOrCreate.mockClear();
  });

  it("(a) un mensaje dirigido al otro número se ignora", async () => {
    expect(await parseYCloudEvents(msg(OTRO), envNum, ORIGIN)).toHaveLength(0);
  });

  it("(b) un mensaje dirigido al número de Viventa se procesa (con cualquier formato)", async () => {
    expect(await parseYCloudEvents(msg(VIVENTA), envNum, ORIGIN)).toHaveLength(1);
    expect(await parseYCloudEvents(msg("+34 611-688-609"), envNum, ORIGIN)).toHaveLength(1);
  });

  it("(c) un eco cuyo from es el otro número no pausa nada ni toca la base", async () => {
    const paused = await ycloudOwnerTakeover(eco(OTRO), envNum, ORIGIN);
    expect(paused).toBe(false);
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(setPausedUntil).not.toHaveBeenCalled();
  });

  it("(d) un eco del número de Viventa sí pausa", async () => {
    const paused = await ycloudOwnerTakeover(eco(VIVENTA), envNum, ORIGIN);
    expect(paused).toBe(true);
    expect(setPausedUntil).toHaveBeenCalledTimes(1);
  });

  it("isForThisNumber compara solo dígitos y deja pasar si falta algún número", () => {
    expect(isForThisNumber("+34 611 688 609", envNum)).toBe(true);
    expect(isForThisNumber("34611688609", envNum)).toBe(true);
    expect(isForThisNumber(OTRO, envNum)).toBe(false);
    expect(isForThisNumber(undefined, envNum)).toBe(true);
    expect(isForThisNumber("", envNum)).toBe(true);
    expect(isForThisNumber(OTRO, env)).toBe(true);
  });
});

describe("serveYCloudMedia — diagnóstico cuando YCloud rechaza la descarga", () => {
  it("responde 502 y registra el código y el cuerpo de YCloud, sin la llave", async () => {
    const envM = { YCLOUD_WEBHOOK_SECRET: "whsec", YCLOUD_API_KEY: "SECRETA_KEY_123" } as any;
    const exp = String(Date.now() + 60_000);
    const sig = await hmacHex("whsec", `media123.${exp}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":{"code":"not_found","message":"media expired"}}', { status: 404, headers: { "content-type": "application/json" } })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await serveYCloudMedia("media123", exp, sig, envM);
    expect(res.status).toBe(502);
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("http_404");
    expect(logged).toContain("media expired");
    expect(logged).toContain("media123");
    expect(logged).not.toContain("SECRETA_KEY_123");
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("media con enlace firmado de YCloud (causa de los audios '(no pude entender el audio)')", () => {
  const LINK = "https://api.ycloud.com/v2/whatsapp/media/download/AUD9?sig=t%3D1677%2Cs%3Dabc&payload=eyJ3YWJhSWQiOiIxIn0%3D";

  it("el audio entrante lleva el enlace de YCloud (src) dentro de la URL firmada del proxy", async () => {
    const out = await parseYCloudEvents(
      inbound({ wamid: "wamid.9", from: "5215512345678", type: "audio", audio: { id: "AUD9", link: LINK } }) as any,
      env,
      ORIGIN,
    );
    const u = new URL(out[0].audioUrl as string);
    expect(u.pathname).toBe("/webhooks/ycloud/media/AUD9");
    expect(u.searchParams.get("src")).toBe(LINK);
    const exp = u.searchParams.get("exp")!;
    expect(u.searchParams.get("sig")).toBe(await hmacHex("whsec", `AUD9.${exp}.${LINK}`));
  });

  it("imágenes y documentos también llevan su enlace", async () => {
    const img = "https://api.ycloud.com/v2/whatsapp/media/download/I1?sig=x&payload=y";
    const doc = "https://api.ycloud.com/v2/whatsapp/media/download/D1?sig=x&payload=y";
    const a = await parseYCloudEvents(inbound({ wamid: "w1", from: "5215512345678", type: "image", image: { id: "I1", link: img } }) as any, env, ORIGIN);
    const b = await parseYCloudEvents(inbound({ wamid: "w2", from: "5215512345678", type: "document", document: { id: "D1", link: doc, filename: "a.pdf" } }) as any, env, ORIGIN);
    expect(new URL(a[0].imageUrl as string).searchParams.get("src")).toBe(img);
    expect(new URL(b[0].fileUrl as string).searchParams.get("src")).toBe(doc);
  });

  it("un enlace de otro sitio NO se mete en la URL (sin SSRF): cae al camino por id", async () => {
    const out = await parseYCloudEvents(
      inbound({ wamid: "wamid.8", from: "5215512345678", type: "audio", audio: { id: "AUD8", link: "https://evil.example/x" } }) as any,
      env,
      ORIGIN,
    );
    expect(new URL(out[0].audioUrl as string).searchParams.get("src")).toBeNull();
  });

  it("el proxy baja el enlace COMPLETO con la llave en el encabezado y devuelve el audio", async () => {
    const envM = { YCLOUD_WEBHOOK_SECRET: "whsec", YCLOUD_API_KEY: "KEY_X" } as any;
    const exp = String(Date.now() + 60_000);
    const sig = await hmacHex("whsec", `AUD9.${exp}.${LINK}`);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/ogg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await serveYCloudMedia("AUD9", exp, sig, envM, LINK);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/ogg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(LINK);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("KEY_X");
    vi.unstubAllGlobals();
  });

  it("rechaza un src alterado (firma no coincide) o de otro host, sin llamar a nadie", async () => {
    const envM = { YCLOUD_WEBHOOK_SECRET: "whsec", YCLOUD_API_KEY: "KEY_X" } as any;
    const exp = String(Date.now() + 60_000);
    const sig = await hmacHex("whsec", `AUD9.${exp}.${LINK}`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const otro = "https://api.ycloud.com/v2/whatsapp/media/download/OTRO?sig=1&payload=2";
    expect((await serveYCloudMedia("AUD9", exp, sig, envM, otro)).status).toBe(403);
    const malo = "https://evil.example/x";
    expect((await serveYCloudMedia("AUD9", exp, await hmacHex("whsec", `AUD9.${exp}.${malo}`), envM, malo)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("el audio del dueño (echo) usa el mismo enlace firmado — ver la prueba de ycloudOwnerTakeover", async () => {
    const out = await parseYCloudEvents(
      inbound({ wamid: "w3", from: "5215512345678", type: "audio", audio: { id: "E1", link: LINK } }) as any,
      env,
      ORIGIN,
    );
    expect(new URL(out[0].audioUrl as string).searchParams.get("src")).toBe(LINK);
  });
});

