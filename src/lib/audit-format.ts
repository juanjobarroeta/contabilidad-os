// Formateo de la bitácora de seguridad para la UI. Módulo PURO (sin prisma)
// para poder importarse desde componentes cliente.

/** Etiquetas en español para las acciones registradas en la bitácora. */
export const ACCION_LABELS: Record<string, string> = {
  "factura.timbrar": "CFDI timbrado",
  "factura.cancelar": "CFDI cancelado",
  "nomina.timbrar": "Nómina timbrada",
  "nomina.dispersion-export": "Dispersión exportada",
  "credenciales.actualizar": "Credenciales actualizadas",
  "miembros.agregar": "Miembro agregado",
  "miembros.cambiar-rol": "Rol de miembro cambiado",
  "miembros.eliminar": "Miembro eliminado",
  "invitacion.crear": "Invitación creada",
  "invitacion.revocar": "Invitación revocada",
  "invitacion.aceptar": "Invitación aceptada",
  "ai.confirmar": "Acción del asistente confirmada",
  "empresa.baja": "Empresa dada de baja",
  "cuenta.baja": "Cuenta eliminada",
  "conciliacion.match": "Movimiento conciliado",
  "conciliacion.unmatch": "Conciliación deshecha",
};

/** Etiqueta legible de una acción; la acción cruda si no está mapeada. */
export function etiquetaAccion(accion: string): string {
  return ACCION_LABELS[accion] ?? accion;
}

/**
 * Resumen corto de una fila `detalle` (Json) para listados: "uuid: X · total:
 * 1,234.00 · motivo: 02". Ignora null/undefined y objetos anidados (muestra su
 * JSON compacto truncado). Devuelve "" si no hay nada que mostrar.
 */
export function resumenDetalle(detalle: unknown, maxLen = 140): string {
  if (detalle == null || typeof detalle !== "object" || Array.isArray(detalle)) {
    return "";
  }
  const partes: string[] = [];
  for (const [clave, valor] of Object.entries(detalle as Record<string, unknown>)) {
    if (valor == null || valor === "") continue;
    let texto: string;
    if (typeof valor === "number") {
      texto = valor.toLocaleString("es-MX");
    } else if (typeof valor === "boolean") {
      texto = valor ? "sí" : "no";
    } else if (typeof valor === "string") {
      texto = valor;
    } else {
      try {
        texto = JSON.stringify(valor);
      } catch {
        continue;
      }
    }
    partes.push(`${clave}: ${texto}`);
  }
  const resumen = partes.join(" · ");
  return resumen.length > maxLen ? `${resumen.slice(0, maxLen - 1)}…` : resumen;
}
