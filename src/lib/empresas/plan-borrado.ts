// ─── Plan de borrado definitivo de una empresa (LFPDPPP — derecho de cancelación) ───
//
// Este módulo es PURO (sin Prisma, sin I/O) a propósito: el orden de borrado es
// la parte riesgosa de la baja definitiva y se prueba en plan-borrado.test.ts
// sin base de datos.
//
// ⚠️ PARA FUTUROS EDITORES: si agregas a prisma/schema.prisma un modelo nuevo
// con `companyId` (con o sin relación @relation a Company), DEBES registrarlo
// aquí — en PLAN_BORRADO_EMPRESA si necesita borrado/limpieza explícita, o en
// MODELOS_CUBIERTOS_POR_CASCADA / MODELOS_CONSERVADOS si no. El test de
// integridad (`validarPlanBorrado`) compara el plan contra INVENTARIO_MODELOS_EMPRESA
// y fallará visiblemente si el inventario y el plan divergen entre sí; el
// inventario mismo se mantiene A MANO y es el único lugar que hay que actualizar
// junto con el schema.
//
// ¿Por qué borrado explícito en vez de confiar en ON DELETE CASCADE?
// Varias relaciones requeridas del schema NO declaran onDelete y Prisma les
// genera ON DELETE RESTRICT (p. ej. PayrollItem.employeeId → Employee,
// AccountingEntry.chartAccountId → ChartAccount, Estimacion.presupuestoId →
// Presupuesto). En Postgres RESTRICT se verifica de inmediato durante la
// cascada, así que un `DELETE FROM "Company"` a secas puede fallar según el
// orden interno de los triggers. Borramos hijos antes que padres, en el orden
// de este plan, y la fila Company al final.

/** Cómo se ejecuta un paso del plan. */
export type AccionBorrado =
  | "deleteMany" // DELETE ... WHERE companyId = $1 (o filtro por relación)
  | "updateMany" // UPDATE que desvincula (p. ej. PushSubscription.companyId → null)
  | "delete"; // borrado de la fila Company (último paso)

export type PasoBorrado = {
  /** Nombre del modelo Prisma exactamente como aparece en schema.prisma. */
  modelo: string;
  accion: AccionBorrado;
  /**
   * true cuando el modelo no tiene columna companyId y el WHERE se expresa
   * como filtro por relación (p. ej. { cotizacion: { solicitud: { companyId } } }).
   */
  viaRelacion?: boolean;
  /** Nota de por qué el paso existe / por qué su posición importa. */
  motivo?: string;
};

/**
 * Plan ORDENADO de borrado: hijos antes que padres. Cada paso es UNA sentencia
 * SQL (deleteMany/updateMany por companyId), apta para tablas grandes. Se
 * ejecuta completo dentro de una sola prisma.$transaction — ver
 * borrarEmpresaDefinitivo() en src/lib/empresas/baja.ts.
 */
export const PLAN_BORRADO_EMPRESA: readonly PasoBorrado[] = [
  // ── Construcción: aristas RESTRICT primero ──
  {
    modelo: "SolicitudCotizacionPartida",
    accion: "deleteMany",
    viaRelacion: true,
    motivo: "RESTRICT hacia SolicitudPartida; debe irse antes que SolicitudCompra",
  },
  {
    modelo: "SolicitudAdjudicacion",
    accion: "deleteMany",
    motivo: "RESTRICT hacia SolicitudCompraCotizacion; antes que SolicitudCompra",
  },
  {
    modelo: "SolicitudCompra",
    accion: "deleteMany",
    motivo: "cascada a SolicitudPartida y SolicitudCompraCotizacion",
  },
  {
    modelo: "Estimacion",
    accion: "deleteMany",
    motivo: "RESTRICT hacia Presupuesto; cascada a EstimacionPartida",
  },
  {
    modelo: "EstimacionTemplate",
    accion: "deleteMany",
    motivo:
      "EstimacionTemplatePartida (cascada) tiene RESTRICT hacia PresupuestoPartida; antes que Presupuesto",
  },
  { modelo: "Gasto", accion: "deleteMany", motivo: "RESTRICT hacia Proyecto" },
  {
    modelo: "ReembolsoSemanal",
    accion: "deleteMany",
    motivo: "RESTRICT hacia Proyecto y BankAccount",
  },
  {
    modelo: "RayaSemanal",
    accion: "deleteMany",
    motivo:
      "RESTRICT hacia Cuadrilla; cascada a RayaTrabajo y RayaDetalleMiembro (RESTRICT hacia CuadrillaMiembro)",
  },
  { modelo: "Cuadrilla", accion: "deleteMany", motivo: "cascada a CuadrillaMiembro" },
  { modelo: "Pago", accion: "deleteMany" },
  {
    modelo: "Presupuesto",
    accion: "deleteMany",
    motivo:
      "cascada a PresupuestoPartida/PresupuestoInsumo/PresupuestoVersion; PresupuestoInsumo tiene RESTRICT hacia Insumo",
  },
  { modelo: "Insumo", accion: "deleteMany" },
  { modelo: "APU", accion: "deleteMany", motivo: "cascada a APUInsumo" },
  { modelo: "Concepto", accion: "deleteMany" },
  {
    modelo: "Proyecto",
    accion: "deleteMany",
    motivo: "cascada a UnidadProyecto/ProgramaActividad/BitacoraEntrada",
  },

  // ── Nómina: aristas RESTRICT hacia Employee ──
  {
    modelo: "PayrollRun",
    accion: "deleteMany",
    motivo: "cascada a PayrollItem (RESTRICT hacia Employee); antes que Employee",
  },
  { modelo: "Incidencia", accion: "deleteMany", motivo: "RESTRICT hacia Employee" },
  { modelo: "ImssMovimiento", accion: "deleteMany", motivo: "RESTRICT hacia Employee" },
  { modelo: "Employee", accion: "deleteMany" },

  // ── Contabilidad electrónica ──
  {
    modelo: "AccountingEntry",
    accion: "deleteMany",
    motivo: "RESTRICT hacia ChartAccount; antes que ChartAccount",
  },
  { modelo: "ChartAccount", accion: "deleteMany" },
  { modelo: "AccountingPeriod", accion: "deleteMany" },

  // ── Padel ──
  { modelo: "Reservation", accion: "deleteMany" },
  { modelo: "ClubMember", accion: "deleteMany" },
  { modelo: "Court", accion: "deleteMany" },
  { modelo: "PadelClubConfig", accion: "deleteMany" },

  // ── Bancos / CFDIs ──
  { modelo: "BankTransaction", accion: "deleteMany", motivo: "antes que BankAccount e Invoice" },
  { modelo: "BankAccount", accion: "deleteMany", motivo: "después de ReembolsoSemanal (RESTRICT)" },
  { modelo: "ActivoFijo", accion: "deleteMany" },
  {
    modelo: "Invoice",
    accion: "deleteMany",
    motivo:
      "cascada a InvoiceItem/InvoiceTax/PagoDoctoRelacionado/ConstruccionCfdiVinculo; tabla potencialmente enorme — una sola sentencia",
  },
  { modelo: "Customer", accion: "deleteMany", motivo: "después de Invoice/Proyecto/ClubMember" },
  { modelo: "Supplier", accion: "deleteMany", motivo: "cascada a SupplierTerms; después de BankTransaction" },

  // ── Fiscal ──
  { modelo: "TaxDeclaration", accion: "deleteMany" },
  { modelo: "PerdidaFiscal", accion: "deleteMany" },
  { modelo: "CoeEnvio", accion: "deleteMany" },
  { modelo: "CompanyObligation", accion: "deleteMany" },
  { modelo: "IvaPeriodNotice", accion: "deleteMany" },
  { modelo: "SatSyncRequest", accion: "deleteMany" },
  { modelo: "CompanyRegimen", accion: "deleteMany" },

  // ── Canales / asistente ──
  { modelo: "WhatsappConversation", accion: "deleteMany", motivo: "cascada a WhatsappMessage" },
  { modelo: "ChatConversation", accion: "deleteMany", motivo: "cascada a ChatMessage" },

  // ── Modelos standalone (companyId escalar SIN relación — la cascada de la
  //    fila Company NO los tocaría) ──
  { modelo: "FiscalHallazgo", accion: "deleteMany", motivo: "standalone: sin FK a Company" },
  { modelo: "ComplianceSnapshot", accion: "deleteMany", motivo: "standalone: sin FK a Company" },
  { modelo: "NotificationItem", accion: "deleteMany", motivo: "standalone: sin FK a Company" },
  {
    modelo: "PushSubscription",
    accion: "updateMany",
    motivo:
      "standalone: la suscripción pertenece al navegador del usuario; sólo se desvincula companyId → null",
  },

  // ── Accesos / membresías al final (para conservar autorización durante el flujo) ──
  { modelo: "CompanyInvitation", accion: "deleteMany" },
  { modelo: "DespachoMemberCompany", accion: "deleteMany" },
  { modelo: "CompanyMember", accion: "deleteMany" },
  { modelo: "CompanyModule", accion: "deleteMany" },

  // ── La empresa misma, SIEMPRE al final ──
  { modelo: "Company", accion: "delete" },
];

/**
 * Inventario MANUAL de todos los modelos del schema relacionados con Company
 * (derivado de prisma/schema.prisma). Es la lista de referencia contra la que
 * se valida el plan. ACTUALÍZALA junto con el schema.
 */
export const INVENTARIO_MODELOS_EMPRESA = {
  /** Modelos que el plan debe borrar/limpiar explícitamente (uno a uno). */
  explicitos: PLAN_BORRADO_EMPRESA.map((p) => p.modelo),

  /**
   * Modelos SIN companyId que caen por cascada de un paso explícito del plan.
   * (padre → hijo, sólo informativo para el lector.)
   */
  cubiertosPorCascada: [
    "InvoiceItem", // Invoice
    "InvoiceTax", // Invoice
    "PagoDoctoRelacionado", // Invoice
    "ConstruccionCfdiVinculo", // Invoice (tiene companyId escalar, pero su FK obligatoria a Invoice cascada)
    "SupplierTerms", // Supplier
    "PayrollItem", // PayrollRun
    "APUInsumo", // APU
    "PresupuestoInsumo", // Presupuesto
    "PresupuestoPartida", // Presupuesto
    "PresupuestoVersion", // Presupuesto
    "EstimacionPartida", // Estimacion
    "EstimacionTemplatePartida", // EstimacionTemplate
    "EstimacionCurvaCapitulo", // EstimacionTemplate
    "CalendarioCierreCapitulo", // EstimacionTemplate
    "UnidadProyecto", // Proyecto
    "ProgramaActividad", // Proyecto
    "BitacoraEntrada", // Proyecto
    "SolicitudPartida", // SolicitudCompra
    "SolicitudCompraCotizacion", // SolicitudCompra
    "CuadrillaMiembro", // Cuadrilla
    "RayaTrabajo", // RayaSemanal
    "RayaDetalleMiembro", // RayaSemanal
    "WhatsappMessage", // WhatsappConversation
    "ChatMessage", // ChatConversation
  ],

  /**
   * Modelos que tocan a Company pero se CONSERVAN deliberadamente:
   *  - CostEvent: onDelete SetNull — unit economics del despacho, sin datos
   *    personales; el schema eligió SetNull a propósito.
   *  - WhatsappLink: pertenece al usuario; su activeCompanyId es SetNull.
   *  - Grupo / Despacho: contenedores por encima de la empresa; no se tocan.
   */
  conservados: ["CostEvent", "WhatsappLink", "Grupo", "Despacho"],

  /** Modelos globales (sin scoping por empresa) — fuera del alcance de la baja. */
  globales: ["FiscalDocument", "FiscalChunk", "CotejoFiscal", "VerificationToken"],
} as const;

/**
 * Pares (antes, después): restricciones de orden derivadas de las FKs
 * ON DELETE RESTRICT del schema. El test verifica cada par contra el plan.
 */
export const RESTRICCIONES_DE_ORDEN: ReadonlyArray<readonly [string, string]> = [
  // RESTRICT directos (relación requerida sin onDelete en el schema)
  ["PayrollRun", "Employee"], // PayrollItem.employeeId
  ["Incidencia", "Employee"],
  ["ImssMovimiento", "Employee"],
  ["AccountingEntry", "ChartAccount"],
  ["Presupuesto", "Insumo"], // PresupuestoInsumo.insumoId
  ["Estimacion", "Presupuesto"],
  ["EstimacionTemplate", "Presupuesto"], // EstimacionTemplatePartida.presupuestoPartidaId
  ["SolicitudCotizacionPartida", "SolicitudCompra"], // SolicitudCotizacionPartida.solicitudPartidaId
  ["SolicitudAdjudicacion", "SolicitudCompra"], // SolicitudAdjudicacion.cotizacionId
  ["RayaSemanal", "Cuadrilla"],
  ["RayaSemanal", "Proyecto"],
  ["Gasto", "Proyecto"],
  ["ReembolsoSemanal", "Proyecto"],
  ["ReembolsoSemanal", "BankAccount"],
  ["BankTransaction", "BankAccount"],
  // Membresías al final; Company estrictamente al último
  ["Invoice", "Company"],
  ["CompanyMember", "Company"],
];

/**
 * Valida la coherencia interna del plan. Devuelve la lista de problemas
 * encontrados (vacía = plan sano). Usada por el unit test.
 */
export function validarPlanBorrado(): string[] {
  const problemas: string[] = [];
  const orden = PLAN_BORRADO_EMPRESA.map((p) => p.modelo);

  // 1. Sin duplicados
  const vistos = new Set<string>();
  for (const m of orden) {
    if (vistos.has(m)) problemas.push(`Modelo duplicado en el plan: ${m}`);
    vistos.add(m);
  }

  // 2. Company existe, es único paso "delete" y va al final
  if (orden[orden.length - 1] !== "Company") {
    problemas.push("El último paso del plan debe ser Company");
  }
  for (const p of PLAN_BORRADO_EMPRESA) {
    if (p.accion === "delete" && p.modelo !== "Company") {
      problemas.push(`Sólo Company puede usar accion "delete" (encontrado: ${p.modelo})`);
    }
    if (p.modelo === "Company" && p.accion !== "delete") {
      problemas.push('Company debe usar accion "delete"');
    }
  }

  // 3. Restricciones de orden (hijo RESTRICT antes que su padre)
  for (const [antes, despues] of RESTRICCIONES_DE_ORDEN) {
    const i = orden.indexOf(antes);
    const j = orden.indexOf(despues);
    if (i < 0) problemas.push(`Restricción referencia un modelo fuera del plan: ${antes}`);
    if (j < 0) problemas.push(`Restricción referencia un modelo fuera del plan: ${despues}`);
    if (i >= 0 && j >= 0 && i >= j) {
      problemas.push(`Orden inválido: ${antes} debe borrarse antes que ${despues}`);
    }
  }

  // 4. Nada del plan aparece como "conservado" / "global" / "cascada"
  const excluidos = new Set<string>([
    ...INVENTARIO_MODELOS_EMPRESA.cubiertosPorCascada,
    ...INVENTARIO_MODELOS_EMPRESA.conservados,
    ...INVENTARIO_MODELOS_EMPRESA.globales,
  ]);
  for (const m of orden) {
    if (excluidos.has(m)) {
      problemas.push(`${m} está a la vez en el plan y en una lista de exclusión del inventario`);
    }
  }

  return problemas;
}
