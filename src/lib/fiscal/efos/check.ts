// ─────────────────────────────────────────────────────────────────────────────
// Revisión 69-B: cruza los CFDIs recibidos contra la lista de EFOS. Un proveedor
// DEFINITIVO → las deducciones / IVA acreditable son improcedentes (error);
// PRESUNTO → riesgo (warn). Agrupa por proveedor para no inundar de hallazgos.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hallazgo } from "../audit/types";
import type { CfdiProveedor, ListaEfos, SituacionEfos } from "./types";

const fmt = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

const FUNDAMENTO = { ley: "CFF", articulo: "69-B" };

export function revisarEfos(recibidos: CfdiProveedor[], lista: ListaEfos): Hallazgo[] {
  // Agrupa los CFDIs por proveedor en situación de riesgo.
  const porProveedor = new Map<string, { situacion: SituacionEfos; cfdis: CfdiProveedor[] }>();
  for (const c of recibidos) {
    const rfc = c.emisorRfc.toUpperCase().trim();
    const situacion = lista.get(rfc);
    if (situacion !== "DEFINITIVO" && situacion !== "PRESUNTO") continue;
    const g = porProveedor.get(rfc) ?? { situacion, cfdis: [] };
    g.cfdis.push(c);
    porProveedor.set(rfc, g);
  }

  const hallazgos: Hallazgo[] = [];
  for (const [rfc, { situacion, cfdis }] of porProveedor) {
    const total = cfdis.reduce((s, c) => s + c.total, 0);
    const definitivo = situacion === "DEFINITIVO";
    hallazgos.push({
      checkClave: definitivo ? "efos.definitivo" : "efos.presunto",
      severidad: definitivo ? "error" : "warn",
      mensaje: definitivo
        ? `Proveedor ${rfc} está en la lista 69-B como DEFINITIVO: ${cfdis.length} CFDI(s) por ${fmt(total)}. Las deducciones y el IVA acreditable de operaciones con este EFOS son improcedentes.`
        : `Proveedor ${rfc} está como PRESUNTO en la lista 69-B: ${cfdis.length} CFDI(s) por ${fmt(total)}. Riesgo de que las deducciones se vuelvan improcedentes si pasa a definitivo.`,
      referencias: cfdis.map((c) => c.id),
      fundamento: FUNDAMENTO,
      sugerencia: definitivo
        ? "No deduzcas ni acredites IVA de estos CFDIs; valora autocorregir las declaraciones afectadas y, en su caso, acreditar la materialidad."
        : "Da seguimiento al estatus del proveedor y resguarda la evidencia de materialidad de las operaciones.",
    });
  }
  // Definitivos primero.
  return hallazgos.sort((a, b) => (a.severidad === "error" ? 0 : 1) - (b.severidad === "error" ? 0 : 1));
}
