import { prisma } from "./prisma";
import { getFielForCompany, parseCfdiXml } from "./sat-fiel";
import {
  HttpsWebClient,
  FielRequestBuilder,
  Service,
  ServiceEndpoints,
  QueryParameters,
  DateTimePeriod,
  DateTime,
  DownloadType,
  RequestType,
  DocumentStatus,
  CfdiPackageReader,
  MetadataPackageReader,
} from "@nodecfdi/sat-ws-descarga-masiva";
import { interpretarCancelaciones, type SatMetadataRow } from "./sat-cancelaciones";
import { importarCfdiXml } from "./cfdi-import";
import { backfillNominaRegimen } from "./nomina/backfill-regimen";
import { importarNominaHistorica } from "./nomina/historia-import";
import { revertirDerivadosDeCancelada } from "./automotriz/revertir-cancelada";
import { etiquetaTramo, isoLocal, type Tramo } from "./sat-tramos";

// ─────────────────────────────────────────────────────────────────────────────
// Shared, session-free SAT Descarga Masiva logic.
//
// These functions contain the actual SAT request/verify/import work with NO
// dependency on an HTTP request or a logged-in user. They are called from:
//   1. The interactive HTTP routes (/api/sat/sync, /api/sat/sync/verify) which
//      handle auth + membership and then delegate here.
//   2. The background cron job (/api/cron/sat-sync) which iterates over all
//      eligible companies unattended.
//
// Keeping the logic here (instead of inside the route handlers) is what makes
// automatic, scheduled syncing possible without duplicating the SAT plumbing.
// ─────────────────────────────────────────────────────────────────────────────

// Reuse-window: how recent must an existing request be before we trust it
// instead of creating a new one. SAT keeps requests alive ~72h; we use 24h
// to be safe and to retry if something got stuck.
export const REUSE_WINDOW_HOURS = 24;
const REUSABLE_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS", "FINISHED"] as const;
type ReusableStatus = "PENDING" | "ACCEPTED" | "IN_PROGRESS" | "FINISHED";

// Timeout explícito del cliente HTTPS hacia el SAT. NO es cosmético: el
// HttpsWebClient de @nodecfdi tiene un bug en su manejador de timeout — si el
// cliente se construye SIN timeout explícito, un socket timeout rechaza con un
// Error plano (no WebClientException) y el ServiceConsumer de la propia
// librería truena con "webError.getResponse is not a function", matando el
// procesamiento de la empresa a media corrida (visto en producción cuando el
// SAT anda lento: sat-sync/backfill/cancel-sync fallando en TODAS las
// empresas). Con timeout explícito, el mismo evento viaja por la ruta buena
// (WebClientException → HttpTimeoutError) y queda como error legible que el
// cron reintenta en la siguiente pasada.
const SAT_HTTP_TIMEOUT_MS = 60_000;

function buildService(fiel: Awaited<ReturnType<typeof getFielForCompany>>): Service {
  return new Service(
    new FielRequestBuilder(fiel),
    new HttpsWebClient(undefined, undefined, SAT_HTTP_TIMEOUT_MS),
    undefined,
    ServiceEndpoints.cfdi()
  );
}

export function formatSatError(side: string, code: number, msg: string): string {
  // 5002 = "se han agotado las solicitudes de por vida": el SAT limita cuántas
  // veces se puede pedir EL MISMO parámetro (RFC + rango + tipo). NO es un
  // límite temporal — esperar no lo libera; hay que variar la consulta (otro
  // rango de fechas) o usar la vía por UUID (ConsultaCFDIService, cron
  // sat-vigencia-sync), que no consume esta cuota.
  if (code === 5002) {
    return `${side}: el SAT agotó las solicitudes DE POR VIDA para este período (código 5002). Esperar no lo libera: usa /api/cron/sat-vigencia-sync (consulta por UUID, sin cuota) o pide un rango de fechas distinto.`;
  }
  // 5004 = no hay CFDIs en el rango — not really an error
  if (code === 5004) {
    return `${side}: sin CFDIs en este período (código 5004)`;
  }
  return `${side} rechazado por SAT: ${msg} (código ${code})`;
}

// ── Submit ──────────────────────────────────────────────────────────────────

export type SubmitSatSyncResult =
  | {
      ok: true;
      emitidosRequestId: string | null;
      recibidosRequestId: string | null;
      reusedEmitidos: boolean;
      reusedRecibidos: boolean;
      month: number;
      year: number;
      warnings?: string[];
      message?: string;
    }
  | {
      ok: false;
      status: number; // suggested HTTP status for the route layer
      error: string;
      warnings?: string[];
    };

/**
 * Submit TWO requests to SAT (emitidos + recibidos) for the given period,
 * UNLESS we already have a recent pending/finished request for the same period
 * — in which case we reuse the SAT requestId so we don't waste quota.
 *
 * Pure of any auth concerns: callers must authorize access to `companyId` first.
 */
export async function submitSatSync(
  companyId: string,
  year: number,
  month: number,
  force = false,
  // Rango explícito, para pedir un TRAMO del mes en vez del mes completo. La
  // cuota 5002 se cuenta por (RFC + rango + tipo), así que un tramo es otra
  // llave: es la única salida por descarga masiva cuando el mes ya está quemado.
  // Las filas de bookkeeping siguen llevando (year, month) — más `desde`/`hasta`,
  // que es lo que distingue un tramo de otro.
  rango?: Tramo
): Promise<SubmitSatSyncResult> {
  // ── Reuse path ──────────────────────────────────────────────────────────
  // Check if we already have recent requests for this period that we can reuse.
  // This is the FIX for SAT error 5002 ("se han agotado las solicitudes de
  // por vida"): every click was creating new requests, hitting SAT's quota.
  //
  // Con `rango`, el reúso tiene que empatar el MISMO tramo: (year, month) ya no
  // identifica la solicitud, y reutilizar el tramo de al lado dejaría un hueco.
  const mismoRango = rango ? { desde: rango.desde, hasta: rango.hasta } : {};
  if (!force) {
    const cutoff = new Date(Date.now() - REUSE_WINDOW_HOURS * 60 * 60 * 1000);
    const [reEmitidos, reRecibidos] = await Promise.all([
      prisma.satSyncRequest.findFirst({
        where: {
          companyId,
          year,
          month,
          tipo: "EMITIDOS",
          ...mismoRango,
          status: { in: REUSABLE_STATUSES as unknown as ReusableStatus[] },
          createdAt: { gte: cutoff },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.satSyncRequest.findFirst({
        where: {
          companyId,
          year,
          month,
          tipo: "RECIBIDOS",
          ...mismoRango,
          status: { in: REUSABLE_STATUSES as unknown as ReusableStatus[] },
          createdAt: { gte: cutoff },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // If both are reusable, return them immediately — no SAT call needed
    if (reEmitidos && reRecibidos) {
      return {
        ok: true,
        emitidosRequestId: reEmitidos.requestId,
        recibidosRequestId: reRecibidos.requestId,
        reusedEmitidos: true,
        reusedRecibidos: true,
        month,
        year,
        message: "Reutilizando solicitudes existentes en SAT",
      };
    }
    // Fall through to query SAT for whatever side is missing.
  }

  // Load FIEL from company
  let fiel;
  try {
    fiel = await getFielForCompany(companyId);
  } catch (err) {
    return {
      ok: false,
      status: 422,
      error: err instanceof Error ? err.message : "Error cargando FIEL",
    };
  }

  const service = buildService(fiel);

  // Period: full month — but clamp end date to YESTERDAY if month is not complete.
  // SAT rejects requests with end dates that include today or the future (code 301).
  // Their system considers today's CFDIs as "en tránsito" and the range must end
  // at 23:59:59 of a day that has fully passed.
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");

  const requestedEnd = rango ? rango.hasta : new Date(year, month - 1, lastDay, 23, 59, 59);
  const now = new Date();
  // Yesterday at 23:59:59 in local time
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
  const effectiveEnd = requestedEnd > yesterday ? yesterday : requestedEnd;

  // Guard: if the effective end is before the month's start, there's no data to sync yet
  const monthStart = rango ? rango.desde : new Date(year, month - 1, 1);
  if (effectiveEnd < monthStart) {
    return {
      ok: false,
      status: 400,
      error: rango
        ? `El tramo ${etiquetaTramo(rango)} de ${month}/${year} aún no tiene días completos para consultar al SAT. Intenta mañana.`
        : `El mes ${month}/${year} aún no tiene días completos para consultar al SAT. Intenta mañana.`,
    };
  }

  // Lo que realmente se le pide al SAT, que es lo que se guarda: con tramo, el
  // tramo; sin tramo, el mes. `effectiveEnd` ya viene recortado a ayer.
  const periodDesde = monthStart;
  const periodHasta = effectiveEnd;

  const startIso = rango
    ? isoLocal(rango.desde)
    : `${year}-${pad(month)}-01T00:00:00`;
  const endIso =
    [effectiveEnd.getFullYear(), pad(effectiveEnd.getMonth() + 1), pad(effectiveEnd.getDate())].join(
      "-"
    ) +
    "T" +
    [pad(effectiveEnd.getHours()), pad(effectiveEnd.getMinutes()), pad(effectiveEnd.getSeconds())].join(
      ":"
    );

  console.log("[sat/sync] period:", startIso, "→", endIso);

  const period = DateTimePeriod.create(new DateTime(startIso), new DateTime(endIso));

  // Re-check what we already have (in case we fell through from the reuse path)
  const cutoff = new Date(Date.now() - REUSE_WINDOW_HOURS * 60 * 60 * 1000);
  const [existingEmitidos, existingRecibidos] = await Promise.all([
    prisma.satSyncRequest.findFirst({
      where: {
        companyId,
        year,
        month,
        tipo: "EMITIDOS",
        ...mismoRango,
        status: { in: REUSABLE_STATUSES as unknown as ReusableStatus[] },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.satSyncRequest.findFirst({
      where: {
        companyId,
        year,
        month,
        tipo: "RECIBIDOS",
        ...mismoRango,
        status: { in: REUSABLE_STATUSES as unknown as ReusableStatus[] },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  let emitidosRequestId: string | null = existingEmitidos?.requestId ?? null;
  let recibidosRequestId: string | null = existingRecibidos?.requestId ?? null;
  const reusedEmitidos = !!existingEmitidos;
  const reusedRecibidos = !!existingRecibidos;
  const warnings: string[] = [];

  // Request emitidos only if we don't have a reusable one
  if (!emitidosRequestId) {
    try {
      const emitidosResult = await service.query(
        QueryParameters.create()
          .withPeriod(period)
          .withDownloadType(new DownloadType("issued"))
          .withRequestType(new RequestType("xml"))
      );
      console.log(
        "[sat/sync] emitidos status:",
        emitidosResult.getStatus().getMessage(),
        "code:",
        emitidosResult.getStatus().getCode()
      );
      if (emitidosResult.getStatus().isAccepted()) {
        emitidosRequestId = emitidosResult.getRequestId();
        await prisma.satSyncRequest.create({
          data: {
            companyId, year, month, tipo: "EMITIDOS", requestId: emitidosRequestId,
            desde: periodDesde, hasta: periodHasta, status: "ACCEPTED",
          },
        });
      } else {
        const code = emitidosResult.getStatus().getCode();
        const msg = emitidosResult.getStatus().getMessage();
        warnings.push(formatSatError("emitidos", code, msg));
      }
    } catch (e) {
      console.error("[sat/sync] emitidos error:", e);
      warnings.push(`Emitidos error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!recibidosRequestId) {
    try {
      const recibidosResult = await service.query(
        QueryParameters.create()
          .withPeriod(period)
          .withDownloadType(new DownloadType("received"))
          .withRequestType(new RequestType("xml"))
          .withDocumentStatus(new DocumentStatus("active"))
      );
      console.log(
        "[sat/sync] recibidos status:",
        recibidosResult.getStatus().getMessage(),
        "code:",
        recibidosResult.getStatus().getCode()
      );
      if (recibidosResult.getStatus().isAccepted()) {
        recibidosRequestId = recibidosResult.getRequestId();
        await prisma.satSyncRequest.create({
          data: {
            companyId, year, month, tipo: "RECIBIDOS", requestId: recibidosRequestId,
            desde: periodDesde, hasta: periodHasta, status: "ACCEPTED",
          },
        });
      } else {
        const code = recibidosResult.getStatus().getCode();
        const msg = recibidosResult.getStatus().getMessage();
        warnings.push(formatSatError("recibidos", code, msg));
      }
    } catch (e) {
      console.error("[sat/sync] recibidos error:", e);
      warnings.push(`Recibidos error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Both failed — surface the actual SAT error messages
  if (!emitidosRequestId && !recibidosRequestId) {
    console.error("[sat/sync] BOTH requests rejected:", { companyId, year, month, warnings });
    return {
      ok: false,
      status: 422,
      error:
        warnings.length > 0 ? warnings.join(" | ") : "SAT rechazó ambas solicitudes sin mensaje de error",
      warnings,
    };
  }

  return {
    ok: true,
    emitidosRequestId,
    recibidosRequestId,
    reusedEmitidos,
    reusedRecibidos,
    month,
    year,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ── Verify + import ───────────────────────────────────────────────────────────

export type VerifySatSyncResult =
  | {
      ok: true;
      status: "pending" | "done" | "empty" | "partial";
      imported?: number;
      skipped?: number;
      message: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Poll the given SAT request IDs and, for any that SAT reports as Finished,
 * download the packages and import the CFDIs into the Invoice table
 * (deduping by UUID). Idempotent — safe to call repeatedly.
 *
 * Pure of any auth concerns: callers must authorize access to `companyId` first.
 */
export async function verifyAndImportSatSync(
  companyId: string,
  emitidosRequestId?: string | null,
  recibidosRequestId?: string | null
): Promise<VerifySatSyncResult> {
  if (!emitidosRequestId && !recibidosRequestId) {
    return { ok: false, status: 400, error: "Faltan parámetros" };
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });

  let fiel;
  try {
    fiel = await getFielForCompany(companyId);
  } catch (err) {
    return { ok: false, status: 422, error: err instanceof Error ? err.message : "Error cargando FIEL" };
  }

  const service = buildService(fiel);

  // Poll both request IDs and collect all pending/ready package IDs
  const pendingIds: string[] = [];
  const readyPackageIds: string[] = [];
  const typeMap = new Map<string, "emitidos" | "recibidos">(); // packageId → tipo

  const requestPairs: Array<{ id: string; tipo: "emitidos" | "recibidos" }> = [];
  if (emitidosRequestId) requestPairs.push({ id: emitidosRequestId, tipo: "emitidos" });
  if (recibidosRequestId) requestPairs.push({ id: recibidosRequestId, tipo: "recibidos" });

  let totalCfdis = 0;

  for (const { id, tipo } of requestPairs) {
    const verifyResult = await service.verify(id);

    if (!verifyResult.getStatus().isAccepted()) {
      await prisma.satSyncRequest.updateMany({
        where: { requestId: id },
        data: {
          status: "FAILED",
          errorMessage: verifyResult.getStatus().getMessage(),
          lastVerifiedAt: new Date(),
        },
      });
      continue;
    }

    const codeRequest = verifyResult.getCodeRequest().getValue();
    const statusRequest = verifyResult.getStatusRequest();
    const packageIds = verifyResult.getPackageIds();
    const numCfdis = verifyResult.getNumberCfdis();
    totalCfdis += numCfdis;

    console.log(
      `[sat/verify] ${tipo} codeRequest:${codeRequest} status:${statusRequest.getEntryId()} packages:${packageIds.length} cfdis:${numCfdis}`
    );

    // 5004 = no CFDIs found for this period/type
    if (codeRequest === 5004) {
      await prisma.satSyncRequest.updateMany({
        where: { requestId: id },
        data: { status: "FINISHED", cfdisFound: 0, lastVerifiedAt: new Date() },
      });
      continue;
    }

    // Only download when SAT says the request is Finished
    // StatusRequest: Accepted | InProgress | Finished | Failure | Rejected | Expired
    const isFinished = statusRequest.isTypeOf("Finished" as Parameters<typeof statusRequest.isTypeOf>[0]);

    if (!isFinished) {
      // Still processing — come back later
      pendingIds.push(id);
      await prisma.satSyncRequest.updateMany({
        where: { requestId: id },
        data: { status: "IN_PROGRESS", cfdisFound: numCfdis, lastVerifiedAt: new Date() },
      });
    } else {
      for (const pkgId of packageIds) {
        readyPackageIds.push(pkgId);
        typeMap.set(pkgId, tipo);
      }
      await prisma.satSyncRequest.updateMany({
        where: { requestId: id },
        data: { status: "FINISHED", cfdisFound: numCfdis, lastVerifiedAt: new Date() },
      });
    }
  }

  // If any are still pending, return pending
  if (pendingIds.length > 0 && readyPackageIds.length === 0) {
    return {
      ok: true,
      status: "pending",
      message: `SAT preparando paquetes... ${totalCfdis} CFDIs encontrados`,
    };
  }

  if (readyPackageIds.length === 0) {
    // Aunque no haya CFDIs nuevos, reconcilia el régimen de nómina ya guardada
    // (best-effort) — así un re-sync "vacío" no deja recibos sin reconocer.
    await backfillNominaRegimen(companyId, { timeBudgetMs: 30_000 }).catch((e) =>
      console.error("[sat-sync] backfillNominaRegimen (empty) falló:", e)
    );
    // Histórico de nómina: recibos timbrados de syncs anteriores que aún no
    // viven como PayrollRun (dedup por folio fiscal — idempotente).
    await importarNominaHistorica(companyId).catch((e) =>
      console.error("[sat-sync] importarNominaHistorica (empty) falló:", e)
    );
    return { ok: true, status: "empty", message: "No se encontraron CFDIs en este período" };
  }

  // Download and import all ready packages
  let imported = 0;
  let skipped = 0;
  // Periodos (year-month) que recibieron CFDIs nuevos — para auto-postear los
  // que aún estén en borrador al terminar la importación.
  const affectedPeriods = new Set<string>();

  for (const packageId of readyPackageIds) {
    const tipo = typeMap.get(packageId) ?? "recibidos";
    const downloadResult = await service.download(packageId);
    if (!downloadResult.getStatus().isAccepted()) continue;

    // getPackageContent() returns base64 — decode to binary string for createFromContents
    // (the library writes with { encoding: "binary" } so expects latin1, not base64)
    const base64Content = downloadResult.getPackageContent();
    const binaryContent = Buffer.from(base64Content, "base64").toString("binary");

    const reader = await CfdiPackageReader.createFromContents(binaryContent);

    for await (const cfdiMap of reader.cfdis()) {
      for (const [rawUuid, xmlContent] of cfdiMap) {
        // El cuerpo de esto vivía aquí, inline. Se movió a `importarCfdiXml`
        // SIN cambiarlo, para que los CFDIs que lleguen por Syntage —única vía
        // a 2017–2021, que la descarga masiva no alcanza— entren EXACTAMENTE
        // por el mismo camino: mismo mapeo de TipoDeComprobante, misma
        // contraparte, misma clasificación, mismo activo fijo, mismo vehículo,
        // mismos links de complemento de pago. Un segundo importador parecido
        // habría sido un segundo juego de reglas divergiendo en silencio.
        const r = await importarCfdiXml({
          companyId,
          rfcEmpresa: company?.rfc ?? null,
          tipo,
          rawUuid,
          xmlContent,
          origen: "SAT",
        });
        if (r.resultado === "importado") {
          imported++;
          if (r.periodoAfectado) affectedPeriods.add(r.periodoAfectado);
        } else {
          skipped++;
        }
      }
    }
  }

  // Reconocer régimen de nómina (asimilados, ISR retenido) en recibos ya
  // importados que aún no lo tienen — re-parsea su rawXml. Idempotente y
  // best-effort: así "Sincronizar CFDIs" deja todo reconocido sin pasos manuales.
  await backfillNominaRegimen(companyId, { timeBudgetMs: 30_000 }).catch((e) =>
    console.error("[sat-sync] backfillNominaRegimen falló:", e)
  );

  // Histórico de nómina: convierte los recibos timbrados recién importados en
  // corridas PayrollRun/PayrollItem de sólo lectura (origen "SAT"). Idempotente
  // por folio fiscal y best-effort: un fallo no bloquea el sync.
  await importarNominaHistorica(companyId).catch((e) =>
    console.error("[sat-sync] importarNominaHistorica falló:", e)
  );

  // Auto-cierre conservador: por cada periodo que recibió CFDIs nuevos, postea
  // el mes SÓLO si aún está en borrador y NO tiene asientos manuales. Nunca
  // toca meses ya cerrados ni destruye ajustes capturados a mano (lo garantiza
  // postMonthIfDraft). Best-effort: cualquier error se loguea y no bloquea el
  // resultado del sync.
  if (affectedPeriods.size > 0) {
    const { postMonthIfDraft } = await import("./contabilidad/posting");
    for (const key of affectedPeriods) {
      const [y, m] = key.split("-").map(Number);
      await postMonthIfDraft(companyId, y, m).catch((e) =>
        console.error(`[sat-sync] auto-cierre ${key} falló:`, e)
      );
    }
  }

  // Persist the imported counts back to the SatSyncRequest rows we updated
  if (emitidosRequestId) {
    await prisma.satSyncRequest
      .updateMany({ where: { requestId: emitidosRequestId }, data: { imported: { increment: imported } } })
      .catch(() => {});
  }

  // If some packages are still pending but we processed some, report partial
  if (pendingIds.length > 0) {
    return {
      ok: true,
      status: "partial",
      imported,
      skipped,
      message: `${imported} importados hasta ahora. Todavía hay paquetes pendientes, vuelve a verificar en un momento.`,
    };
  }

  return {
    ok: true,
    status: "done",
    imported,
    skipped,
    message: `✓ ${imported} CFDI(s) importados${skipped > 0 ? `, ${skipped} ya existían` : ""}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel-sync — detección de CFDIs cancelados en el SAT (descarga de METADATA).
//
// Mismo patrón submit→verify que el sync de XML, pero con RequestType
// "metadata": el paquete trae el estatus (vigente/cancelado) de cada CFDI del
// periodo. Para los UUIDs que tenemos como STAMPED y el SAT reporta cancelados,
// marcamos la factura CANCELLED — y el motor fiscal (que filtra status STAMPED)
// deja de contarlos. La decisión vive en sat-cancelaciones.ts (pura/testeable).
//
// ⚠️ La descarga/parseo de metadata requiere una corrida real contra el SAT
// para confirmar el formato del paquete antes de confiar ciegamente; el marcado
// es conservador (sólo STAMPED→CANCELLED de UUIDs que ya tenemos).
// ─────────────────────────────────────────────────────────────────────────────

/** Periodo de un mes, recortado a ayer (SAT rechaza rangos que incluyen hoy). */
function buildMonthPeriod(year: number, month: number): DateTimePeriod | null {
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const requestedEnd = new Date(year, month - 1, lastDay, 23, 59, 59);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
  const effectiveEnd = requestedEnd > yesterday ? yesterday : requestedEnd;
  if (effectiveEnd < new Date(year, month - 1, 1)) return null;
  const startIso = `${year}-${pad(month)}-01T00:00:00`;
  const endIso =
    [effectiveEnd.getFullYear(), pad(effectiveEnd.getMonth() + 1), pad(effectiveEnd.getDate())].join("-") +
    "T" +
    [pad(effectiveEnd.getHours()), pad(effectiveEnd.getMinutes()), pad(effectiveEnd.getSeconds())].join(":");
  return DateTimePeriod.create(new DateTime(startIso), new DateTime(endIso));
}

export interface CancelSyncResult {
  ok: boolean;
  status?: "pending" | "done" | "empty" | "error";
  cancelled?: number;
  checked?: number;
  /** Sólo en dryRun: los UUIDs que SE cancelarían (sin escribir). */
  wouldCancel?: { id: string; uuid: string }[];
  /**
   * Cuántas de las canceladas tenían efectos DERIVADOS vivos que se
   * deshicieron (unidades en piso, costos, kardex, órdenes, nómina). Marcar la
   * factura no basta: la capa de operación materializa filas y ningún filtro
   * por status deshace una fila escrita.
   */
  revertidas?: number;
  error?: string;
}

/**
 * Submit (or reuse) the two metadata requests for a period and, when SAT has a
 * package ready, download it and apply cancellations. Self-contained: persists
 * the metadata request IDs in SatSyncRequest (tipos METADATA_*) so a later cron
 * run picks up packages SAT finished asynchronously — same cadence as XML sync.
 *
 * `dryRun`: descarga y decide pero NO escribe — devuelve `wouldCancel` para
 * confirmar el formato del metadata contra una cancelación conocida antes de
 * confiar en el automático.
 */
export async function syncCancelacionesPeriodo(
  companyId: string,
  year: number,
  month: number,
  dryRun = false
): Promise<CancelSyncResult> {
  let fiel;
  try {
    fiel = await getFielForCompany(companyId);
  } catch (err) {
    return { ok: false, status: "error", error: err instanceof Error ? err.message : "Error FIEL" };
  }
  const service = buildService(fiel);
  const period = buildMonthPeriod(year, month);
  if (!period) return { ok: true, status: "empty" };

  const cutoff = new Date(Date.now() - REUSE_WINDOW_HOURS * 60 * 60 * 1000);
  const sides: Array<{ tipo: "METADATA_EMITIDOS" | "METADATA_RECIBIDOS"; download: "issued" | "received" }> = [
    { tipo: "METADATA_EMITIDOS", download: "issued" },
    { tipo: "METADATA_RECIBIDOS", download: "received" },
  ];

  // 1. Ensure a request per side (reuse within the 24h window, else submit).
  const requestIds: string[] = [];
  const rechazos: string[] = [];
  for (const side of sides) {
    const existing = await prisma.satSyncRequest.findFirst({
      where: {
        companyId, year, month, tipo: side.tipo,
        status: { in: REUSABLE_STATUSES as unknown as ReusableStatus[] },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      requestIds.push(existing.requestId);
      continue;
    }
    try {
      const res = await service.query(
        QueryParameters.create()
          .withPeriod(period)
          .withDownloadType(new DownloadType(side.download))
          .withRequestType(new RequestType("metadata"))
      );
      if (res.getStatus().isAccepted()) {
        const reqId = res.getRequestId();
        await prisma.satSyncRequest.create({
          data: { companyId, year, month, tipo: side.tipo, requestId: reqId, status: "ACCEPTED" },
        });
        requestIds.push(reqId);
      } else {
        // Rechazo del SAT (típicamente 5002, cuota vitalicia del período).
        rechazos.push(formatSatError(side.tipo, res.getStatus().getCode(), res.getStatus().getMessage()));
      }
    } catch (e) {
      console.error("[sat/cancel-sync] query error:", e);
      rechazos.push(`${side.tipo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // TODAS las solicitudes rechazadas: es un ERROR, no un "pendiente". Devolverlo
  // como ok:true hacía que el backlog histórico avanzara de período sin revisar
  // nada y reportara progreso falso (revisados: 0 con errors: []).
  if (requestIds.length === 0) {
    return rechazos.length > 0
      ? { ok: false, status: "error", error: rechazos.join(" · ") }
      : { ok: true, status: "pending" };
  }

  // 2. Verify each request; collect ready package IDs.
  const readyPackageIds: string[] = [];
  let anyPending = false;
  for (const id of requestIds) {
    try {
      const verify = await service.verify(id);
      if (!verify.getStatus().isAccepted()) {
        // Guardar el MOTIVO: sin esto una solicitud de metadata quedaba en
        // FAILED sin rastro de por qué (visto en producción: 23 fallos y cero
        // diagnóstico), a diferencia del camino de XML que sí lo persiste.
        await prisma.satSyncRequest.updateMany({
          where: { requestId: id },
          data: {
            status: "FAILED",
            errorMessage: `${verify.getStatus().getMessage()} (código ${verify.getStatus().getCode()})`,
            lastVerifiedAt: new Date(),
          },
        });
        continue;
      }
      const codeRequest = verify.getCodeRequest().getValue();
      if (codeRequest === 5004) {
        await prisma.satSyncRequest.updateMany({ where: { requestId: id }, data: { status: "FINISHED", cfdisFound: 0, lastVerifiedAt: new Date() } });
        continue;
      }
      const statusRequest = verify.getStatusRequest();
      const isFinished = statusRequest.isTypeOf("Finished" as Parameters<typeof statusRequest.isTypeOf>[0]);
      if (!isFinished) {
        anyPending = true;
        await prisma.satSyncRequest.updateMany({ where: { requestId: id }, data: { status: "IN_PROGRESS", lastVerifiedAt: new Date() } });
      } else {
        for (const pkg of verify.getPackageIds()) readyPackageIds.push(pkg);
        await prisma.satSyncRequest.updateMany({ where: { requestId: id }, data: { status: "FINISHED", lastVerifiedAt: new Date() } });
      }
    } catch (e) {
      console.error("[sat/cancel-sync] verify error:", e);
    }
  }
  if (readyPackageIds.length === 0) return { ok: true, status: anyPending ? "pending" : "empty" };

  // 3. Download metadata packages, parse rows.
  const rows: SatMetadataRow[] = [];
  for (const pkgId of readyPackageIds) {
    const dl = await service.download(pkgId);
    if (!dl.getStatus().isAccepted()) continue;
    const binary = Buffer.from(dl.getPackageContent(), "base64").toString("binary");
    const reader = await MetadataPackageReader.createFromContents(binary);
    for await (const item of reader.metadata()) {
      rows.push({
        uuid: item.get("uuid"),
        estatus: item.get("estatus"),
        fechaCancelacion: item.get("fechaCancelacion") || undefined,
      });
    }
  }
  if (rows.length === 0) return { ok: true, status: "done", cancelled: 0, checked: 0 };

  // 4. Apply: only STAMPED invoices we own that SAT reports cancelled.
  // Empate case-insensitive (upper(uuid)): facturas timbradas por el PAC pueden
  // estar guardadas en minúsculas, y un `uuid IN (mayúsculas)` las dejaría fuera
  // — el CFDI seguiría STAMPED pese a estar cancelado en el SAT.
  const uuids = rows.map((r) => r.uuid?.trim().toUpperCase()).filter(Boolean) as string[];
  const owned =
    uuids.length === 0
      ? []
      : await prisma.$queryRaw<{ id: string; uuid: string | null; status: string }[]>`
          SELECT id, uuid, status FROM "Invoice"
          WHERE "companyId" = ${companyId} AND upper(uuid) = ANY(${uuids})
        `;
  const { toCancel } = interpretarCancelaciones(
    rows,
    owned.map((o) => ({ id: o.id, uuid: o.uuid ?? "", status: o.status }))
  );
  if (dryRun) {
    return {
      ok: true,
      status: "done",
      cancelled: 0,
      checked: rows.length,
      wouldCancel: toCancel.map((t) => ({ id: t.id, uuid: t.uuid })),
    };
  }
  let revertidas = 0;
  if (toCancel.length > 0) {
    await prisma.invoice.updateMany({
      where: { id: { in: toCancel.map((t) => t.id) } },
      data: { status: "CANCELLED" },
    });
    // Marcar la factura no deshace lo que derivó. El motor fiscal filtra por
    // status al leer, pero la capa de operación materializa filas —unidades,
    // costos, kardex, órdenes, nómina— y ningún filtro borra una fila escrita.
    // Una por una y con try: la cancelación fiscal ya quedó aplicada, y una
    // reversión que falle no debe tirar el resto.
    for (const t of toCancel) {
      try {
        const rev = await revertirDerivadosDeCancelada(prisma, t.id);
        if (rev.huboCambios) revertidas++;
      } catch (e) {
        console.warn(
          `[sat-cancel-sync] ${companyId}: reversión de ${t.uuid} falló:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
  return { ok: true, status: "done", cancelled: toCancel.length, checked: rows.length, revertidas };
}
