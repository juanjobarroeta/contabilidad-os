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

// POST /api/sat/sync
// Body: { companyId, month, year }
// Submits TWO requests to SAT: emitidos + recibidos for the given month
// Returns: { emitidosRequestId, recibidosRequestId }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, month, year } = body;

  if (!companyId || !month || !year) {
    return NextResponse.json({ error: "companyId, month y year son requeridos" }, { status: 400 });
  }

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

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

  // Period: full month using the package's own DateTime (ISO string constructor)
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const startIso = `${year}-${pad(month)}-01T00:00:00`;
  const endIso   = `${year}-${pad(month)}-${pad(lastDay)}T23:59:59`;

  const period = DateTimePeriod.create(
    new DateTime(startIso),
    new DateTime(endIso)
  );

  // Request emitidos — wrap individually so one failure doesn't kill the other
  let emitidosRequestId: string | null = null;
  let recibidosRequestId: string | null = null;
  const warnings: string[] = [];

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
    } else {
      warnings.push(`Emitidos rechazado por SAT: ${emitidosResult.getStatus().getMessage()} (código ${emitidosResult.getStatus().getCode()})`);
    }
  } catch (e) {
    console.error("[sat/sync] emitidos error:", e);
    warnings.push(`Emitidos error: ${e instanceof Error ? e.message : String(e)}`);
  }

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
    } else {
      warnings.push(`Recibidos rechazado por SAT: ${recibidosResult.getStatus().getMessage()} (código ${recibidosResult.getStatus().getCode()})`);
    }
  } catch (e) {
    console.error("[sat/sync] recibidos error:", e);
    warnings.push(`Recibidos error: ${e instanceof Error ? e.message : String(e)}`);
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
    month,
    year,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}
