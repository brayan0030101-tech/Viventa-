/**
 * Descarga de medios entrantes (audios, fotos) desde la CDN de los canales.
 *
 * La CDN de Meta (lookaside.fbsbx.com / cdninstagram) le sirve una PÁGINA HTML
 * de error (~48 KB, content-type text/html) a los clientes sin User-Agent de
 * navegador — y el fetch pelón de un Worker no manda ninguno. Con UA + Accept de
 * navegador devuelve el binario real. Era la causa de que ningún audio de
 * Instagram se pudiera transcribir (Whisper y Nova-3 recibían HTML).
 * Inofensivo para WhatsApp/Telegram/Twilio (ignoran el UA).
 */
export const MEDIA_FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  Accept: "image/avif,image/webp,image/apng,image/*,video/*,audio/*,*/*;q=0.8",
};

export function fetchMedia(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    ...init,
    headers: { ...MEDIA_FETCH_HEADERS, ...((init.headers as Record<string, string> | undefined) ?? {}) },
  });
}

/** ¿La respuesta es una página/JSON de error en vez del archivo? */
export function isErrorPage(res: Response): boolean {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  return /^\s*(text\/html|application\/json|text\/plain)/.test(ct);
}
