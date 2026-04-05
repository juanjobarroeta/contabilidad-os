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
    if (!verifyResult.getStatus().isAccepted()) continue;

    const codeRequest = verifyResult.getCodeRequest().getValue();
    const packageIds = verifyResult.getPackageIds();
    totalCfdis += verifyResult.getNumberCfdis();

    if (codeRequest === 5004) continue; // no CFDIs for this type in period

    if (packageIds.length === 0) {
      pendingIds.push(id);
    } else {
      for (const pkgId of packageIds) {
        readyPackageIds.push(pkgId);
        typeMap.set(pkgId, tipo);
      }
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

    const reader = await CfdiPackageReader.createFromContents(
      downloadResult.getPackageContent()
    );

    for await (const cfdiMap of reader.cfdis()) {
      for (const [uuid, xmlContent] of cfdiMap) {
        // Skip if already in DB
        const existing = await prisma.invoice.findFirst({ where: { uuid } });
        if (existing) { skipped++; continue; }

        const cfdi = parseCfdiXml(xmlContent);
        if (!cfdi.uuid || !cfdi.fecha) { skipped++; continue; }

        // From our company's perspective:
        // emitidos → we are the emisor → tipo INGRESO
        // recibidos → we are the receptor → it's our expense → tipo EGRESO
        const isEmisor = tipo === "emitidos" || cfdi.rfcEmisor === company?.rfc;
        const invoiceType = isEmisor ? "INGRESO" : "EGRESO";

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
            notas: `SAT — ${tipo}`,
          },
        });
        imported++;
      }
    }
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
