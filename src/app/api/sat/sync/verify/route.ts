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
// Body: { companyId, satRequestId, tipo, month, year }
// Returns: { status: "pending"|"done"|"empty"|"error", imported?, message? }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, satRequestId, tipo, month, year } = body;

  if (!companyId || !satRequestId) {
    return NextResponse.json({ error: "companyId y satRequestId son requeridos" }, { status: 400 });
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

  // Verify request status with SAT
  const verifyResult = await service.verify(satRequestId);

  if (!verifyResult.getStatus().isAccepted()) {
    return NextResponse.json({
      status: "error",
      message: verifyResult.getStatus().getMessage(),
    });
  }

  const codeRequest = verifyResult.getCodeRequest().getValue();
  const statusRequest = verifyResult.getStatusRequest().getEntryId();
  const packageIds = verifyResult.getPackageIds();
  const cfdiCount = verifyResult.getNumberCfdis();

  // 5004 = no CFDIs found in period
  if (codeRequest === 5004) {
    return NextResponse.json({ status: "empty", message: "No se encontraron CFDIs en este período" });
  }

  // Still processing
  if (packageIds.length === 0) {
    return NextResponse.json({
      status: "pending",
      message: `${statusRequest} — ${cfdiCount} CFDIs encontrados, preparando paquetes...`,
    });
  }

  // Packages are ready — download and import
  let imported = 0;
  let skipped = 0;

  for (const packageId of packageIds) {
    const downloadResult = await service.download(packageId);

    if (!downloadResult.getStatus().isAccepted()) {
      continue;
    }

    const reader = await CfdiPackageReader.createFromContents(
      downloadResult.getPackageContent()
    );

    for await (const cfdiMap of reader.cfdis()) {
      for (const [uuid, xmlContent] of cfdiMap) {
        // Skip if already in DB
        const existing = await prisma.invoice.findFirst({
          where: { uuid },
        });
        if (existing) { skipped++; continue; }

        // Parse CFDI XML
        const cfdi = parseCfdiXml(xmlContent);
        if (!cfdi.uuid || !cfdi.fecha) { skipped++; continue; }

        // Determine direction relative to our company
        const isEmisor = cfdi.rfcEmisor === company?.rfc;
        // tipo: I=ingreso, E=egreso, T=traslado, N=nomina, P=pago
        const invoiceType = isEmisor
          ? (cfdi.tipo === "I" ? "INGRESO" : cfdi.tipo === "E" ? "EGRESO" : "INGRESO")
          : "EGRESO"; // received from supplier → it's our expense

        // Find or create customer/supplier record
        const counterpartyRfc = isEmisor ? cfdi.rfcReceptor : cfdi.rfcEmisor;
        const counterpartyName = isEmisor ? cfdi.nombreReceptor : cfdi.nombreEmisor;

        let customerId: string | null = null;
        if (counterpartyRfc && counterpartyRfc !== "XAXX010101000" && counterpartyRfc !== "XEXX010101000") {
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
            } catch {
              // Ignore duplicate RFC errors
            }
          }
        }

        // Save invoice
        await prisma.invoice.create({
          data: {
            companyId,
            customerId,
            tipo: invoiceType as "INGRESO" | "EGRESO",
            fecha: new Date(cfdi.fecha),
            formaPago: cfdi.formaPago ?? "99",
            metodoPago: cfdi.metodoPago ?? "PUE",
            usoCfdi: cfdi.usoCfdi ?? "G03",
            moneda: cfdi.moneda ?? "MXN",
            subtotal: cfdi.subtotal,
            total: cfdi.total,
            totalImpuestos: cfdi.ivaTotal,
            status: "STAMPED",
            uuid,
            notas: `Importado del SAT — ${isEmisor ? "emitido" : "recibido"}`,
          },
        });

        imported++;
      }
    }
  }

  return NextResponse.json({
    status: "done",
    imported,
    skipped,
    message: `${imported} CFDI(s) importados, ${skipped} omitidos (ya existían)`,
  });
}
