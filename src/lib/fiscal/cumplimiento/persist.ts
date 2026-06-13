// ─────────────────────────────────────────────────────────────────────────────
// Persistencia del monitoreo de cumplimiento. Guarda un ComplianceSnapshot solo
// cuando el contenido cambió (hash), reconstruye el resultado anterior para
// detectar el cambio, y materializa los Hallazgos en FiscalHallazgo.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluarCambioCumplimiento, hashContenido } from "./diff";
import type { ComplianceResult, CsfPerfil, ResultadoOpinion } from "./types";

type SnapshotRow = {
  tipo: string;
  resultado: string;
  motivos: string[];
  perfil: Prisma.JsonValue;
  fetchedAt: Date;
};

/** Reconstruye un ComplianceResult desde el snapshot guardado (para el diff). */
function reconstruir(snap: SnapshotRow): ComplianceResult {
  const fetchedAt = snap.fetchedAt.toISOString();
  if (snap.tipo === "CSF") {
    return { tipo: "CSF", perfil: (snap.perfil as unknown as CsfPerfil), fetchedAt };
  }
  return {
    tipo: snap.tipo as "SAT_OPINION" | "IMSS_OPINION",
    resultado: snap.resultado as ResultadoOpinion,
    motivos: snap.motivos,
    fetchedAt,
  };
}

export interface PersistResult {
  tipo: string;
  changed: boolean;
  hallazgos: number;
}

/** Guarda el resultado si cambió y materializa los hallazgos derivados. */
export async function persistComplianceResult(
  companyId: string,
  result: ComplianceResult,
): Promise<PersistResult> {
  const tipo = result.tipo;
  const hash = hashContenido(result);

  const last = await prisma.complianceSnapshot.findFirst({
    where: { companyId, tipo },
    orderBy: { fetchedAt: "desc" },
    select: { tipo: true, resultado: true, motivos: true, perfil: true, fetchedAt: true, contenidoHash: true },
  });
  if (last && last.contenidoHash === hash) {
    return { tipo, changed: false, hallazgos: 0 };
  }

  const prev = last ? reconstruir(last) : null;
  const hallazgos = evaluarCambioCumplimiento(result, prev);

  const esCsf = result.tipo === "CSF";
  await prisma.complianceSnapshot.create({
    data: {
      companyId,
      tipo,
      resultado: esCsf ? result.perfil.estatusPadron : result.resultado,
      motivos: esCsf ? [] : result.motivos,
      perfil: esCsf ? (result.perfil as unknown as Prisma.InputJsonValue) : undefined,
      acuseUrl: result.acuseUrl ?? null,
      contenidoHash: hash,
      vigencia: !esCsf && result.vigencia ? toDate(result.vigencia) : null,
    },
  });

  for (const h of hallazgos) {
    const dedupeKey = `${h.checkClave}|${h.referencias.join(",")}`;
    await prisma.fiscalHallazgo.upsert({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
      create: {
        companyId,
        dedupeKey,
        checkClave: h.checkClave,
        severidad: h.severidad,
        mensaje: h.mensaje,
        referencias: h.referencias,
        sugerencia: h.sugerencia,
        fundamentoLey: h.fundamento.ley,
        fundamentoArticulo: h.fundamento.articulo,
        fundamentoFraccion: h.fundamento.fraccion ?? null,
      },
      update: { severidad: h.severidad, mensaje: h.mensaje, referencias: h.referencias, sugerencia: h.sugerencia },
      select: { id: true },
    });
  }

  return { tipo, changed: true, hallazgos: hallazgos.length };
}

function toDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
