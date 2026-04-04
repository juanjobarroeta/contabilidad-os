import { Fiel } from "@nodecfdi/sat-ws-descarga-masiva";
import { prisma } from "./prisma";

export async function getFielForCompany(companyId: string): Promise<Fiel> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { fielCer: true, fielKey: true, fielPassword: true, rfc: true },
  });

  if (!company?.fielCer || !company?.fielKey || !company?.fielPassword) {
    throw new Error(
      "FIEL (e.firma) no configurada. Sube los archivos .cer y .key en el onboarding de tu empresa."
    );
  }

  const cerBuffer = Buffer.from(company.fielCer, "base64");
  const keyBuffer = Buffer.from(company.fielKey, "base64");

  const fiel = Fiel.create(
    cerBuffer.toString("binary"),
    keyBuffer.toString("binary"),
    company.fielPassword
  );

  if (!fiel.isValid()) {
    throw new Error(
      `FIEL inválida o expirada para RFC ${company.rfc}. Verifica que los archivos .cer y .key sean correctos y que la contraseña sea la correcta.`
    );
  }

  return fiel;
}

/** Parse key fields from a CFDI XML string */
export function parseCfdiXml(xml: string) {
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(xml)?.[1] ?? null;
  const attrIn = (tag: string, name: string) => {
    const tagMatch = new RegExp(`<[^>]*:${tag}[^>]+>`).exec(xml);
    if (!tagMatch) return null;
    return new RegExp(`\\b${name}="([^"]+)"`).exec(tagMatch[0])?.[1] ?? null;
  };

  // UUID from TimbreFiscalDigital
  const uuid = attr("UUID");
  const fecha = attr("Fecha");
  const tipo = attr("TipoDeComprobante"); // I, E, T, N, P
  const subtotal = parseFloat(attr("SubTotal") ?? "0");
  const total = parseFloat(attr("Total") ?? "0");
  const formaPago = attr("FormaPago") ?? "99";
  const metodoPago = attr("MetodoPago") ?? "PUE";
  const usoCfdi = attrIn("Receptor", "UsoCFDI") ?? "G03";
  const moneda = attr("Moneda") ?? "MXN";

  // IVA trasladado total
  const ivaMatch = /TotalImpuestosTrasladados="([^"]+)"/.exec(xml);
  const ivaTotal = ivaMatch ? parseFloat(ivaMatch[1]) : total - subtotal;

  // Emisor
  const rfcEmisor = attrIn("Emisor", "Rfc");
  const nombreEmisor = attrIn("Emisor", "Nombre");
  const regimenEmisor = attrIn("Emisor", "RegimenFiscal");

  // Receptor
  const rfcReceptor = attrIn("Receptor", "Rfc");
  const nombreReceptor = attrIn("Receptor", "Nombre");

  return {
    uuid,
    fecha,
    tipo,
    subtotal,
    total,
    ivaTotal,
    formaPago,
    metodoPago,
    usoCfdi,
    moneda,
    rfcEmisor,
    nombreEmisor,
    regimenEmisor,
    rfcReceptor,
    nombreReceptor,
  };
}
