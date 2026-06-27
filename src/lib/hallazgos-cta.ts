// Acción de arreglo ("¿cómo lo resuelvo?") por tipo de hallazgo. Convierte cada
// alerta del auditor en un botón que lleva directo a donde se arregla — p.ej.
// "Falta estado de cuenta" → Bancos para subirlo. Puro, sin React, testeable.

export interface HallazgoCta {
  label: string;
  href: string;
}

const MAP: Record<string, HallazgoCta> = {
  "banco.ingreso_no_facturado": { label: "Subir estado de cuenta", href: "/bancos" },
  "banco.movimientos_desactualizados": { label: "Subir estado de cuenta", href: "/bancos" },
  "iva.pue.sin_pago": { label: "Revisar conciliación", href: "/bancos" },
  "cfdi.rep.fecha_pago_anterior_factura": { label: "Revisar conciliación", href: "/bancos" },
  "declaraciones.faltantes": { label: "Ir a Declaraciones", href: "/declaraciones" },
  "obligacion.vencimiento.proximo": { label: "Ir a la declaración del mes", href: "/declaracion" },
  "resico.ingresos_limite": { label: "Ver impuestos", href: "/impuestos/detalle" },
  "csd.por_vencer": { label: "Actualizar credenciales", href: "/empresa" },
  "fiel.por_vencer": { label: "Actualizar credenciales", href: "/empresa" },
  "cumplimiento.sat_opinion.negativa": { label: "Ver opinión", href: "/opiniones" },
  "cfdi.posible_duplicado": { label: "Revisar facturas", href: "/facturas" },
  "cfdi.moneda_extranjera_sin_tc": { label: "Revisar facturas", href: "/facturas" },
  "deduccion.combustible.efectivo": { label: "Revisar facturas", href: "/facturas" },
  "deduccion.efectivo.limite": { label: "Revisar facturas", href: "/facturas" },
  "iva.casa_habitacion.trasladado": { label: "Revisar facturas", href: "/facturas" },
};

/** Acción de arreglo para un hallazgo, o null si no hay una ruta clara. */
export function ctaParaHallazgo(checkClave: string): HallazgoCta | null {
  if (MAP[checkClave]) return MAP[checkClave];
  // Respaldos por prefijo para claves futuras del mismo dominio.
  if (checkClave.startsWith("banco.")) return { label: "Subir estado de cuenta", href: "/bancos" };
  if (checkClave.startsWith("cfdi.rep")) return { label: "Revisar conciliación", href: "/bancos" };
  if (checkClave.startsWith("csd.") || checkClave.startsWith("fiel.")) return { label: "Actualizar credenciales", href: "/empresa" };
  if (checkClave.startsWith("cumplimiento.")) return { label: "Ver cumplimiento", href: "/cumplimiento" };
  if (checkClave.startsWith("declaracion") || checkClave.startsWith("obligacion")) {
    return { label: "Ir a Declaraciones", href: "/declaraciones" };
  }
  if (checkClave.startsWith("cfdi.") || checkClave.startsWith("deduccion.") || checkClave.startsWith("iva.")) {
    return { label: "Revisar facturas", href: "/facturas" };
  }
  return null;
}
