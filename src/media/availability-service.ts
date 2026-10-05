import type { Env } from "../env";
import {
  calcomConfigured,
  calcomTimeZone,
  getAvailableSlotsRange,
  getUpcomingBookingStarts,
  resolveEventTypeId,
} from "../integrations/calcom";
import {
  availabilityText,
  buildAvailabilityDays,
  buildAvailabilitySvg,
  localParts,
  type AvailabilityDay,
  type AvailabilityMode,
} from "./availability";

const HORIZON_DAYS = 10;
const CACHE_MS = 60_000;
const URL_TTL_MS = 30 * 60 * 1000;
const SIG_DOMAIN = "availability-img";

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function loadAvailabilityDays(env: Env, mode: AvailabilityMode = "dia"): Promise<AvailabilityDay[] | null> {
  if (!calcomConfigured(env)) return null;
  const eventTypeId = resolveEventTypeId(env);
  if (!eventTypeId) return null;
  const tz = calcomTimeZone(env);
  const today = localParts(new Date().toISOString(), tz).date;
  const toDate = addDays(today, HORIZON_DAYS);
  const [free, booked] = await Promise.all([
    getAvailableSlotsRange(env, eventTypeId, today, toDate, tz),
    getUpcomingBookingStarts(env, eventTypeId),
  ]);
  if (!free.ok) return null;
  const days = buildAvailabilityDays({
    freeByDate: free.byDate,
    bookedStarts: booked.ok ? booked.starts : [],
    timeZone: tz,
    fromDate: today,
    toDate,
    mode,
  });
  return days.length ? days : null;
}

const cache = new Map<AvailabilityMode, { at: number; png: Uint8Array }>();

export async function getAvailabilityPng(env: Env, mode: AvailabilityMode = "dia"): Promise<Uint8Array | null> {
  const hit = cache.get(mode);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.png;
  const days = await loadAvailabilityDays(env, mode);
  if (!days) return null;
  const { svgToPng } = await import("./availability-render");
  const png = await svgToPng(buildAvailabilitySvg(days, undefined, mode));
  cache.set(mode, { at: Date.now(), png });
  return png;
}

export async function getAvailabilityText(env: Env, mode: AvailabilityMode = "dia"): Promise<string | null> {
  const days = await loadAvailabilityDays(env, mode);
  return days ? availabilityText(days) : null;
}

function signingSecret(env: Env): string {
  return env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || env.CONTROL_PLANE_TOKEN || env.YCLOUD_WEBHOOK_SECRET || "";
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signedAvailabilityUrl(env: Env, origin: string, mode: AvailabilityMode = "dia"): Promise<string | null> {
  const secret = signingSecret(env);
  const base = origin.replace(/\/+$/, "");
  if (!secret || !base) return null;
  const exp = Date.now() + URL_TTL_MS;
  const sig = await hmacHex(secret, `${SIG_DOMAIN}.${mode}.${exp}`);
  return `${base}/disponibilidad.png?m=${mode}&exp=${exp}&sig=${sig}`;
}

export async function verifyAvailabilitySignature(
  env: Env,
  exp: string | null,
  sig: string | null,
  mode: AvailabilityMode = "dia",
): Promise<"ok" | "expired" | "invalid"> {
  const secret = signingSecret(env);
  const expNum = Number(exp);
  if (!secret || !exp || !sig || !Number.isFinite(expNum)) return "invalid";
  if (Date.now() > expNum) return "expired";
  const expected = await hmacHex(secret, `${SIG_DOMAIN}.${mode}.${exp}`);
  if (expected.length !== sig.length) return "invalid";
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? "ok" : "invalid";
}
