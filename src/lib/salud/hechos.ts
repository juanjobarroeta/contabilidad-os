import { prisma } from "@/lib/prisma";
import { declaracionesFaltantesEmpresa } from "@/lib/fiscal/cobertura-declaraciones";
import { solicitudesAbiertas } from "@/lib/solicitudes/registro";
import type { HechosSalud } from "./evaluar";

// ─────────────────────────────────────────────────────────────────────────────
// LOS HECHOS DE UNA EMPRESA, LEÍDOS DE LA BASE.
//
// La contraparte impura de `evaluar.ts`: aquí viven las consultas y allá el
// juicio. La separación no es estética — es la que permite probar el juicio con
// objetos escritos a mano, sin base de datos, que es como están escritas las
// pruebas de este repo (`avance.ts` puro / `pase-diario.ts` con Prisma).
//
// Todo lo que se lee aquí ya lo calculaba alguna pantalla por su cuenta. La
// diferencia es que ahora se lee TODO junto, una vez al día, y se guarda: sin
// eso no hay contra qué comparar y «¿qué cambió desde ayer?» sigue sin respuesta.
// ─────────────────────────────────────────────────────────────────────────────

/** Ventana para contar solicitudes de descarga fallidas. Más atrás es historia. */
export const DIAS_SOLICITUDES = 30;

/** A partir de cuántos días un movimiento sin conciliar deja de ser "reciente". */
export const DIAS_MOVIMIENTO_VIEJO = 60;

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Arma los hechos de UNA empresa.
 *
 * Las consultas van en paralelo porque son independientes entre sí: en serie,
 * ocho viajes por empresa × la cartera es lo que convierte una pasada diaria en
 * un trabajo de media hora.
 */
export async function cargarHechosSalud(companyId: string, hoy: Date): Promise<HechosSalud> {
  const desdeSolicitudes = new Date(hoy.getTime() - DIAS_SOLICITUDES * DIA_MS);
  const corteMovimientos = new Date(hoy.getTime() - DIAS_MOVIMIENTO_VIEJO * DIA_MS);

  const [
    empresa,
    solicitudesFallidas,
    opinion,
    faltantes,
    movimientos,
    sinConciliar,
    sinConciliarViejos,
    hallazgos,
    pedidos,
  ] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        autoSyncEnabled: true,
        lastAutoSyncAt: true,
        satBackfillCompletedAt: true,
        fielCer: true,
        fielVigencia: true,
        csdVigencia: true,
        ceSatSyncEn: true,
        ceSatSyncOk: true,
      },
    }),
    prisma.satSyncRequest.count({
      where: {
        companyId,
        status: { in: ["FAILED", "EXPIRED"] },
        createdAt: { gte: desdeSolicitudes },
      },
    }),
    prisma.complianceSnapshot.findFirst({
      where: { companyId, tipo: "SAT_OPINION" },
      orderBy: { fetchedAt: "desc" },
      select: { resultado: true, fetchedAt: true, motivos: true },
    }),
    // Es la MISMA función que alimenta el banner de acuses faltantes: si aquí se
    // recalculara con otro criterio, la salud y la pantalla se contradirían.
    declaracionesFaltantesEmpresa(companyId).catch(() => []),
    prisma.bankTransaction.count({ where: { companyId } }),
    prisma.bankTransaction.count({ where: { companyId, status: "UNMATCHED" } }),
    prisma.bankTransaction.count({
      where: { companyId, status: "UNMATCHED", fecha: { lt: corteMovimientos } },
    }),
    prisma.fiscalHallazgo.groupBy({
      by: ["severidad"],
      where: { companyId, estado: "ABIERTO" },
      _count: { _all: true },
    }),
    solicitudesAbiertas(companyId),
  ]);

  const porSeveridad = (s: string) =>
    hallazgos.find((h) => h.severidad === s)?._count._all ?? 0;

  return {
    companyId,

    autoSyncEnabled: empresa?.autoSyncEnabled ?? false,
    lastAutoSyncAt: empresa?.lastAutoSyncAt ?? null,
    satBackfillCompletedAt: empresa?.satBackfillCompletedAt ?? null,
    solicitudesFallidas,

    // La e.firma se guarda cifrada y en tres columnas; para la salud basta saber
    // que el certificado está cargado. NUNCA se descifra nada aquí.
    tieneFiel: Boolean(empresa?.fielCer),
    fielVigencia: empresa?.fielVigencia ?? null,
    csdVigencia: empresa?.csdVigencia ?? null,

    opinionResultado: opinion?.resultado ?? null,
    opinionFetchedAt: opinion?.fetchedAt ?? null,
    opinionMotivos: opinion?.motivos.length ?? 0,

    declaracionesFaltantes: faltantes.length,
    declaracionesCriticas: faltantes.filter((f) => f.critico).length,

    ceSatSyncEn: empresa?.ceSatSyncEn ?? null,
    ceSatSyncOk: empresa?.ceSatSyncOk ?? null,

    // "Concilia" no es una casilla de configuración: es si hay movimientos
    // cargados. Una empresa sin banco importado no está mal conciliada, está
    // fuera del juicio — y decirle "todo conciliado" sería mentira.
    concilia: movimientos > 0,
    movimientosSinConciliar: sinConciliar,
    movimientosSinConciliarViejos: sinConciliarViejos,

    hallazgosError: porSeveridad("error"),
    hallazgosWarn: porSeveridad("warn"),

    // `solicitudesAbiertas` devuelve de la más vieja a la más nueva, así que la
    // primera ES la más vieja: ordenarla otra vez sería trabajo de más.
    solicitudesAbiertas: pedidos.length,
    diasSolicitudMasVieja:
      pedidos.length > 0 ? Math.floor((hoy.getTime() - pedidos[0].createdAt.getTime()) / DIA_MS) : null,
  };
}
