import { motivoTimbradoNoDisponible } from "@/lib/nomina/timbrado-candado";
import { prisma } from "@/lib/prisma";
import { signDraftToken } from "@/lib/facturas/file-token";
import { documentRefSchema, documentTitles, type DocumentRef, type DocumentView } from "./contract";

export async function readDocument(input: DocumentRef): Promise<DocumentView> {
  const ref = documentRefSchema.parse(input);
  const company = await prisma.company.findUnique({ where: { id: ref.companyId }, select: { id: true, razonSocial: true, rfc: true } });
  if (!company) throw new Error("Empresa no encontrada.");
  const base: DocumentView = { ref, company, title: documentTitles[ref.kind], status: "Consulta", source: "ContabilidadOS", currency: "MXN", updatedAt: new Date().toISOString(), downloads: [], stampable: false };
  const query = new URLSearchParams({ companyId: ref.companyId, year: String(ref.year), month: String(ref.month) });
  if (["balanza", "polizas", "catalogo", "iva", "isr", "retenciones"].includes(ref.kind)) {
    if (ref.year && ref.month) base.period = `${ref.year}-${String(ref.month).padStart(2, "0")}`;
    base.source = ref.kind === "balanza" ? "Balanza calculada en la app; no equivale a la presentada al SAT" : "Registros y motor de ContabilidadOS";
    base.status = "Ver estado y evidencia en el documento";
    if (["iva", "isr", "retenciones"].includes(ref.kind))
      base.downloads.push({ label: "Descargar CSV", href: `/api/papeles/${ref.kind}?${query}&format=csv` });
    return base;
  }
  if (ref.kind === "prefactura") {
    const row = await prisma.facturaBorrador.findFirst({ where: { id: ref.id, companyId: ref.companyId }, include: { customer: { select: { companyId: true, razonSocial: true, rfc: true } } } });
    if (!row || row.customer.companyId !== ref.companyId) throw new Error("Prefactura no encontrada en esta empresa.");
    if (row.status === "TIMBRADA" && row.invoiceId) return readDocument({ kind: "factura", companyId: ref.companyId, id: row.invoiceId });
    const pdf = `/api/facturas/draft/${encodeURIComponent(row.draftId)}/pdf?companyId=${encodeURIComponent(ref.companyId)}&token=${encodeURIComponent(signDraftToken(ref.companyId, row.draftId))}`;
    return { ...base, source: "Borrador de facturación · total estimado en MXN", title: row.status === "TIMBRADA" ? "Prefactura timbrada" : "Prefactura — sin timbrar", status: row.status, recipient: `${row.customer.razonSocial} (${row.customer.rfc})`, total: Number(row.total),
      updatedAt: row.updatedAt.toISOString(), draftPayload: row.payload as Record<string, unknown>, invoiceId: row.invoiceId ?? undefined,
      ...(row.status === "PENDIENTE" ? { previewUrl: pdf, downloads: [{ label: "PDF borrador", href: pdf }], stampable: true } : {}),
    };
  }
  if (ref.kind === "nomina") {
    const row = await prisma.payrollRun.findFirst({ where: { id: ref.id, companyId: ref.companyId }, include: { items: { take: 501, orderBy: { id: "asc" }, include: { employee: { select: { companyId: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true } } } } } });
    if (!row) throw new Error("Nómina no encontrada en esta empresa.");
    if (row.items.length > 500 || row.items.some((i) => i.employee.companyId !== ref.companyId)) throw new Error("No se pudo cargar la nómina completa con sus empleados. No se mostrará un lote parcial.");
    return { ...base, title: `Nómina ${row.tipo.toLowerCase()}`, period: row.periodo, paymentDate: row.fechaPago.toISOString().slice(0, 10), status: motivoTimbradoNoDisponible(row) && row.status === "CALCULATED" ? "REVISAR TIMBRADO" : row.status, total: Number(row.totalNeto), updatedAt: row.updatedAt.toISOString(),
      source: row.origen === "SAT" ? "CFDI importados del SAT" : "Motor de nómina de ContabilidadOS", stampable: row.origen === "APP" && !motivoTimbradoNoDisponible(row) && ["ORDINARIA", "AGUINALDO", "PTU"].includes(row.tipo) && row.items.some((i) => !i.cfdiUuid),
      downloads: [{ label: "Excel", href: `/api/nomina/run/${row.id}/xlsx` }, ...(row.items.some((i) => i.cfdiUuid) ? [{ label: "Recibos ZIP", href: `/api/nomina/run/${row.id}/recibos-zip` }] : [])],
      receipts: row.items.map((i) => ({ id: i.id, employee: [i.employee.nombre, i.employee.apellidoPaterno, i.employee.apellidoMaterno].filter(Boolean).join(" "), rfc: i.employee.rfc, perceptions: Number(i.totalPercepciones), deductions: Number(i.totalDeducciones), net: Number(i.netoAPagar), uuid: i.cfdiUuid })),
    };
  }
  if (ref.kind === "recibo_nomina") {
    const item = await prisma.payrollItem.findFirst({ where: { id: ref.id, payrollRun: { companyId: ref.companyId }, employee: { companyId: ref.companyId } }, include: { payrollRun: true, employee: { select: { nombre: true, apellidoPaterno: true, rfc: true } } } });
    if (!item) throw new Error("Recibo no encontrado en esta empresa.");
    if (item.cfdiUuid) {
      const invoice = await prisma.invoice.findFirst({ where: { companyId: ref.companyId, tipo: "NOMINA", uuid: { equals: item.cfdiUuid, mode: "insensitive" } }, select: { id: true } });
      if (invoice) return { ...(await readDocument({ kind: "factura", companyId: ref.companyId, id: invoice.id })), ref, title: "Recibo de nómina", period: item.payrollRun.periodo };
      return { ...base, status: "Timbrado; archivo no disponible", uuid: item.cfdiUuid, period: item.payrollRun.periodo, total: Number(item.netoAPagar) };
    }
    return { ...base, status: "BORRADOR — sin timbrar", recipient: `${item.employee.nombre} ${item.employee.apellidoPaterno} (${item.employee.rfc})`, period: item.payrollRun.periodo, total: Number(item.netoAPagar), previewUrl: `/api/nomina/recibos/preview?companyId=${encodeURIComponent(ref.companyId)}&payrollItemId=${encodeURIComponent(item.id)}` };
  }
  const row = await prisma.invoice.findFirst({ where: { id: ref.id, companyId: ref.companyId }, select: { id: true, uuid: true, tipo: true, status: true, fecha: true, updatedAt: true, total: true, moneda: true, rawXml: true, facturapiId: true, contraparteNombre: true, contraparteRfc: true, customer: { select: { razonSocial: true, rfc: true } } } });
  if (!row) throw new Error("CFDI no encontrado en esta empresa.");
  return { ...base, title: row.tipo === "NOMINA" ? "CFDI de nómina" : "CFDI", status: row.status, uuid: row.uuid, total: Number(row.total), currency: row.moneda, period: row.fecha.toISOString().slice(0, 10), updatedAt: row.updatedAt.toISOString(), invoiceId: row.id,
    recipient: row.customer ? `${row.customer.razonSocial} (${row.customer.rfc})` : row.contraparteNombre ? `${row.contraparteNombre} (${row.contraparteRfc ?? ""})` : undefined,
    source: row.rawXml ? "XML del CFDI" : "Registro del CFDI; verifica disponibilidad de archivos",
    downloads: [...(row.rawXml || row.facturapiId ? [{ label: "XML", href: `/api/facturas/${row.id}/download?format=xml` }] : []), ...(row.facturapiId ? [{ label: "PDF", href: `/api/facturas/${row.id}/download?format=pdf` }] : [])],
  };
}
