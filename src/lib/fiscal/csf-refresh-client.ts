export interface CsfRegimenOption {
  codigo: string;
  nombre: string;
  desde: string;
}

export type CsfRefreshOutcome =
  | { kind: "SUCCESS"; message: string }
  | { kind: "PRIMARY_REQUIRED"; message: string; regimenes: CsfRegimenOption[] }
  | { kind: "ERROR"; message: string; code?: string };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function regimenOptions(value: unknown): CsfRegimenOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: CsfRegimenOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const codigo = stringField(raw.codigo);
    if (!/^\d{3}$/.test(codigo) || seen.has(codigo)) continue;
    seen.add(codigo);
    options.push({
      codigo,
      nombre: stringField(raw.nombre, codigo),
      desde: stringField(raw.desde),
    });
  }
  return options;
}

export function interpretCsfRefreshResponse(
  response: { ok: boolean; status: number },
  payload: unknown,
): CsfRefreshOutcome {
  const body = isRecord(payload) ? payload : {};
  const message = stringField(body.error, "No se pudo procesar la constancia");
  const code = stringField(body.code);

  if (response.ok) {
    return {
      kind: "SUCCESS",
      message: stringField(body.message, "Constancia procesada."),
    };
  }

  if (response.status === 422 && code === "PRIMARY_REQUIRED") {
    const regimenes = regimenOptions(body.regimenes);
    if (regimenes.length > 1) {
      return { kind: "PRIMARY_REQUIRED", message, regimenes };
    }
  }

  return { kind: "ERROR", message, ...(code ? { code } : {}) };
}

export async function refreshCompanyFromCsf(input: {
  companyId: string;
  csfBase64: string;
  regimenFiscalPrincipal?: string;
}): Promise<CsfRefreshOutcome> {
  const response = await fetch("/api/obligaciones/csf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  return interpretCsfRefreshResponse(response, payload);
}
