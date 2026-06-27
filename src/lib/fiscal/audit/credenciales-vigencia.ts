// ─────────────────────────────────────────────────────────────────────────────
// Vigencia de credenciales fiscales. El CSD (sello) y la e.firma (FIEL) tienen
// fecha de caducidad. Si vencen, el contribuyente NO puede timbrar CFDIs (CSD)
// ni presentar declaraciones / firmar trámites en el SAT (FIEL). Es alto valor y
// bajo falso positivo: la fecha de vigencia es un dato duro. Avisamos cuando ya
// venció (error) o está por vencer dentro de UMBRAL_DIAS (warn) para dar margen
// de renovación. Sólo evaluamos credenciales con fecha registrada.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import type { Hallazgo } from "./types";

/** Días antes del vencimiento a partir de los cuales avisamos (warn). */
export const UMBRAL_DIAS = 30;

const DIA_MS = 24 * 60 * 60 * 1000;

export interface CredencialesVigencia {
  companyId: string;
  csdVigencia: Date | null;
  fielVigencia: Date | null;
}

/** Carga las fechas de vigencia del CSD y la e.firma de la empresa. */
export async function cargarCredencialesVigencia(
  companyId: string,
): Promise<CredencialesVigencia> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { csdVigencia: true, fielVigencia: true },
  });
  return {
    companyId,
    csdVigencia: company?.csdVigencia ?? null,
    fielVigencia: company?.fielVigencia ?? null,
  };
}

interface CredencialSpec {
  clave: string;
  nombre: string; // texto en el mensaje, p.ej. "sello (CSD)"
  vigencia: Date | null;
}

function evaluarCredencial(
  spec: CredencialSpec,
  companyId: string,
  hoy: Date,
): Hallazgo | null {
  if (!spec.vigencia) return null; // sin fecha registrada → nada que evaluar

  const dias = Math.floor((spec.vigencia.getTime() - hoy.getTime()) / DIA_MS);

  const fundamento = { ley: "CFF", articulo: "17-D" };

  if (dias < 0) {
    const hace = Math.abs(dias);
    return {
      checkClave: spec.clave,
      severidad: "error",
      mensaje: `Tu ${spec.nombre} venció hace ${hace} día${hace === 1 ? "" : "s"} — sin él no podrás timbrar ni declarar.`,
      referencias: [companyId],
      fundamento,
      sugerencia:
        "Renueva la credencial en el SAT y vuelve a subirla en Mi Empresa para reanudar el timbrado y las declaraciones.",
    };
  }

  if (dias <= UMBRAL_DIAS) {
    return {
      checkClave: spec.clave,
      severidad: "warn",
      mensaje: `Tu ${spec.nombre} vence en ${dias} día${dias === 1 ? "" : "s"} — sin él no podrás timbrar ni declarar.`,
      referencias: [companyId],
      fundamento,
      sugerencia:
        "Renueva la credencial en el SAT antes de que venza y vuelve a subirla en Mi Empresa para no interrumpir el timbrado ni las declaraciones.",
    };
  }

  return null;
}

/** Un hallazgo por credencial vencida o por vencer (CSD y/o e.firma). */
export function auditarCredencialesVigencia(
  data: CredencialesVigencia,
  hoy: Date,
): Hallazgo[] {
  const specs: CredencialSpec[] = [
    { clave: "csd.por_vencer", nombre: "sello (CSD)", vigencia: data.csdVigencia },
    { clave: "fiel.por_vencer", nombre: "e.firma (FIEL)", vigencia: data.fielVigencia },
  ];
  return specs
    .map((s) => evaluarCredencial(s, data.companyId, hoy))
    .filter((h): h is Hallazgo => h !== null);
}
