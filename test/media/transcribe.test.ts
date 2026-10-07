import { describe, it, expect, vi } from "vitest";
import { transcribeAudio } from "../../src/media/transcribe";

describe("transcribeAudio", () => {
  it("calls Workers AI Whisper with base64 audio + returns text", async () => {
    const calls: any[] = [];
    const fakeEnv: any = {
      AI: {
        run: async (model: string, input: any) => {
          calls.push({ model, input });
          return { text: "hola que tal" };
        },
      },
    };
    // mock global fetch for the audio download
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as any;
    const result = await transcribeAudio("https://x/audio.ogg", fakeEnv);
    expect(result.text).toBe("hola que tal");
    expect(calls[0].model).toBe("@cf/openai/whisper-large-v3-turbo");
    // whisper-large-v3-turbo expects a base64 STRING (per Cloudflare docs), not bytes.
    expect(typeof calls[0].input.audio).toBe("string");
    // bytes [1,2,3] -> base64 "AQID"
    expect(calls[0].input.audio).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

describe("transcribeAudio — cadena de alternativas (sin llave de OpenAI obligatoria)", () => {
  it("sin binding AI pero con OPENAI_API_KEY → cae a Whisper de OpenAI", async () => {
    const fetched: string[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      fetched.push(String(url));
      if (String(url).includes("api.openai.com")) {
        expect(init.headers.Authorization).toBe("Bearer sk-test");
        return new Response(JSON.stringify({ text: "hola desde whisper de openai" }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/ogg" } });
    }) as any;
    const result = await transcribeAudio("https://x/audio.ogg", { OPENAI_API_KEY: "sk-test" } as any);
    expect(result.text).toBe("hola desde whisper de openai");
    expect(fetched.some((u) => u.includes("api.openai.com/v1/audio/transcriptions"))).toBe(true);
  });

  it("Workers AI falla y hay llave de OpenAI → la alternativa rescata el turno", async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("api.openai.com")) {
        return new Response(JSON.stringify({ text: "rescatado" }), { status: 200 });
      }
      return new Response(new Uint8Array([9]), { headers: { "content-type": "audio/mp4" } });
    }) as any;
    const env: any = {
      AI: { run: async () => { throw new Error("workers ai caído"); } },
      OPENAI_API_KEY: "sk-test",
    };
    const result = await transcribeAudio("https://x/nota.m4a", env);
    expect(result.text).toBe("rescatado");
  });

  it("sin AI y sin OPENAI_API_KEY → error CLARO con el fix ([ai])", async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/ogg" } })) as any;
    await expect(transcribeAudio("https://x/a.ogg", {} as any)).rejects.toThrow(/\[ai\]/);
  });
});

describe("transcribeAudio — audios de Instagram (MP4/AAC)", () => {
  const mp4 = () =>
    (globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 28, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } })) as any);

  it("MP4: usa Deepgram Nova-3 primero (Whisper no decodifica MP4) y devuelve su transcripción", async () => {
    mp4();
    const calls: any[] = [];
    const env: any = {
      AI: {
        run: async (model: string, input: any) => {
          calls.push({ model, input });
          return { results: { channels: [{ alternatives: [{ transcript: "hola quiero comprar vivienda en pereira" }] }] } };
        },
      },
    };
    const r = await transcribeAudio("https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", env);
    expect(r.text).toBe("hola quiero comprar vivienda en pereira");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/deepgram/nova-3");
    expect(calls[0].input.audio.contentType).toBe("audio/mp4");
    expect(calls[0].input.audio.body).toBeInstanceOf(ReadableStream);
  });

  it("MP4: si Nova-3 falla, cae a Whisper", async () => {
    mp4();
    const models: string[] = [];
    const env: any = {
      AI: {
        run: async (model: string) => {
          models.push(model);
          if (model.includes("nova")) throw new Error("nova caído");
          return { text: "desde whisper" };
        },
      },
    };
    const r = await transcribeAudio("https://x/a", env);
    expect(r.text).toBe("desde whisper");
    expect(models).toEqual(["@cf/deepgram/nova-3", "@cf/openai/whisper-large-v3-turbo"]);
  });

  it("ogg/opus (WhatsApp): Whisper primero; si falla, Nova-3 con el tipo original", async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/ogg; codecs=opus" } })) as any;
    const calls: any[] = [];
    const env: any = {
      AI: {
        run: async (model: string, input: any) => {
          calls.push({ model, input });
          if (model.includes("whisper")) throw new Error("whisper falló");
          return { results: { channels: [{ alternatives: [{ transcript: "ok" }] }] } };
        },
      },
    };
    const r = await transcribeAudio("https://x/a.ogg", env);
    expect(r.text).toBe("ok");
    expect(calls.map((c) => c.model)).toEqual(["@cf/openai/whisper-large-v3-turbo", "@cf/deepgram/nova-3"]);
    expect(calls[1].input.audio.contentType).toBe("audio/ogg");
  });

  it("los dos de Workers AI fallan y hay llave de OpenAI → OpenAI con extensión m4a", async () => {
    mp4();
    const urls: string[] = [];
    const orig = globalThis.fetch as any;
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      if (String(url).includes("api.openai.com")) {
        urls.push(String(url));
        expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
        return new Response(JSON.stringify({ text: "por openai" }), { status: 200 });
      }
      return orig(url, init);
    }) as any;
    const env: any = { AI: { run: async () => { throw new Error("caído"); } }, OPENAI_API_KEY: "sk" };
    const r = await transcribeAudio("https://x/a", env);
    expect(r.text).toBe("por openai");
    expect(urls).toHaveLength(1);
  });
});

