// ─────────────────────────────────────────────────────────────────────────────
// Siembra del catálogo de proveedores desde los CFDIs RECIBIDOS.
//
// Todo emisor de un EGRESO vive como fila de Customer (así importa el sync del
// SAT); aquí se da de alta como Supplier si su RFC aún no existe. Idempotente:
// repetirlo sólo agrega los nuevos. Se excluyen el RFC propio y los genéricos.
//
// Vive como lib (no en la ruta) porque se dispara desde dos lados: el botón
// «Importar de mis CFDIs» y la siembra perezosa del GET — la promesa del
// empty-state («todo el que te haya facturado se da de alta solo») era mentira
// mientras dependía de un clic.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";

export interface SeedProveedoresResult {
  creados: number;
  omitidos: number;
  emisoresDetectados: number;
}

export async function sembrarProveedoresDesdeCfdis(companyId: string): Promise<SeedProveedoresResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });

  const emisores = await prisma.customer.findMany({
    where: {
      companyId,
      invoices: { some: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" } } },
    },
    select: {
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      email: true,
    },
  });

  const EXCLUIR = new Set(
    [company?.rfc?.toUpperCase(), "XAXX010101000", "XEXX010101000"].filter(Boolean) as string[],
  );

  const existentes = await prisma.supplier.findMany({
    where: { companyId },
    select: { rfc: true },
  });
  const yaExiste = new Set(existentes.map((s) => s.rfc.toUpperCase()));

  let creados = 0;
  let omitidos = 0;
  for (const e of emisores) {
    const rfc = e.rfc.toUpperCase().trim();
    if (!rfc || EXCLUIR.has(rfc) || yaExiste.has(rfc)) {
      omitidos++;
      continue;
    }
    await prisma.supplier.create({
      data: {
        companyId,
        rfc,
        razonSocial: e.razonSocial,
        regimenFiscal: e.regimenFiscal || null,
        email: e.email || null,
      },
    });
    yaExiste.add(rfc);
    creados++;
  }

  return { creados, omitidos, emisoresDetectados: emisores.length };
}
