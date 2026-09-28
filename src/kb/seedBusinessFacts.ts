import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo } from "../db/settings";
import { KbDocsRepo, indexDoc } from "./docs";

// Datos fijos del negocio que Maricela nos fue pasando y no estaban en la KB
// (el bot los buscaba con searchKb y no encontraba nada). Cada uno se siembra
// UNA sola vez (settings gatea con su propia key "sembrado") — así después se
// pueden editar libremente desde /admin/kb sin que esto los pise de nuevo.
interface SeedDoc {
  seedKey: string;
  id: string;
  title: string;
  content: string;
}

const SEED_DOCS: SeedDoc[] = [
  {
    seedKey: "viventa_seed_bancos_v1",
    id: "financiacion-bancos-aliados",
    title: "Financiación: bancos con los que trabaja Viventa",
    content:
      "Viventa gestiona el financiamiento (credito hipotecario y leasing habitacional) con estos bancos en Colombia: Bancolombia, Davivienda y Banco de Occidente. El acompañamiento completo (Estudio de Viabilidad Financiera + Servicio Viventa) incluye ayudar al cliente a elegir con cual de estos bancos conviene tramitar el credito segun su perfil (ingresos, si es reportado en Datacredito, si compra desde el exterior, etc).",
  },
  {
    seedKey: "viventa_seed_fiducia_v1",
    id: "forma-de-pago-fiducia",
    title: "Forma de pago: fiducia",
    content:
      "La forma de pago de los proyectos es a traves de una fiducia: se crea una fiducia a nombre del cliente comprador, y el pago de las cuotas (por ejemplo la cuota inicial) se va haciendo mes a mes dentro de esa fiducia. Esto protege al comprador: si por algun motivo la constructora no llega a terminar el proyecto, el cliente recibe de vuelta el dinero que ya habia abonado hasta esa fecha en la fiducia. Es una garantia legal, no es que el dinero se le entregue directo a la constructora.",
  },
  {
    seedKey: "viventa_seed_descuento_outlet_v1",
    id: "outlet-descuento-monto",
    title: "Gran Outlet de la Vivienda Colombiana: descuento",
    content:
      "En el Gran Outlet de la Vivienda Colombiana (3 y 4 de octubre de 2026, Hotel NH Madrid Nacional) hay descuentos de vivienda de hasta $60.000.000 de pesos colombianos (COP), ademas de preaprobacion de credito en minutos con los bancos aliados (Bancolombia, Davivienda, Banco de Occidente, Banco de Bogota, Banco Union). Si el cliente pregunta por el monto del descuento, el numero correcto es $60.000.000 COP.",
  },
];

export async function seedBusinessFacts(env: Env): Promise<void> {
  const db = new Db(env.DB);
  const settings = new SettingsRepo(db);
  const repo = new KbDocsRepo(db);

  for (const seed of SEED_DOCS) {
    if ((await settings.get(seed.seedKey)) === "1") continue;
    const doc = { id: seed.id, title: seed.title, content: seed.content, updated_at: Date.now() };
    await repo.upsert(doc);
    await indexDoc(env, doc);
    await settings.set(seed.seedKey, "1");
  }
}
