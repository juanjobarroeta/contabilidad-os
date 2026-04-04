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
  DownloadType,
  RequestType,
  DocumentStatus,
} from "@nodecfdi/sat-ws-descarga-masiva";
import { DateTime } from "luxon";

// POST /api/sat/sync
// Body: { companyId, month, year, tipo: "emitidos" | "recibidos" }
// Returns: { satRequestId } — client then polls /api/sat/sync/verify
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, month, year, tipo = "recibidos" } = body;

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

  // Period: full month
  const start = DateTime.utc(year, month, 1, 0, 0, 0);
  const lastDay = new Date(year, month, 0).getDate();
  const end = DateTime.utc(year, month, lastDay, 23, 59, 59);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const period = DateTimePeriod.create(start as any, end as any);

  const downloadType = new DownloadType(tipo === "emitidos" ? "issued" : "received");

  // Build query params — DocumentStatus active required for received+xml
  let queryParams = QueryParameters.create()
    .withPeriod(period)
    .withDownloadType(downloadType)
    .withRequestType(new RequestType("xml"));

  if (tipo === "recibidos") {
    queryParams = queryParams.withDocumentStatus(new DocumentStatus("active"));
  }

  const queryResult = await service.query(queryParams);

  if (!queryResult.getStatus().isAccepted()) {
    return NextResponse.json(
      { error: `SAT rechazó la solicitud: ${queryResult.getStatus().getMessage()}` },
      { status: 422 }
    );
  }

  const satRequestId = queryResult.getRequestId();

  return NextResponse.json({ satRequestId, tipo, month, year });
}
