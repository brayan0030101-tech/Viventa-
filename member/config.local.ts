// member/config.local.ts — generado por `forja init`. Edítalo cuando quieras.
// NUNCA se sobrescribe al actualizar el bot.

export const memberConfig = {
  businessName: "Viventa",
  botName: "Maricela",
  language: "es" as "es" | "en" | "pt",
  tier: "pro" as "free" | "pro",
  timezone: "America/Bogota",
  // Moneda con la que el bot habla de precios ($ | € | R$). El bot la lee de
  // aquí si no la cambiaste en el panel (setting bot_currency manda si existe).
  currency: "$",
  contactEmail: "",
};
export type MemberConfig = typeof memberConfig;

export const businessConfig = {
  hours: "L-V horario laboral por WhatsApp; Madrid solo con cita previa",
  services: [] as { name: string; price: number }[],
  location: "Oficinas en Miami, Madrid (cita previa), New York y New Jersey; proyectos en varias ciudades de Colombia",
  paymentMethods: ["tarjeta (se envía factura)"] as string[],
  contactPhone: "+34 611 688 609",
  customFields: {
  "queHacemos": "acompañamiento a colombianos en el exterior para comprar y financiar vivienda en Colombia (apartamentos, casas, preconstrucción, vivienda usada)",
  "ofrecemos": "Estudio de Viabilidad Financiera USD 45 (no reembolsable); Servicio Viventa de acompañamiento completo USD 450 (Europa 505€, EEUU 495 USD, reembolsable si el crédito es negado cumpliendo condiciones); proyectos desde 228 millones hasta más de 1100 millones COP en Bogotá, Cali, Barranquilla, Pereira, Cartagena, Manizales, Zipaquirá, Rionegro, La Estrella y Santa Marta",
  "tono": "cercano",
  "sitioWebYRedes": "instagram.com/compratucasaconmari",
  "preguntasFrecuentes": "¿Cuándo es el outlet de Viventa?, ¿Cómo agendar una cita para el Outlet?, ¿Qué tengo que hacer para comprar vivienda en Colombia?, ¿En qué ciudades de Colombia tienen proyectos?, ¿Los proyectos son de entrega inmediata o se pueden ir pagando?",
  "reglasYEscalacion": "no prometer aprobación de crédito; no dar asesoría legal o financiera definitiva; pasar a Maricela (humano) ante negociación de crédito o dudas puntuales del Outlet"
} as Record<string, string>,
};

import type { CommentFunnel } from "../src/channels/comment-funnel";
export const commentFunnels: CommentFunnel[] = [];

export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];
