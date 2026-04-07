import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFielForCompany } from "@/lib/sat-fiel";
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
} from "@nodecfdi/sat-ws-descarga-masiva";

// Reuse-window: how recent must an existing request be before we trust it
// instead of creating a new one. SAT keeps requests alive ~72h; we use 24h
// to be safe and to retry if something got stuck.
const REUSE_WINDOW_HOURS = 24;
const REUSABLE_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS", "FINISHED"] as const;

// POST /api/sat/sync
// Body: { companyId, month, year, force? }
// Submits TWO requests to SAT (emitidos + recibidos) UNLESS we already have
// a recent pending/finished request for the same period — in which case we
// reuse the SAT requestId so we don't waste quota.
// Returns: { emitidosRequestId, recibidosRequestId, reusedEmitidos, reusedRecibidos }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, month, year, force } = body;

  if (!companyId || !month || !year) {
    return NextResponse.json({ error: "companyId, month y year son requeridos" }, { status: 400 });
  }

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // ── Reuse path ──────────────────────────────────────────────────────────
  // Check if we already have recent requests for this period that we can reuse.
  // This is the FIX for SAT error 5002 ("se han agotado las solicitudes de
  // por vida"): every click was creating new requests, hitting SAT's quota.
  if (!force) {
    const cutoff = new Date(Date.now() - REUSE_WINDOW_HOURS * 60 * 60 * 1000);
    const [reEmitidos, reRecibidos] = await Promise.all([
      prisma.satSyncRequest.findFirst({
        where: {
          companyId,
          year,
          month,
          tipo: "EMITIDOS",
          status: { in: REUSABLE_STATUSES as unknown as ("PENDING" | "ACCEPTED" | "IN_PROGRESS" | "FINISHED")[] },
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
          status: { in: REUSABLE_STATUSES as unknown as ("PENDING" | "ACCEPTED" | "IN_PROGRESS" | "FINISHED")[] },
          createdAt: { gte: cutoff },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // If both are reusable, return them immediately — no SAT call needed
    if (reEmitidos && reRecibidos) {
      return NextResponse.json({
        emitidosRequestId: reEmitidos.requestId,
        recibidosRequestId: reRecibidos.requestId,
        reusedEmitidos: true,
        reusedRecibidos: true,
        month,
        year,
        message: "Reutilizando solicitudes existentes en SAT",
      });
    }
    // We'll skip the missing side(s) below in the SAT call section.
    // Fall through to query SAT for whatever side is missing.
  }

  // Load FIEL from company
  let fiel;
  try {
    fiel = await getFielForCompany(companyId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error cargando FIEL" },
      { status: 422 }
    );
  }

  // Build SAT service
  const service = new Service(
    new FielRequestBuilder(fiel),
    new HttpsWebClient(),
    undefined,
    ServiceEndpoints.cfdi()
  );

  // Period: full month — but clamp end date to right now if month is not yet complete
  // SAT rejects requests with end dates in the future (code 301)
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");

  const requestedEnd = new Date(year, month - 1, lastDay, 23, 59, 59);
  const now = new Date();
  const effectiveEnd = requestedEnd > now ? now : requestedEnd;

  const startIso = `${year}-${pad(month)}-01T00:00:00`;
  const endIso = [
    effectiveEnd.getFullYear(),
    pad(effectiveEnd.getMonth() + 1),
    pad(effectiveEnd.getDate()),
  ].join("-") + "T" + [
    pad(effectiveEnd.getHours()),
    pad(effectiveEnd.getMinutes()),
    pad(effectiveEnd.getSeconds()),
  ].join(":");

  console.log("[sat/sync] period:", startIso, "→", endIso);

  const period = DateTimePeriod.create(
    new DateTime(startIso),
    new DateTime(endIso)
  );

  // Re-check what we already have (in case we fell through from the reuse path)
  const cutoff = new Date(Date.now() - REUSE_WINDOW_HOURS * 60 * 60 * 1000);
  const [existingEmitidos, existingRecibidos] = await Promise.all([
    prisma.satSyncRequest.findFirst({
      where: {
        companyId, year, month, tipo: "EMITIDOS",
        status: { in: REUSABLE_STATUSES as unknown as ("PENDING" | "ACCEPTED" | "IN_PROGRESS" | "FINISHED")[] },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.satSyncRequest.findFirst({
      where: {
        companyId, year, month, tipo: "RECIBIDOS",
        status: { in: REUSABLE_STATUSES as unknown as ("PENDING" | "ACCEPTED" | "IN_PROGRESS" | "FINISHED")[] },
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
      console.log("[sat/sync] emitidos status:", emitidosResult.getStatus().getMessage(), "code:", emitidosResult.getStatus().getCode());
      if (emitidosResult.getStatus().isAccepted()) {
        emitidosRequestId = emitidosResult.getRequestId();
        await prisma.satSyncRequest.create({
          data: {
            companyId,
            year,
            month,
            tipo: "EMITIDOS",
            requestId: emitidosRequestId,
            status: "ACCEPTED",
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
      console.log("[sat/sync] recibidos status:", recibidosResult.getStatus().getMessage(), "code:", recibidosResult.getStatus().getCode());
      if (recibidosResult.getStatus().isAccepted()) {
        recibidosRequestId = recibidosResult.getRequestId();
        await prisma.satSyncRequest.create({
          data: {
            companyId,
            year,
            month,
            tipo: "RECIBIDOS",
            requestId: recibidosRequestId,
            status: "ACCEPTED",
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
    return NextResponse.json({
      error: warnings.length > 0
        ? warnings.join(" | ")
        : "SAT rechazó ambas solicitudes sin mensaje de error",
    }, { status: 422 });
  }

  return NextResponse.json({
    emitidosRequestId,
    recibidosRequestId,
    reusedEmitidos,
    reusedRecibidos,
    month,
    year,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

function formatSatError(side: string, code: number, msg: string): string {
  // 5002 = se agotaron las solicitudes de por vida (per-RFC quota hit)
  if (code === 5002) {
    return `${side}: SAT alcanzó su límite de solicitudes simultáneas (código 5002). Espera 1-3 horas y vuelve a intentar — las solicitudes pendientes se procesarán automáticamente.`;
  }
  // 5004 = no hay CFDIs en el rango — not really an error
  if (code === 5004) {
    return `${side}: sin CFDIs en este período (código 5004)`;
  }
  return `${side} rechazado por SAT: ${msg} (código ${code})`;
}
