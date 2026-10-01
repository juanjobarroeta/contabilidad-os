// Synthetic source-comparison fixtures, not professionally approved tax cases.
export const repFixture = {
  companyRfc: "PAGO260101ABC", supplierRfc: "AAA010101AAA",
  parentUuid: "AAAAAAAA-1111-4111-8111-111111111111", repUuid: "BBBBBBBB-2222-4222-8222-222222222222",
  date: "2026-09-10T12:00:00", paid: "58.000000", before: "116", after: "58",
};
export function repXml(patch: Partial<typeof repFixture> & { method?: string; currency?: string; documentCurrency?: string;
  installment?: string; equivalence?: string; extraDocto?: string; extraPago?: string; note?: string } = {}) {
  const p = { ...repFixture, method: "03", currency: "MXN", documentCurrency: "MXN", installment: "1", equivalence: "1", ...patch };
  return `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:p="http://www.sat.gob.mx/Pagos20" xmlns:t="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" TipoDeComprobante="P">
    <cfdi:Emisor Rfc="${p.supplierRfc}"/><cfdi:Receptor Rfc="${p.companyRfc}"/>
    <cfdi:Complemento><p:Pagos Version="2.0"><p:Totales MontoTotalPagos="${p.paid}"/>
      <p:Pago FechaPago="${p.date}" FormaDePagoP="${p.method}" MonedaP="${p.currency}" Monto="${p.paid}">
        <p:DoctoRelacionado IdDocumento="${p.parentUuid}" MonedaDR="${p.documentCurrency}" EquivalenciaDR="${p.equivalence}" NumParcialidad="${p.installment}" ImpPagado="${p.paid}" ImpSaldoAnt="${p.before}" ImpSaldoInsoluto="${p.after}" ObjetoImpDR="01"/>${p.extraDocto ?? ""}
      </p:Pago>${p.extraPago ?? ""}</p:Pagos><t:TimbreFiscalDigital UUID="${p.repUuid}"/></cfdi:Complemento>${p.note ?? ""}
  </cfdi:Comprobante>`;
}
