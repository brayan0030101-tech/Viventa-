/**
 * Caché de prompts: TTL del bloque system y punto de caché en el último mensaje.
 */
import { describe, it, expect } from "vitest";
import { cacheTtl, effortOptions, systemCacheOptions, withCacheBreakpoint } from "../../src/llm/cache";

describe("cacheTtl / systemCacheOptions", () => {
  it("por defecto es de 5 min y no manda ttl", () => {
    expect(cacheTtl({})).toBe("5m");
    expect(systemCacheOptions({})).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it('PROMPT_CACHE_TTL="1h" activa el TTL de 1 hora', () => {
    expect(cacheTtl({ PROMPT_CACHE_TTL: "1h" })).toBe("1h");
    expect(systemCacheOptions({ PROMPT_CACHE_TTL: " 1h " })).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });

  it("un valor raro cae a 5 min", () => {
    expect(cacheTtl({ PROMPT_CACHE_TTL: "2h" })).toBe("5m");
  });
});

describe("withCacheBreakpoint", () => {
  it("marca SOLO el último mensaje y no muta el original", () => {
    const original = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿Me confirmas tu nombre?" },
      { role: "user", content: "Ana" },
    ];
    const out = withCacheBreakpoint(original as any[]);
    expect(out).toHaveLength(3);
    expect(out[2].providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(out[0].providerOptions).toBeUndefined();
    expect(out[1].providerOptions).toBeUndefined();
    expect((original[2] as any).providerOptions).toBeUndefined();
  });

  it("conserva las opciones que el mensaje ya traía", () => {
    const out = withCacheBreakpoint([{ role: "user", content: "x", providerOptions: { openai: { a: 1 }, anthropic: { foo: 2 } } }] as any[]);
    expect(out[0].providerOptions).toEqual({
      openai: { a: 1 },
      anthropic: { foo: 2, cacheControl: { type: "ephemeral" } },
    });
  });

  it("con mensajes multimodales (imagen) marca el mensaje, no sus partes", () => {
    const msg = { role: "user", content: [{ type: "text", text: "mira" }, { type: "image", image: "https://x/y.jpg" }] };
    const out = withCacheBreakpoint([msg] as any[]);
    expect(out[0].providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    expect((out[0] as any).content).toBe(msg.content);
  });

  it("lista vacía → lista vacía", () => {
    expect(withCacheBreakpoint([])).toEqual([]);
  });
});

describe("effortOptions", () => {
  it("solo se manda a Sonnet/Opus 5.5 y con un valor válido", () => {
    expect(effortOptions({ ANTHROPIC_EFFORT: "medium" }, "claude-sonnet-5-5")).toEqual({ anthropic: { effort: "medium" } });
    expect(effortOptions({ ANTHROPIC_EFFORT: " LOW " }, "claude-opus-5-5")).toEqual({ anthropic: { effort: "low" } });
    expect(effortOptions({ ANTHROPIC_EFFORT: "medium" }, "claude-sonnet-5")).toBeUndefined();
    expect(effortOptions({ ANTHROPIC_EFFORT: "medium" }, "claude-haiku-4-5-20251001")).toBeUndefined();
    expect(effortOptions({ ANTHROPIC_EFFORT: "extremo" }, "claude-sonnet-5-5")).toBeUndefined();
    expect(effortOptions({}, "claude-sonnet-5-5")).toBeUndefined();
  });
});
