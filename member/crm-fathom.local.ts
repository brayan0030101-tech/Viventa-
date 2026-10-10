// member/crm-fathom.local.ts — Recibe de Fathom la transcripción de cada videollamada y la
// interpreta sola (resultado, pendientes, etapa del pipeline). Sin trabajo manual.
//   Fathom → POST /webhooks/fathom (firmado, estándar «Standard Webhooks») → emparejar con la cita
//   → analizarLlamada → aviso por Telegram al equipo.
import type { Env } from "../src/env";
import { Db } from "../src/db/client";
import { notifyCamila } from "../src/lib/camila";

const TOLERANCIA_MS = 5 * 60_000;
const VENTANA_CITA_MS = 90 * 60_000;

// ─── Firma ───────────────────────────────────────────────────────────────────

function b64aBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verificarFirmaFathom(
  secreto: string,
  h: { id: string; timestamp: string; firma: string },
  cuerpo: string,
  now = Date.now(),
): Promise<boolean> {
  const ts = Number(h.timestamp);
  if (!h.id || !h.firma || !Number.isFinite(ts) || Math.abs(now - ts * 1000) > TOLERANCIA_MS) return false;
  try {
    const clave = await crypto.subtle.importKey("raw", b64aBytes(secreto.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${h.id}.${h.timestamp}.${cuerpo}`)));
    const esperada = btoa(String.fromCharCode(...mac));
    // El encabezado puede traer varias firmas: «v1,abc v1,def».
    return h.firma.split(" ").some((p) => {
      const v = p.split(",")[1] ?? "";
      if (v.length !== esperada.length) return false;
      let d = 0;
      for (let i = 0; i < v.length; i++) d |= v.charCodeAt(i) ^ esperada.charCodeAt(i);
      return d === 0;
    });
  } catch {
    return false;
  }
}

// ─── Contenido ───────────────────────────────────────────────────────────────

export interface ReunionFathom {
  recording_id?: number;
  title?: string;
  meeting_title?: string | null;
  scheduled_start_time?: string;
  transcript_language?: string;
  transcript?: Array<{ speaker?: { display_name?: string }; text?: string; timestamp?: string }> | null;
  calendar_invitees?: Array<{ name?: string | null; email?: string | null; is_external?: boolean }>;
}

export function transcripcionATexto(r: ReunionFathom): string {
  return (r.transcript ?? [])
    .filter((t) => t.text)
    .map((t) => `[${t.timestamp ?? ""}] ${t.speaker?.display_name ?? "?"}: ${t.text}`)
    .join("\n");
}

async function asegurarTabla(db: Db): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS crm_fathom (recording_id TEXT PRIMARY KEY, creado INTEGER NOT NULL, lead_id TEXT, estado TEXT NOT NULL DEFAULT '')");
}

/** Busca la videollamada agendada que corresponde a la reunión de Fathom (por hora y, si hay dudas, por correo). */
export async function emparejarLlamada(env: Env, r: ReunionFathom, now = Date.now()): Promise<string | null> {
  const inicio = r.scheduled_start_time ? Date.parse(r.scheduled_start_time) : NaN;
  if (!Number.isFinite(inicio)) return null;
  const { cargarLlamadas } = await import("./crm-calendario.local");
  const cand = (await cargarLlamadas(env, now)).filter((l) => l.estado !== "cancelada" && Math.abs(l.inicio - inicio) <= VENTANA_CITA_MS);
  if (cand.length <= 1) return cand[0]?.id ?? null;
  const correos = new Set((r.calendar_invitees ?? []).filter((i) => i.is_external && i.email).map((i) => i.email!.toLowerCase()));
  const { cargarCrm } = await import("./crm.local");
  const porConv = new Map((await cargarCrm(env, now)).map((f) => [f.lead.convId, f.lead.correo.toLowerCase()]));
  const exacto = cand.find((l) => [...correos].some((c) => (porConv.get(l.convId) ?? "").includes(c)));
  if (exacto) return exacto.id;
  return cand.sort((a, b) => Math.abs(a.inicio - inicio) - Math.abs(b.inicio - inicio))[0].id;
}

// ─── Recepción ───────────────────────────────────────────────────────────────

export type EstadoRecepcion = "analizada" | "duplicada" | "sin_cita" | "sin_transcripcion" | "error";

export async function procesarReunionFathom(env: Env, r: ReunionFathom, now = Date.now()): Promise<{ estado: EstadoRecepcion; leadId?: string }> {
  const db = new Db(env.DB);
  await asegurarTabla(db);
  const rid = String(r.recording_id ?? "");
  if (!rid) return { estado: "sin_transcripcion" };
  if (await db.first("SELECT 1 AS x FROM crm_fathom WHERE recording_id = ?", [rid])) return { estado: "duplicada" };
  await db.run("INSERT INTO crm_fathom (recording_id, creado, estado) VALUES (?,?,'recibida')", [rid, now]);

  const texto = transcripcionATexto(r);
  const titulo = r.meeting_title || r.title || "reunión";
  const avisar = (heading: string, body: string) => notifyCamila(env, { heading, body }).catch(() => false);
  if (texto.length < 200) {
    await db.run("UPDATE crm_fathom SET estado = 'sin_transcripcion' WHERE recording_id = ?", [rid]);
    return { estado: "sin_transcripcion" };
  }
  const leadId = await emparejarLlamada(env, r, now);
  if (!leadId) {
    await db.run("UPDATE crm_fathom SET estado = 'sin_cita' WHERE recording_id = ?", [rid]);
    await avisar("📝 Fathom: llamada sin cliente asociado", `Fathom grabó «${titulo}» pero no encontré la cita del CRM para asociarla. No se analizó.`);
    return { estado: "sin_cita" };
  }
  const { analizarLlamada } = await import("./crm-resultados.local");
  const res = await analizarLlamada(env, leadId, texto, now);
  if (!res.ok) {
    await db.run("DELETE FROM crm_fathom WHERE recording_id = ?", [rid]); // que Fathom pueda reintentar
    console.error("[crm-fathom] análisis falló:", res.error);
    return { estado: "error", leadId };
  }
  await db.run("UPDATE crm_fathom SET estado = 'analizada', lead_id = ? WHERE recording_id = ?", [leadId, rid]);
  const a = res.resultado.analisis;
  const etiqueta = { concretado: "✅ se concretó", parcial: "🟡 avance parcial", no_concretado: "⚪ no se concretó", sin_respuesta: "🚫 sin respuesta" }[a.resultado];
  await avisar(
    "📝 Llamada analizada",
    `${etiqueta}${a.ventaCerrada ? " · 🏆 venta cerrada" : ""} · interés ${a.interes}/5\n${a.resumen}\n${a.pendientes.length ? `Pendientes: ${a.pendientes.map((p) => p.tarea).join("; ")}` : "Sin pendientes."}`,
  );
  return { estado: "analizada", leadId };
}
