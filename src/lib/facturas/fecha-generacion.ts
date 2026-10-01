import { DateTime } from "luxon";

/** RMF 2.7.2.9-I: generation -> certification, never payment -> issuance.
 * Requires the actual timestamp with its zone; never invents 23:59 or a date
 * to force a tax period. PAC acceptance does not establish RCFF 39 timeliness.
 */
export function resolverFechaGeneracion(
  fecha: string,
  ahora = new Date(),
): { fechaCfdi?: Date; error?: string } {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      fecha,
    )
  ) {
    return {
      error:
        "Indica la fecha y hora real de generación con el huso horario del lugar de expedición.",
    };
  }
  const value = DateTime.fromISO(fecha, { setZone: true });
  if (!value.isValid) return { error: "Fecha de generación inválida." };
  const diff = ahora.getTime() - value.toMillis();
  if (diff < 0) return { error: "La fecha de generación no puede ser futura." };
  if (diff > 72 * 60 * 60 * 1000)
    return {
      error:
        "La generación está fuera de las 72 horas para certificar (RMF 2.7.2.9). La fecha de cobro se documenta aparte para determinar el IVA.",
    };
  return { fechaCfdi: value.toJSDate() };
}
