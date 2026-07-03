// ─────────────────────────────────────────────────────────────────────────────
// estadoDatos — responde "¿por qué está vacío mi tablero?" para el dashboard.
//
// Una empresa recién dada de alta aterriza en /dashboard con puros ceros
// mientras el backfill del SAT descarga sus CFDIs (puede tardar horas), o sin
// ningún camino de datos si omitió la e.firma. Este mapeo puro (sin Prisma)
// deriva el estado a partir de: conteo de facturas, presencia de FIEL y las
// solicitudes SatSyncRequest — para que la UI muestre la tarjeta correcta.
// ─────────────────────────────────────────────────────────────────────────────

/** Estatus de SatSyncRequest que significan "el SAT sigue trabajando". */
const STATUS_ACTIVOS = new Set(["PENDING", "ACCEPTED", "IN_PROGRESS"]);

export interface EstadoDatosRequest {
  /** SatRequestStatus: PENDING | ACCEPTED | IN_PROGRESS | FINISHED | FAILED | EXPIRED */
  status: string;
  year: number;
  month: number;
}

export interface EstadoDatosInput {
  invoiceCount: number;
  fielOk: boolean;
  requests: EstadoDatosRequest[];
  ultimaSincronizacion?: Date | string | null;
}

export interface EstadoDatos {
  tieneFacturas: boolean;
  fielConfigurada: boolean;
  /** Hay solicitudes al SAT pendientes o en curso y aún no llegan facturas. */
  sincronizando: boolean;
  /** El backfill ya terminó (o falló) y no se importó ningún CFDI. */
  sinResultados: boolean;
  periodosPendientes?: number;
  periodosTotales?: number;
  ultimaSincronizacion?: string;
}

/**
 * Mapea {invoiceCount, fielOk, requests[]} → estadoDatos.
 *
 * Un período (año-mes) cuenta como pendiente si tiene al menos una solicitud
 * activa (PENDING/ACCEPTED/IN_PROGRESS). Con facturas presentes, las banderas
 * de sincronización se apagan: el tablero ya tiene datos que mostrar.
 */
export function computeEstadoDatos(input: EstadoDatosInput): EstadoDatos {
  const tieneFacturas = input.invoiceCount > 0;
  const fielConfigurada = input.fielOk;

  // Períodos distintos (año-mes) solicitados, y cuáles siguen activos.
  const totales = new Set<string>();
  const pendientes = new Set<string>();
  for (const r of input.requests) {
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    totales.add(key);
    if (STATUS_ACTIVOS.has(r.status)) pendientes.add(key);
  }

  const sincronizando = !tieneFacturas && fielConfigurada && pendientes.size > 0;
  const sinResultados =
    !tieneFacturas && fielConfigurada && totales.size > 0 && pendientes.size === 0;

  const ultima = input.ultimaSincronizacion;
  return {
    tieneFacturas,
    fielConfigurada,
    sincronizando,
    sinResultados,
    ...(totales.size > 0
      ? { periodosPendientes: pendientes.size, periodosTotales: totales.size }
      : {}),
    ...(ultima
      ? {
          ultimaSincronizacion:
            typeof ultima === "string" ? ultima : ultima.toISOString(),
        }
      : {}),
  };
}
