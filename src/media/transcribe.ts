import type { Env } from "../env";

export interface TranscriptionResult {
  text: string;
  durationSeconds?: number;
}

/**
 * Transcripción con CADENA DE ALTERNATIVAS — un miembro que usa Claude (sin
 * llave de OpenAI) transcribe igual:
 *
 *  1. Workers AI — viene con la cuenta de Cloudflare del miembro vía el binding
 *     [ai]; no pide ninguna llave. Whisper (@cf/openai/whisper-large-v3-turbo)
 *     para ogg/mp3/wav; Deepgram Nova-3 (@cf/deepgram/nova-3) para MP4/AAC
 *     (audios de Instagram), con el otro de respaldo.
 *  2. OpenAI Whisper API — SOLO si el miembro tiene OPENAI_API_KEY (p. ej.
 *     bots viejos cuyo wrangler.toml preservado aún no trae el bloque [ai]).
 *  3. Sin vía → error claro con el fix (agregar [ai]), no un fallo mudo.
 *
 * Cada caída de escalón deja línea en el log (regla: los fallos no son mudos).
 */
export async function transcribeAudio(
  audioUrl: string,
  env: Env,
): Promise<TranscriptionResult> {
  const res = await fetch(audioUrl);
  if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const mime = (res.headers.get("content-type") ?? "audio/ogg").split(";")[0].trim();

  // Formato del audio. Los audios de Instagram llegan como MP4/AAC
  // ("video/mp4"): Whisper de Workers AI NO los decodifica (AiError 3030
  // "Failed to decode audio file"). Deepgram Nova-3 (también en Workers AI, sin
  // llave) sí. Para esos formatos se prueba Nova-3 primero; para ogg/opus
  // (WhatsApp), mp3, wav… Whisper primero, y el otro queda de respaldo.
  const esMp4 = /mp4|m4a|aac|mpeg4/i.test(mime);

  const conWhisper = async (): Promise<string> => {
    // whisper-large-v3-turbo expects a base64-encoded string in `audio` (per
    // the Cloudflare Workers AI docs), NOT a raw byte array. nodejs_compat is
    // enabled (see wrangler.toml) so Buffer is available.
    const base64 = Buffer.from(buffer).toString("base64");
    const result = await env.AI!.run("@cf/openai/whisper-large-v3-turbo" as any, {
      audio: base64,
    } as any);
    return (((result as any).text ?? "") as string).trim();
  };

  const conNova = async (): Promise<string> => {
    const contentType = /mp4|m4a|aac|mpeg4/i.test(mime) ? "audio/mp4" : mime;
    const result: any = await env.AI!.run("@cf/deepgram/nova-3" as any, {
      audio: { body: new Response(buffer).body, contentType },
      detect_language: true,
      punctuate: true,
      smart_format: true,
    } as any);
    const alt = result?.results?.channels?.[0]?.alternatives?.[0];
    return ((alt?.transcript ?? "") as string).trim();
  };

  // 1) Workers AI — sin llave, en la cuenta del propio miembro.
  if (env.AI) {
    const orden: Array<[string, () => Promise<string>]> = esMp4
      ? [["Deepgram Nova-3", conNova], ["Whisper", conWhisper]]
      : [["Whisper", conWhisper], ["Deepgram Nova-3", conNova]];
    for (const [nombre, intentar] of orden) {
      try {
        const text = await intentar();
        if (text) return { text };
        console.warn(`[transcribe] Workers AI (${nombre}) devolvió texto vacío — probando alternativa`);
      } catch (e) {
        console.warn(`[transcribe] Workers AI (${nombre}) falló [${mime}] — probando alternativa:`, e);
      }
    }
  } else {
    console.warn(
      "[transcribe] este bot no tiene el binding [ai] en wrangler.toml (bots viejos: agrega el bloque `[ai]` + `binding = \"AI\"` y redeploy) — probando alternativa",
    );
  }

  // 2) OpenAI Whisper — solo si el miembro tiene llave.
  if (env.OPENAI_API_KEY) {
    const ext = /mp4|m4a|aac/.test(mime) ? "m4a" : /mpeg|mp3/.test(mime) ? "mp3" : "ogg";
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), `audio.${ext}`);
    form.append("model", "whisper-1");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (r.ok) {
      const j = (await r.json()) as { text?: string };
      const text = (j.text ?? "").trim();
      if (text) return { text };
      console.warn("[transcribe] OpenAI Whisper devolvió texto vacío");
    } else {
      console.warn(
        `[transcribe] OpenAI Whisper http_${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
      );
    }
  }

  throw new Error(
    "sin vía de transcripción: ni binding [ai] (Workers AI) ni OPENAI_API_KEY — agrega el bloque [ai] a wrangler.toml y redeploy",
  );
}
