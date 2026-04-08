import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFielForCompany, parseCfdiXml } from "@/lib/sat-fiel";
import {
  HttpsWebClient,
  FielRequestBuilder,
  Service,
  ServiceEndpoints,
  CfdiPackageReader,
} from "@nodecfdi/sat-ws-descarga-masiva";

// POST /api/sat/sync/verify
// Body: { companyId, emitidosRequestId?, recibidosRequestId?, month, year }
// Returns: { status: "pending"|"done"|"empty"|"error", imported?, message? }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, emitidosRequestId, recibidosRequestId } = body;

  if (!companyId || (!emitidosRequestId && !recibidosRequestId)) {
    return NextResponse.json({ error: "Faltan parámetros" }, { status: 400 });
  }

  // Verify membership
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });

  let fiel;
  try {
    fiel = await getFielForCompany(companyId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error cargando FIEL" },
      { status: 422 }
    );
  }

  const service = new Service(
    new FielRequestBuilder(fiel),
    new HttpsWebClient(),
    undefined,
    ServiceEndpoints.cfdi()
  );

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
    const dbTipo = tipo === "emitidos" ? "EMITIDOS" : "RECIBIDOS";

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

    console.log(`[sat/verify] ${tipo} codeRequest:${codeRequest} status:${statusRequest.getEntryId()} packages:${packageIds.length} cfdis:${numCfdis}`);

    // 5004 = no CFDIs found for this period/type
    if (codeRequest === 5004) {
      await prisma.satSyncRequest.updateMany({
        where: { requestId: id },
        data: { status: "FINISHED", cfdisFound: 0, lastVerifiedAt: new Date() },
      });
      continue;
    }
    void dbTipo;

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
    return NextResponse.json({
      status: "pending",
      message: `SAT preparando paquetes... ${totalCfdis} CFDIs encontrados`,
    });
  }

  if (readyPackageIds.length === 0) {
    return NextResponse.json({ status: "empty", message: "No se encontraron CFDIs en este período" });
  }

  // Download and import all ready packages
  let imported = 0;
  let skipped = 0;

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
      for (const [uuid, xmlContent] of cfdiMap) {
        // Skip if already in DB
        const existing = await prisma.invoice.findFirst({ where: { uuid } });
        if (existing) { skipped++; continue; }

        const cfdi = parseCfdiXml(xmlContent);
        if (!cfdi.uuid || !cfdi.fecha) { skipped++; continue; }

        // Map SAT TipoDeComprobante (I/E/N/P/T) to our InvoiceType enum.
        // If for some reason it's missing, fall back to direction-based guess.
        const isEmisor = tipo === "emitidos" || cfdi.rfcEmisor === company?.rfc;
        const SAT_TIPO_MAP: Record<string, "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO"> = {
          I: "INGRESO",
          E: "EGRESO",
          N: "NOMINA",
          P: "PAGO",
          T: "TRASLADO",
        };
        const mappedType = cfdi.tipo ? SAT_TIPO_MAP[cfdi.tipo] : undefined;
        const invoiceType: "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO" =
          mappedType ?? (isEmisor ? "INGRESO" : "EGRESO");

        // Find or create counterparty customer record
        const counterpartyRfc  = isEmisor ? cfdi.rfcReceptor  : cfdi.rfcEmisor;
        const counterpartyName = isEmisor ? cfdi.nombreReceptor : cfdi.nombreEmisor;

        let customerId: string | null = null;
        if (
          counterpartyRfc &&
          counterpartyRfc !== "XAXX010101000" &&
          counterpartyRfc !== "XEXX010101000"
        ) {
          const existingCustomer = await prisma.customer.findFirst({
            where: { companyId, rfc: counterpartyRfc },
          });
          if (existingCustomer) {
            customerId = existingCustomer.id;
          } else if (counterpartyName) {
            try {
              const newCustomer = await prisma.customer.create({
                data: {
                  companyId,
                  rfc: counterpartyRfc,
                  razonSocial: counterpartyName,
                  regimenFiscal: isEmisor ? "616" : (cfdi.regimenEmisor ?? "616"),
                },
              });
              customerId = newCustomer.id;
            } catch { /* ignore duplicate RFC */ }
          }
        }

        await prisma.invoice.create({
          data: {
            companyId,
            customerId,
            tipo: invoiceType,
            fecha: new Date(cfdi.fecha),
            serie: cfdi.serie ?? null,
            folio: cfdi.folio ?? null,
            formaPago: cfdi.formaPago ?? "99",
            metodoPago: cfdi.metodoPago ?? "PUE",
            usoCfdi: cfdi.usoCfdi ?? "G03",
            moneda: cfdi.moneda ?? "MXN",
            subtotal: cfdi.subtotal,
            total: cfdi.total,
            totalImpuestos: cfdi.ivaTotal,
            status: "STAMPED",
            uuid,
            notas: `SAT — ${tipo}`,
            items: cfdi.items && cfdi.items.length > 0 ? {
              create: cfdi.items.map((it) => ({
                cantidad: it.cantidad,
                claveUnidad: it.claveUnidad,
                unidad: it.unidad,
                claveProdServ: it.claveProdServ,
                descripcion: it.descripcion,
                valorUnitario: it.valorUnitario,
                importe: it.importe,
                descuento: it.descuento,
              })),
            } : undefined,
          },
        });
        imported++;
      }
    }
  }

  // Persist the imported counts back to the SatSyncRequest rows we updated
  if (emitidosRequestId) {
    await prisma.satSyncRequest.updateMany({
      where: { requestId: emitidosRequestId },
      data: { imported: { increment: imported } },
    }).catch(() => {});
  }

  // If some packages are still pending but we processed some, report partial
  if (pendingIds.length > 0) {
    return NextResponse.json({
      status: "partial",
      imported,
      skipped,
      message: `${imported} importados hasta ahora. Todavía hay paquetes pendientes, vuelve a verificar en un momento.`,
    });
  }

  return NextResponse.json({
    status: "done",
    imported,
    skipped,
    message: `✓ ${imported} CFDI(s) importados${skipped > 0 ? `, ${skipped} ya existían` : ""}`,
  });
}
