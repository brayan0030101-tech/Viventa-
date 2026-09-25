// Canales donde el channelUserId de la conversación ES el número de WhatsApp
// del cliente (E.164, normalmente sin "+" guardado). En estos NO hace falta
// pedirle el teléfono al cliente — ya lo tenemos del canal mismo; pedírselo
// además de raro (ya está hablando por WhatsApp) genera fricción y, si el
// bot lo pide dos veces, hace quedar mal al negocio. Ver conversación real
// 2026-09-25: el bot le volvió a pedir el número a un cliente que ya se lo
// había dado. Telegram/web/manychat NO entran aquí: su channelUserId no es
// un teléfono (chat id / session id / subscriber id).
const WHATSAPP_LIKE_CHANNELS = new Set(["ycloud", "kapso", "twilio", "whatsapp"]);

export function phoneFromConversationId(conversationId: string | null): string | null {
  if (!conversationId) return null;
  const sep = conversationId.indexOf(":");
  if (sep === -1) return null;
  const channel = conversationId.slice(0, sep);
  const channelUserId = conversationId.slice(sep + 1);
  if (!WHATSAPP_LIKE_CHANNELS.has(channel) || !channelUserId) return null;
  return channelUserId.startsWith("+") ? channelUserId : `+${channelUserId}`;
}

export function channelUserIdFromConversationId(conversationId: string | null): string | null {
  if (!conversationId) return null;
  const sep = conversationId.indexOf(":");
  if (sep === -1) return null;
  return conversationId.slice(sep + 1) || null;
}
