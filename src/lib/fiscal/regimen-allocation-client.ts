export interface InvoiceRegimenOption {
  code: string;
  label: string | null;
}

export interface InvoiceRegimenAssignmentApiResponse {
  invoice: {
    id: string;
    tipo: string;
    fecha: string;
    serie: string | null;
    folio: string | null;
    uuid: string | null;
  };
  periodo: string;
  asignable: boolean;
  puedeEditar: boolean;
  regimenesDisponibles: InvoiceRegimenOption[];
  estado: "SIN_ASIGNAR" | "COMPLETA" | "REQUIERE_REVISION";
  observacion?: { code: string; error: string };
  asignacion: {
    revision: number;
    reviewedById: string;
    reviewedByEmail: string | null;
    reviewedAt: string;
    note: string | null;
    allocations: Array<{
      regimenCode: string;
      basisPoints: number;
      porcentaje: number;
    }>;
  } | null;
  usadaEnCalculoAutomatico: false;
}

export type RegimenPercentageDraft = Record<string, string>;

export type RegimenAllocationDraftResult =
  | {
      ok: true;
      totalBasisPoints: 10_000;
      allocations: Array<{ regimenCode: string; basisPoints: number }>;
    }
  | {
      ok: false;
      totalBasisPoints: number | null;
      error: string;
    };

/** Parses 0..100 percent with at most two decimals, accepting MX comma input. */
export function percentageInputToBasisPoints(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return 0;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const basisPoints = whole * 100 + fraction;
  return basisPoints <= 10_000 ? basisPoints : null;
}

export function percentageInputFromBasisPoints(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function regimenPercentageDraft(
  regimenes: ReadonlyArray<InvoiceRegimenOption>,
  asignacion: InvoiceRegimenAssignmentApiResponse["asignacion"],
): RegimenPercentageDraft {
  const draft: RegimenPercentageDraft = Object.fromEntries(
    regimenes.map((regimen) => [regimen.code, ""]),
  );
  for (const allocation of asignacion?.allocations ?? []) {
    if (allocation.regimenCode in draft) {
      draft[allocation.regimenCode] = percentageInputFromBasisPoints(allocation.basisPoints);
    }
  }
  return draft;
}

/** Builds the exact full-replacement payload; zero rows are intentionally omitted. */
export function buildRegimenAllocationDraft(
  regimenes: ReadonlyArray<InvoiceRegimenOption>,
  draft: RegimenPercentageDraft,
): RegimenAllocationDraftResult {
  const allocations: Array<{ regimenCode: string; basisPoints: number }> = [];
  let total = 0;

  for (const regimen of regimenes) {
    const parsed = percentageInputToBasisPoints(draft[regimen.code] ?? "");
    if (parsed === null) {
      return {
        ok: false,
        totalBasisPoints: null,
        error: `El porcentaje de ${regimen.code} debe estar entre 0 y 100, con máximo dos decimales.`,
      };
    }
    total += parsed;
    if (parsed > 0) allocations.push({ regimenCode: regimen.code, basisPoints: parsed });
  }

  if (allocations.length === 0) {
    return {
      ok: false,
      totalBasisPoints: total,
      error: "Asigna al menos un porcentaje.",
    };
  }
  if (total !== 10_000) {
    return {
      ok: false,
      totalBasisPoints: total,
      error: `La asignación debe sumar 100.00%; suma ${(total / 100).toFixed(2)}%.`,
    };
  }
  return { ok: true, totalBasisPoints: 10_000, allocations };
}
