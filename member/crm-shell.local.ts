// member/crm-shell.local.ts — el «marco» del CRM de Viventa: totalmente independiente del panel
// de Forja (otra dirección, otro acceso, otro diseño). Colores y logo de viventa.co.
import type { Env } from "../src/env";
import { layout as layoutForja } from "../src/admin/views/layout";

export const BASE = "/crm";

/** Dónde vive el CRM: «separado» (/crm, su propio acceso), «junto» (dentro del panel de Forja, /admin/crm) o «ambos». */
export type ModoCrm = "separado" | "junto" | "ambos";
export function modoValido(v: string | null | undefined): ModoCrm {
  const t = (v ?? "").trim().toLowerCase();
  return t === "separado" || t === "junto" ? t : "ambos";
}

type EntornoCrm = Env & { CRM_BASE?: string; CRM_SHELL?: string };
/** Ruta base con la que se pintan los enlaces: «/crm» (separado) o «/admin/crm» (dentro del panel de Forja). */
export const baseDe = (env?: Env): string => (env as EntornoCrm | undefined)?.CRM_BASE ?? BASE;
export const esEmbebido = (env?: Env): boolean => (env as EntornoCrm | undefined)?.CRM_SHELL === "forja";

/** Cambia los enlaces «/crm…» de una página ya pintada por la ruta base elegida. */
export function reBase(html: string, base: string): string {
  if (base === BASE) return html;
  return html.replace(/(href|action|hx-get|hx-post|src)="\/crm(?=[/?"#])/g, `$1="${base}`);
}

const esc = (v: string | null | undefined): string =>
  (v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Marcador que cada ruta reemplaza con el usuario que tiene la sesión (sin tocar el env compartido). */
export const MARCA_USUARIO = "<!--CRM_USUARIO-->";

export type Seccion = "leads" | "pipeline" | "calendario" | "informes" | "recomendaciones" | "zoho" | "usuarios" | "modo";

const ESTILO_BASE = `<style>
  :root{
    --bg:#161A33; --panel:#1C2142; --panel2:#232950; --raise:#2A3060;
    --line:#2F3668; --linelit:#454D8C;
    --accent:#E60D6F; --accent-2:#F2A2C6; --accent-soft:rgba(230,13,111,.15);
    --cream:#EEF0FA; --muted:#A7ADD3; --dim:#7A80AE;
    --ok:#00DDB8; --info:#8FA3D9; --bad:#FF7A8A;
  }
  html[data-tema="claro"]{
    --bg:#F4F6FC; --panel:#FFFFFF; --panel2:#F0F2FA; --raise:#E8EBF7;
    --line:#DCE0F0; --linelit:#BEC5E2;
    --accent:#E60D6F; --accent-2:#C70A60; --accent-soft:rgba(230,13,111,.09);
    --cream:#1B1F3B; --muted:#4F557F; --dim:#838AB0;
    --ok:#009C84; --info:#4A60B3; --bad:#D3304A;
  }
  html[data-tema="claro"] body{background:var(--bg)}
  html[data-tema="claro"] .modal-backdrop{background:rgba(27,31,59,.45)}
  html[data-tema="claro"] .modal-card{box-shadow:8px 8px 0 rgba(27,31,59,.12)}
  html[data-tema="claro"] .bigbtn:hover{box-shadow:5px 5px 0 var(--linelit)}
  .logo-claro{display:none} html[data-tema="claro"] .logo-oscuro{display:none} html[data-tema="claro"] .logo-claro{display:block}
  .btn-tema{background:var(--panel2);border:1px solid var(--line);color:var(--muted);padding:6px 12px;font-size:12px;cursor:pointer;transition:all .12s ease}
  .btn-tema:hover{border-color:var(--accent);color:var(--cream)}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--cream);font-family:'Poppins',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  a:hover{color:var(--accent-2)}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:var(--bg)}
  ::-webkit-scrollbar-thumb{background:var(--linelit)}
  ::-webkit-scrollbar-thumb:hover{background:var(--accent)}
  input,textarea,select,button{font-family:inherit}
  input::placeholder,textarea::placeholder{color:var(--dim)}
  .text-dim{color:var(--dim)} .text-muted{color:var(--muted)} .text-cream{color:var(--cream)} .text-accent{color:var(--accent)}
  .shell{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
  .sb{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
  .sb-nav{flex:1;padding:14px 10px;overflow-y:auto}
  .nav{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:3px;font-size:13.5px;font-weight:500;color:var(--muted);border-left:3px solid transparent;transition:all .12s ease}
  .nav:hover{background:var(--panel2);color:var(--cream)}
  .nav.on{background:var(--accent-soft);color:var(--cream);border-left-color:var(--accent);font-weight:600}
  .topbar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 26px}
  main{padding:22px 26px;min-width:0}
  .bigbtn{transition:transform .12s ease,box-shadow .12s ease;cursor:pointer;display:inline-block}
  .bigbtn:hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 var(--linelit);color:var(--bg)}
  .bigbtn:active{transform:none;box-shadow:none}
  .ghostbtn{transition:all .12s ease}
  .ghostbtn:hover{border-color:var(--accent) !important;color:var(--cream) !important;background:var(--accent-soft)}
  .modal-backdrop{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(8,10,28,.7);animation:fadeIn .15s ease-out}
  .modal-card{background:var(--panel);border:1px solid var(--linelit);box-shadow:8px 8px 0 rgba(0,0,0,.35);animation:popIn .2s ease-out}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes popIn{from{opacity:0;transform:scale(.95) translateY(8px)}to{opacity:1;transform:none}}
  @media (max-width:860px){
    .shell{grid-template-columns:1fr}
    .sb{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center}
    .sb-nav{display:flex;flex-wrap:wrap;padding:6px 10px}
    .nav{margin:0 4px 0 0;padding:8px 10px;border-left:0;border-bottom:3px solid transparent}
    .nav.on{border-bottom-color:var(--accent)}
    main{padding:16px}
    .topbar{padding:12px 16px}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}
</style>`;

/** Recuerda el tema elegido (claro / oscuro) y lo aplica antes de pintar, para que no parpadee. */
const SCRIPT_TEMA = `<script>(function(){try{var t=localStorage.getItem('crm_tema');if(t!=='claro'&&t!=='oscuro')t='claro';document.documentElement.setAttribute('data-tema',t)}catch(e){document.documentElement.setAttribute('data-tema','claro')}})();
function cambiarTema(){var h=document.documentElement,n=h.getAttribute('data-tema')==='claro'?'oscuro':'claro';h.setAttribute('data-tema',n);try{localStorage.setItem('crm_tema',n)}catch(e){}var b=document.getElementById('btn-tema');if(b)b.textContent=n==='claro'?'🌙 Modo oscuro':'☀️ Modo claro'}
document.addEventListener('DOMContentLoaded',function(){var b=document.getElementById('btn-tema');if(b)b.textContent=document.documentElement.getAttribute('data-tema')==='claro'?'🌙 Modo oscuro':'☀️ Modo claro'});</script>`;

const BOTON_TEMA = `<button type="button" id="btn-tema" class="btn-tema" onclick="cambiarTema()" title="Cambiar entre modo claro y modo oscuro">☀️ Modo claro</button>`;

const FUENTES = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const ITEMS: Array<{ id: Seccion; href: string; icono: string; texto: string; soloAdmin?: boolean }> = [
  { id: "leads", href: BASE, icono: "👥", texto: "Leads" },
  { id: "pipeline", href: `${BASE}/pipeline`, icono: "🧭", texto: "Pipeline" },
  { id: "calendario", href: `${BASE}/calendario`, icono: "📅", texto: "Calendario de llamadas" },
  { id: "informes", href: `${BASE}/informes`, icono: "📊", texto: "Informes" },
  { id: "recomendaciones", href: `${BASE}/recomendaciones`, icono: "🧠", texto: "Recomendaciones" },
  { id: "zoho", href: `${BASE}/zoho`, icono: "📤", texto: "Subir a Zoho" },
  { id: "usuarios", href: `${BASE}/usuarios`, icono: "🔑", texto: "Usuarios", soloAdmin: true },
  { id: "modo", href: `${BASE}/modo`, icono: "⚙️", texto: "Vista del CRM", soloAdmin: true },
];

const TITULOS: Record<Seccion, string> = {
  leads: "Leads",
  pipeline: "Pipeline de ventas",
  calendario: "Calendario de llamadas",
  informes: "Informes",
  recomendaciones: "Recomendaciones",
  zoho: "Subir clientes a Zoho",
  usuarios: "Usuarios",
  modo: "Vista del CRM",
};

/** Pestañas internas para cuando el CRM se ve DENTRO del panel de Forja (allí solo hay un botón «CRM»). */
function tabsEmbebidas(activa: Seccion): string {
  const tab = (id: Seccion, href: string, texto: string) =>
    `<a href="${href}" style="padding:9px 16px;font-size:12.5px;font-weight:600;border-bottom:2px solid ${activa === id ? "var(--accent)" : "transparent"};color:${activa === id ? "var(--cream)" : "var(--muted)"}">${texto}</a>`;
  return `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px;border-bottom:1px solid var(--line)">${tab("leads", `${BASE}`, "👥 Leads")}${tab("pipeline", `${BASE}/pipeline`, "🧭 Pipeline")}${tab("calendario", `${BASE}/calendario`, "📅 Calendario")}${tab("informes", `${BASE}/informes`, "📊 Informes")}${tab("recomendaciones", `${BASE}/recomendaciones`, "🧠 Recomendaciones")}${tab("zoho", `${BASE}/zoho`, "📤 Subir a Zoho")}${tab("modo", `${BASE}/modo`, "⚙️ Vista")}</div>`;
}

export function crmLayout(opts: { title: string; activa: Seccion; body: string; env?: Env }): string {
  if (esEmbebido(opts.env)) {
    // Dentro del panel de Forja: se usa su marco y se añaden las pestañas del CRM.
    return layoutForja({ title: `CRM · ${opts.title}`, activeTab: "crm", body: tabsEmbebidas(opts.activa) + opts.body, env: opts.env });
  }
  const nav = ITEMS.map((i) => `<a class="nav${i.id === opts.activa ? " on" : ""}" href="${i.href}" data-solo-admin="${i.soloAdmin ? "1" : "0"}"><span>${i.icono}</span>${i.texto}</a>`).join("");
  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)} · Viventa</title>
<link rel="icon" href="${BASE}/logo.svg" type="image/svg+xml">
${SCRIPT_TEMA}
${FUENTES}
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
${ESTILO_BASE}
</head>
<body>
<div class="shell">
  <aside class="sb">
    <div style="padding:20px 18px 16px;border-bottom:1px solid var(--line)">
      <a href="${BASE}"><img class="logo-oscuro" src="${BASE}/logo.svg" alt="Viventa" style="height:30px;width:auto;display:block"><img class="logo-claro" src="${BASE}/logo.svg?tema=claro" alt="Viventa" style="height:30px;width:auto"></a>
      <div style="font-size:10px;letter-spacing:.2em;color:var(--dim);text-transform:uppercase;margin-top:8px">CRM · Maricela Naranjo</div>
    </div>
    <nav class="sb-nav">${nav}</nav>
    ${MARCA_USUARIO}
  </aside>
  <div style="min-width:0">
    <header class="topbar" style="display:flex;align-items:center;gap:14px"><h1 style="font-weight:700;font-size:21px;margin:0;letter-spacing:-.01em">${TITULOS[opts.activa]}</h1><span style="margin-left:auto">${BOTON_TEMA}</span></header>
    <main>${opts.body}</main>
  </div>
</div>
<div id="modal-root"></div>
</body></html>`;
}

/** Reemplaza el marcador por el bloque del usuario (nombre, rol y «Cerrar sesión») y oculta lo de administrador a quien no lo es. */
export function conUsuario(html: string, u: { nombre: string; correo: string; rol: "admin" | "equipo" } | null): string {
  let out = html;
  if (!u || u.rol !== "admin") out = out.replace(/<a class="nav[^"]*" href="[^"]*" data-solo-admin="1">.*?<\/a>/s, "");
  out = out.replace(/ data-solo-admin="[01]"/g, "");
  const bloque = u
    ? `<div style="padding:14px;border-top:1px solid var(--line)"><div style="font-size:12.5px;font-weight:600;color:var(--cream)">${esc(u.nombre || u.correo)}</div>
        <div style="font-size:10.5px;color:var(--dim);margin-bottom:8px">${u.rol === "admin" ? "Administrador" : "Equipo"} · ${esc(u.correo)}</div>
        <a href="${BASE}/salir" class="ghostbtn" style="display:inline-block;border:1px solid var(--line);padding:5px 12px;font-size:11.5px;color:var(--muted)">Cerrar sesión</a></div>`
    : "";
  return out.replace(MARCA_USUARIO, bloque);
}

/** Páginas sueltas (acceso, invitación): mismo diseño, sin menú. */
export function paginaSimple(titulo: string, cuerpo: string): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(titulo)} · Viventa</title>
<link rel="icon" href="${BASE}/logo.svg" type="image/svg+xml">${SCRIPT_TEMA}${FUENTES}${ESTILO_BASE}</head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:var(--bg)">
<div style="position:fixed;top:14px;right:14px">${BOTON_TEMA}</div>
<div style="width:min(420px,100%);background:var(--panel);border:1px solid var(--line);border-top:4px solid var(--accent);padding:30px 28px;box-shadow:10px 10px 0 rgba(0,0,0,.25)">
  <img class="logo-oscuro" src="${BASE}/logo.svg" alt="Viventa" style="height:34px;width:auto;display:block;margin-bottom:6px"><img class="logo-claro" src="${BASE}/logo.svg?tema=claro" alt="Viventa" style="height:34px;width:auto;margin-bottom:6px">
  <div style="font-size:11px;letter-spacing:.2em;color:var(--dim);text-transform:uppercase;margin-bottom:22px">CRM · Maricela Naranjo</div>
  ${cuerpo}
</div></body></html>`;
}

export const ESTILO_CAMPO = "width:100%;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:11px 12px;font-size:14px;outline:none;margin-bottom:12px";
export const ESTILO_BOTON = "width:100%;background:var(--accent);color:#fff;border:0;padding:12px;font-size:14px;font-weight:700;cursor:pointer";
