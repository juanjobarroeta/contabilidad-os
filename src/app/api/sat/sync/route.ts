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

  // Request emitidos
  const emitidosResult = await service.query(
    QueryParameters.create()
      .withPeriod(period)
      .withDownloadType(new DownloadType("issued"))
      .withRequestType(new RequestType("xml"))
  );

  // Request recibidos (requires DocumentStatus.active for xml+received)
  const recibidosResult = await service.query(
    QueryParameters.create()
      .withPeriod(period)
      .withDownloadType(new DownloadType("received"))
      .withRequestType(new RequestType("xml"))
      .withDocumentStatus(new DocumentStatus("active"))
  );

  const errors: string[] = [];
  if (!emitidosResult.getStatus().isAccepted()) {
    errors.push(`Emitidos: ${emitidosResult.getStatus().getMessage()}`);
  }
  if (!recibidosResult.getStatus().isAccepted()) {
    errors.push(`Recibidos: ${recibidosResult.getStatus().getMessage()}`);
  }

  if (errors.length === 2) {
    return NextResponse.json({ error: errors.join(" | ") }, { status: 422 });
  }

  return NextResponse.json({
    emitidosRequestId: emitidosResult.getStatus().isAccepted()
      ? emitidosResult.getRequestId()
      : null,
    recibidosRequestId: recibidosResult.getStatus().isAccepted()
      ? recibidosResult.getRequestId()
      : null,
    month,
    year,
    warnings: errors.length > 0 ? errors : undefined,
  });
}
