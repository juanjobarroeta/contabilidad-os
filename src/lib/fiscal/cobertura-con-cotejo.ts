import { prisma } from "../prisma";
import { evaluarCoberturaFiscal, type CoberturaDataset } from "./cobertura-datos";

// Cobertura fiscal CON el cotejo automático aplicado. evaluarCoberturaFiscal es
// puro/sync y marca "sin_cotejar" cuando verificado:false (compilado). Esta capa
// async lee CotejoFiscal (lo que el cron cotejó contra INEGI) y sube un dataset
// de "sin_cotejar" → "al_dia" cuando la fuente oficial confirmó los valores hasta
// el último periodo cargado. Recalcula el resumen.
export async function coberturaConCotejo(asOf: Date = new Date()): Promise<{
  asOf: string;
  datasets: CoberturaDataset[];
  resumen: { alDia: number; faltantes: number; sinCotejar: number };
}> {
  const base = evaluarCoberturaFiscal(asOf);
  const cotejos = await prisma.cotejoFiscal.findMany();
  const byDataset = new Map(cotejos.map((c) => [c.dataset, c]));

  const datasets = base.datasets.map((d) => {
    if (d.estado !== "sin_cotejar") return d;
    const c = byDataset.get(d.clave);
    const cubre = c?.verifiedThrough && d.ultimoCargado && c.verifiedThrough >= d.ultimoCargado;
    if (c?.verificado && cubre) {
      const fecha = c.matchedAt ? c.matchedAt.toISOString().slice(0, 10) : "";
      return {
        ...d,
        verificado: true,
        estado: "al_dia" as const,
        detalle: `Cotejado contra ${c.fuente ?? "la fuente oficial"}${fecha ? ` (${fecha})` : ""}.`,
      };
    }
    return d;
  });

  const resumen = {
    alDia: datasets.filter((d) => d.estado === "al_dia").length,
    faltantes: datasets.filter((d) => d.estado === "faltante").length,
    sinCotejar: datasets.filter((d) => d.estado === "sin_cotejar").length,
  };
  return { asOf: base.asOf, datasets, resumen };
}
