/**
 * Caché de prompts de Anthropic — ahorro de entrada.
 *
 * Cada turno el bot manda: tools + prompt grande (estable) + historial (hasta 80
 * mensajes) + el mensaje nuevo. Y un turno puede tener VARIAS llamadas al modelo
 * (searchKb, captureLead… hasta 6 pasos), cada una reenviando todo.
 *
 *  • Punto 1 (ya existía): el bloque system grande se cachea. Aquí solo se elige
 *    su TTL: "5m" (default) o "1h" (PROMPT_CACHE_TTL="1h"). El de 1 h escribe a
 *    2× en vez de 1,25×, pero sobrevive entre conversaciones espaciadas — conviene
 *    solo con tráfico constante.
 *  • Punto 2 (nuevo): un punto de caché en el ÚLTIMO mensaje del historial. Los
 *    pasos 2..N del mismo turno y los turnos seguidos de la misma conversación
 *    (< 5 min) leen el historial a 0,1× en vez de pagarlo completo.
 *
 * Solo Anthropic entiende `providerOptions.anthropic`; los demás proveedores lo
 * ignoran, así que es seguro aunque el turno caiga en un modelo de respaldo.
 */
import type { Env } from "../env";

export type CacheTtl = "5m" | "1h";

export function cacheTtl(env: Pick<Env, "PROMPT_CACHE_TTL">): CacheTtl {
  return (env.PROMPT_CACHE_TTL ?? "").trim() === "1h" ? "1h" : "5m";
}

/** `providerOptions` del bloque system grande (punto de caché con su TTL). */
export function systemCacheOptions(env: Pick<Env, "PROMPT_CACHE_TTL">) {
  const ttl = cacheTtl(env);
  return {
    anthropic: { cacheControl: ttl === "1h" ? { type: "ephemeral" as const, ttl } : { type: "ephemeral" as const } },
  };
}

/**
 * Copia de `messages` con un punto de caché (5 min) en el último mensaje.
 * No muta el arreglo original ni el mensaje (el reintento por foto reescribe
 * `aiMessages` y no debe arrastrar la marca).
 */
export function withCacheBreakpoint<T extends { providerOptions?: Record<string, any> }>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const marked = {
    ...last,
    providerOptions: {
      ...(last.providerOptions ?? {}),
      anthropic: {
        ...(last.providerOptions?.anthropic ?? {}),
        cacheControl: { type: "ephemeral" as const },
      },
    },
  } as T;
  return [...messages.slice(0, -1), marked];
}
