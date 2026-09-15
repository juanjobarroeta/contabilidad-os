import type {
  PpdRegimenReadinessApiResponse,
  PpdRegimenReadinessPendingItem,
} from "@/lib/fiscal/regimen-payment-allocation";

export function shouldShowPpdRegimenReadiness(
  data: PpdRegimenReadinessApiResponse | null,
): data is PpdRegimenReadinessApiResponse & { estado: "PENDIENTE" } {
  return data?.estado === "PENDIENTE";
}

export function ppdPaymentReference(item: PpdRegimenReadinessPendingItem): string {
  const folio = [item.pago.serie, item.pago.folio].filter(Boolean).join("-");
  if (folio) return `REP ${folio}`;
  if (item.pago.uuid) return `REP ${item.pago.uuid.slice(-8)}`;
  return "REP sin folio";
}

export function ppdReadinessSummaryParts(
  summary: PpdRegimenReadinessApiResponse["resumen"],
): string[] {
  return [
    summary.sinFacturaPadre > 0 ? `${summary.sinFacturaPadre} con problema en el CFDI padre` : "",
    summary.sinAsignacion > 0 ? `${summary.sinAsignacion} sin asignación` : "",
    summary.transicionesRegimen > 0 ? `${summary.transicionesRegimen} por cambio de régimen` : "",
    summary.monedaExtranjera > 0 ? `${summary.monedaExtranjera} en moneda extranjera` : "",
    summary.sinImporte > 0 ? `${summary.sinImporte} sin importe válido` : "",
    summary.historialPagoIncompleto > 0 ? `${summary.historialPagoIncompleto} con historial de pagos incompleto` : "",
    summary.sobrepagoAcumulado > 0 ? `${summary.sobrepagoAcumulado} con pagos que exceden el total` : "",
    summary.otros > 0 ? `${summary.otros} para revisión` : "",
  ].filter(Boolean);
}
