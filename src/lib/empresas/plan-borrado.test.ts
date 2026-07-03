import { describe, it, expect } from "vitest";
import {
  PLAN_BORRADO_EMPRESA,
  INVENTARIO_MODELOS_EMPRESA,
  RESTRICCIONES_DE_ORDEN,
  validarPlanBorrado,
} from "./plan-borrado";

// ⚠️ Si agregaste un modelo con companyId a prisma/schema.prisma y este test
// falla, la corrección va en src/lib/empresas/plan-borrado.ts (plan + inventario),
// NO aquí: la lista de abajo es el espejo hardcodeado del schema al momento de
// escribir la baja definitiva, para que cualquier divergencia sea visible en un
// solo lugar.

/**
 * Todos los modelos de prisma/schema.prisma que guardan datos de una empresa
 * (columna companyId, directa o denormalizada), derivados a mano del schema.
 */
const MODELOS_CON_COMPANY_ID_EN_SCHEMA = [
  // núcleo multi-tenant
  "CompanyMember",
  "DespachoMemberCompany",
  "CompanyInvitation",
  "CompanyModule",
  "CompanyRegimen",
  // CFDI / facturación
  "Customer",
  "Supplier",
  "Invoice",
  "ConstruccionCfdiVinculo", // companyId denormalizado; cascada vía Invoice
  "ActivoFijo",
  "IvaPeriodNotice",
  // bancos
  "BankAccount",
  "BankTransaction",
  // nómina
  "Employee",
  "Incidencia",
  "ImssMovimiento",
  "PayrollRun",
  // fiscal
  "TaxDeclaration",
  "PerdidaFiscal",
  "CoeEnvio",
  "CompanyObligation",
  "SatSyncRequest",
  // contabilidad electrónica
  "ChartAccount",
  "AccountingEntry",
  "AccountingPeriod",
  // construcción
  "Proyecto",
  "Concepto",
  "APU",
  "Insumo",
  "Presupuesto",
  "Estimacion",
  "EstimacionTemplate",
  "SolicitudCompra",
  "SolicitudAdjudicacion", // companyId denormalizado, sin FK a Company
  "Pago",
  "Cuadrilla",
  "RayaSemanal",
  "Gasto",
  "ReembolsoSemanal",
  // canales / asistente
  "WhatsappConversation",
  "ChatConversation",
  // standalone (companyId escalar sin relación)
  "FiscalHallazgo",
  "NotificationItem",
  "ComplianceSnapshot",
  "PushSubscription", // companyId opcional, se desvincula (updateMany → null)
  // padel
  "PadelClubConfig",
  "Court",
  "ClubMember",
  "Reservation",
  // opcionales conservados
  "CostEvent", // onDelete: SetNull — se conserva sin empresa (unit economics)
  // la empresa misma
  "Company",
] as const;

describe("PLAN_BORRADO_EMPRESA (baja definitiva LFPDPPP)", () => {
  it("es internamente coherente (validarPlanBorrado)", () => {
    expect(validarPlanBorrado()).toEqual([]);
  });

  it("cubre todos los modelos con companyId del schema (plan, cascada o conservado)", () => {
    const cubiertos = new Set<string>([
      ...PLAN_BORRADO_EMPRESA.map((p) => p.modelo),
      ...INVENTARIO_MODELOS_EMPRESA.cubiertosPorCascada,
      ...INVENTARIO_MODELOS_EMPRESA.conservados,
    ]);
    const faltantes = MODELOS_CON_COMPANY_ID_EN_SCHEMA.filter((m) => !cubiertos.has(m));
    expect(faltantes).toEqual([]);
  });

  it("no incluye pasos para modelos desconocidos (fuera del espejo del schema)", () => {
    const conocidos = new Set<string>([
      ...MODELOS_CON_COMPANY_ID_EN_SCHEMA,
      // hijos sin companyId que sólo caen por cascada
      ...INVENTARIO_MODELOS_EMPRESA.cubiertosPorCascada,
      // pasos sin companyId cuyo WHERE se expresa vía relación (viaRelacion)
      ...PLAN_BORRADO_EMPRESA.filter((p) => p.viaRelacion).map((p) => p.modelo),
    ]);
    const desconocidos = PLAN_BORRADO_EMPRESA.map((p) => p.modelo).filter(
      (m) => !conocidos.has(m)
    );
    expect(desconocidos).toEqual([]);
  });

  it("borra la fila Company al final y como único paso 'delete'", () => {
    const ultimo = PLAN_BORRADO_EMPRESA[PLAN_BORRADO_EMPRESA.length - 1];
    expect(ultimo.modelo).toBe("Company");
    expect(ultimo.accion).toBe("delete");
    expect(PLAN_BORRADO_EMPRESA.filter((p) => p.accion === "delete")).toHaveLength(1);
  });

  it("respeta todas las restricciones de orden (hijos RESTRICT antes que padres)", () => {
    const orden = PLAN_BORRADO_EMPRESA.map((p) => p.modelo);
    for (const [antes, despues] of RESTRICCIONES_DE_ORDEN) {
      const i = orden.indexOf(antes);
      const j = orden.indexOf(despues);
      expect(i, `${antes} no está en el plan`).toBeGreaterThanOrEqual(0);
      expect(j, `${despues} no está en el plan`).toBeGreaterThanOrEqual(0);
      expect(i, `${antes} debe ir antes que ${despues}`).toBeLessThan(j);
    }
  });

  it("PushSubscription se desvincula (updateMany), nunca se borra", () => {
    const paso = PLAN_BORRADO_EMPRESA.find((p) => p.modelo === "PushSubscription");
    expect(paso?.accion).toBe("updateMany");
  });

  it("no hay modelos duplicados en el plan", () => {
    const orden = PLAN_BORRADO_EMPRESA.map((p) => p.modelo);
    expect(new Set(orden).size).toBe(orden.length);
  });
});
