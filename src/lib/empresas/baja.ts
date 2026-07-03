// ─── Baja definitiva de una empresa (LFPDPPP — derecho de cancelación) ───────
//
// Dos fases, deliberadamente separadas:
//
//   Fase 1 — borrarCredencialesEmpresa(): sobrescribe a NULL las credenciales
//   (FIEL .cer/.key/contraseña, CSD, llave de Facturapi, llave de Playtomic) y
//   desactiva la empresa. Se ejecuta ANTES que cualquier otra cosa, de forma
//   que los secretos mueren aunque un paso posterior falle.
//
//   Fase 2 — borrarEmpresaDefinitivo(): una sola prisma.$transaction que
//   ejecuta PLAN_BORRADO_EMPRESA en orden (hijos antes que padres) y borra la
//   fila Company al final. Todo-o-nada: si un paso falla, la transacción se
//   revierte completa y la empresa queda desactivada y sin credenciales
//   (resultado de la fase 1), lista para reintentar la baja.
//
// El orden del plan vive en src/lib/empresas/plan-borrado.ts (módulo puro,
// probado en plan-borrado.test.ts). Aquí sólo se mapea cada paso a su
// sentencia Prisma.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { PLAN_BORRADO_EMPRESA } from "./plan-borrado";

type Tx = Prisma.TransactionClient;

/**
 * Fase 1 — mata los secretos de inmediato (escritura independiente de la
 * transacción de borrado). Idempotente.
 */
export async function borrarCredencialesEmpresa(companyId: string): Promise<void> {
  await prisma.company.update({
    where: { id: companyId },
    data: {
      // CSD (llave privada de timbrado)
      csdCer: null,
      csdKey: null,
      csdPassword: null,
      csdVigencia: null,
      // e.firma / FIEL (llave privada ante el SAT)
      fielCer: null,
      fielKey: null,
      fielPassword: null,
      fielVigencia: null,
      // Facturapi
      facturapiApiKey: null,
      facturapiOrgId: null,
      // La empresa deja de ser operable aunque la fase 2 falle y se reintente.
      isActive: false,
      autoSyncEnabled: false,
    },
  });
  // Credencial de Playtomic (módulo PADEL), cifrada en PadelClubConfig.
  await prisma.padelClubConfig.updateMany({
    where: { companyId },
    data: { playtomicApiKey: null, playtomicTenantId: null, playtomicEnabled: false },
  });
}

/**
 * Una sentencia por paso del plan. Cada entrada DEBE filtrar por companyId
 * (directo o vía relación) — nunca borrar sin scope de empresa.
 */
const OPERACIONES: Record<string, (tx: Tx, companyId: string) => Promise<unknown>> = {
  SolicitudCotizacionPartida: (tx, companyId) =>
    tx.solicitudCotizacionPartida.deleteMany({
      where: { cotizacion: { solicitud: { companyId } } },
    }),
  SolicitudAdjudicacion: (tx, companyId) =>
    tx.solicitudAdjudicacion.deleteMany({ where: { companyId } }),
  SolicitudCompra: (tx, companyId) => tx.solicitudCompra.deleteMany({ where: { companyId } }),
  Estimacion: (tx, companyId) => tx.estimacion.deleteMany({ where: { companyId } }),
  EstimacionTemplate: (tx, companyId) =>
    tx.estimacionTemplate.deleteMany({ where: { companyId } }),
  Gasto: (tx, companyId) => tx.gasto.deleteMany({ where: { companyId } }),
  ReembolsoSemanal: (tx, companyId) => tx.reembolsoSemanal.deleteMany({ where: { companyId } }),
  RayaSemanal: (tx, companyId) => tx.rayaSemanal.deleteMany({ where: { companyId } }),
  Cuadrilla: (tx, companyId) => tx.cuadrilla.deleteMany({ where: { companyId } }),
  Pago: (tx, companyId) => tx.pago.deleteMany({ where: { companyId } }),
  Presupuesto: (tx, companyId) => tx.presupuesto.deleteMany({ where: { companyId } }),
  Insumo: (tx, companyId) => tx.insumo.deleteMany({ where: { companyId } }),
  APU: (tx, companyId) => tx.aPU.deleteMany({ where: { companyId } }),
  Concepto: (tx, companyId) => tx.concepto.deleteMany({ where: { companyId } }),
  Proyecto: (tx, companyId) => tx.proyecto.deleteMany({ where: { companyId } }),
  PayrollRun: (tx, companyId) => tx.payrollRun.deleteMany({ where: { companyId } }),
  Incidencia: (tx, companyId) => tx.incidencia.deleteMany({ where: { companyId } }),
  ImssMovimiento: (tx, companyId) => tx.imssMovimiento.deleteMany({ where: { companyId } }),
  Employee: (tx, companyId) => tx.employee.deleteMany({ where: { companyId } }),
  AccountingEntry: (tx, companyId) => tx.accountingEntry.deleteMany({ where: { companyId } }),
  ChartAccount: (tx, companyId) => tx.chartAccount.deleteMany({ where: { companyId } }),
  AccountingPeriod: (tx, companyId) => tx.accountingPeriod.deleteMany({ where: { companyId } }),
  Reservation: (tx, companyId) => tx.reservation.deleteMany({ where: { companyId } }),
  ClubMember: (tx, companyId) => tx.clubMember.deleteMany({ where: { companyId } }),
  Court: (tx, companyId) => tx.court.deleteMany({ where: { companyId } }),
  PadelClubConfig: (tx, companyId) => tx.padelClubConfig.deleteMany({ where: { companyId } }),
  BankTransaction: (tx, companyId) => tx.bankTransaction.deleteMany({ where: { companyId } }),
  BankAccount: (tx, companyId) => tx.bankAccount.deleteMany({ where: { companyId } }),
  ActivoFijo: (tx, companyId) => tx.activoFijo.deleteMany({ where: { companyId } }),
  Invoice: (tx, companyId) => tx.invoice.deleteMany({ where: { companyId } }),
  Customer: (tx, companyId) => tx.customer.deleteMany({ where: { companyId } }),
  Supplier: (tx, companyId) => tx.supplier.deleteMany({ where: { companyId } }),
  TaxDeclaration: (tx, companyId) => tx.taxDeclaration.deleteMany({ where: { companyId } }),
  PerdidaFiscal: (tx, companyId) => tx.perdidaFiscal.deleteMany({ where: { companyId } }),
  CoeEnvio: (tx, companyId) => tx.coeEnvio.deleteMany({ where: { companyId } }),
  CompanyObligation: (tx, companyId) => tx.companyObligation.deleteMany({ where: { companyId } }),
  IvaPeriodNotice: (tx, companyId) => tx.ivaPeriodNotice.deleteMany({ where: { companyId } }),
  SatSyncRequest: (tx, companyId) => tx.satSyncRequest.deleteMany({ where: { companyId } }),
  CompanyRegimen: (tx, companyId) => tx.companyRegimen.deleteMany({ where: { companyId } }),
  WhatsappConversation: (tx, companyId) =>
    tx.whatsappConversation.deleteMany({ where: { companyId } }),
  ChatConversation: (tx, companyId) => tx.chatConversation.deleteMany({ where: { companyId } }),
  FiscalHallazgo: (tx, companyId) => tx.fiscalHallazgo.deleteMany({ where: { companyId } }),
  ComplianceSnapshot: (tx, companyId) =>
    tx.complianceSnapshot.deleteMany({ where: { companyId } }),
  NotificationItem: (tx, companyId) => tx.notificationItem.deleteMany({ where: { companyId } }),
  PushSubscription: (tx, companyId) =>
    tx.pushSubscription.updateMany({ where: { companyId }, data: { companyId: null } }),
  CompanyInvitation: (tx, companyId) => tx.companyInvitation.deleteMany({ where: { companyId } }),
  DespachoMemberCompany: (tx, companyId) =>
    tx.despachoMemberCompany.deleteMany({ where: { companyId } }),
  CompanyMember: (tx, companyId) => tx.companyMember.deleteMany({ where: { companyId } }),
  CompanyModule: (tx, companyId) => tx.companyModule.deleteMany({ where: { companyId } }),
  Company: (tx, companyId) => tx.company.delete({ where: { id: companyId } }),
};

/**
 * Fase 2 — ejecuta el plan completo dentro de UNA transacción (todo-o-nada).
 *
 * Fallo parcial: si cualquier paso falla (o se agota el timeout de 120 s), la
 * transacción entera se revierte. No quedan borrados a medias: la empresa
 * sigue existiendo pero desactivada y SIN credenciales (fase 1, que es una
 * escritura previa e independiente). El usuario puede reintentar la baja.
 */
export async function borrarEmpresaDefinitivo(companyId: string): Promise<void> {
  // Defensa: el plan y el mapa de operaciones deben cubrirse mutuamente.
  for (const paso of PLAN_BORRADO_EMPRESA) {
    if (!OPERACIONES[paso.modelo]) {
      throw new Error(
        `[baja-empresa] Paso del plan sin operación implementada: ${paso.modelo} — actualiza src/lib/empresas/baja.ts`
      );
    }
  }

  await prisma.$transaction(
    async (tx) => {
      for (const paso of PLAN_BORRADO_EMPRESA) {
        await OPERACIONES[paso.modelo](tx, companyId);
      }
    },
    // Empresas con años de CFDIs pueden tardar: damos margen amplio. Si aun
    // así se agota, la transacción se revierte completa (ver nota arriba).
    { timeout: 120_000, maxWait: 10_000 }
  );
}
