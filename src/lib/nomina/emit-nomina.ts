// ─────────────────────────────────────────────────────────────────────────────
// Emite un CFDI nómina vía Facturapi y persiste el resultado como Invoice
// con tipo NOMINA. Reutiliza la misma estructura que /api/facturas pero con
// el complemento de nómina específico que requiere SAT v4.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { getFacturapiClient } from "../facturapi";
import { calcularIsrRetenido } from "./isr";
import { calcularImss } from "./imss";
import { calcularInfonavit } from "./infonavit";
import type { Employee } from "@prisma/client";

export type EmitNominaInput = {
  companyId: string;
  employeeId: string;
  periodoInicio: Date;
  periodoFin: Date;
  diasPagados: number;
  fechaPago: Date;
  /** Sueldo bruto del periodo (gravable). Si no se pasa, se calcula como SBC × días. */
  sueldoBruto?: number;
};

export type EmitNominaResult = {
  ok: boolean;
  invoiceId?: string;
  uuid?: string;
  totalPercepciones?: number;
  totalDeducciones?: number;
  netoAPagar?: number;
  error?: string;
};

// Placeholder CURP for personas morales — used when emisor is a PM and we
// don't have the curp del representante legal stored.
const CURP_PM_PLACEHOLDER = "XEXX010101HNEXXXA4";

export async function emitNominaCfdi(input: EmitNominaInput): Promise<EmitNominaResult> {
  const company = await prisma.company.findUnique({ where: { id: input.companyId } });
  if (!company) return { ok: false, error: "Empresa no encontrada" };
  if (!company.facturapiApiKey) {
    return { ok: false, error: "La empresa no tiene clave Facturapi configurada" };
  }
  if (!company.registroPatronal) {
    return { ok: false, error: "Falta el Registro Patronal de la empresa (configúralo en /empresa)" };
  }

  const employee = await prisma.employee.findUnique({ where: { id: input.employeeId } });
  if (!employee) return { ok: false, error: "Empleado no encontrado" };
  if (employee.companyId !== input.companyId) {
    return { ok: false, error: "El empleado no pertenece a esta empresa" };
  }

  // ── Cálculo de percepciones, deducciones, neto ────────────────────────
  const sueldoBruto = input.sueldoBruto ?? +(employee.salarioDiario * input.diasPagados).toFixed(2);
  const sdi = employee.salarioDiarioIntegrado ?? employee.salarioDiario;

  const isrCalc = calcularIsrRetenido({
    baseGravable: sueldoBruto,
    periodicidadPago: employee.periodicidadPago,
    ejercicio: input.fechaPago.getFullYear(),
  });
  const imssCalc = calcularImss({
    salarioBaseCotizacion: sdi,
    diasPagados: input.diasPagados,
    riesgoPuesto: employee.riesgoPuesto,
  });
  const imssObrero = imssCalc.obrero.total;
  const imssPatronal = imssCalc.patronal.total;
  const infonavitDeduccion = calcularInfonavit({
    tipoDescuento: (employee as Employee & { tipoDescuentoInfonavit?: string | null }).tipoDescuentoInfonavit ?? null,
    descuentoInfonavit: employee.descuentoInfonavit ?? null,
    salarioBaseCotizacion: sdi,
    diasPagados: input.diasPagados,
  });

  const totalPercepciones = sueldoBruto;
  const totalDeducciones = +(isrCalc.isrRetenido + imssObrero + infonavitDeduccion).toFixed(2);
  const netoAPagar = +(totalPercepciones - totalDeducciones).toFixed(2);

  // Log for debugging
  console.log(`[nomina] ${employee.nombre}: bruto=${sueldoBruto} ISR=${isrCalc.isrRetenido} IMSS_obrero=${imssObrero} IMSS_patronal=${imssPatronal} INFONAVIT=${infonavitDeduccion} neto=${netoAPagar}`);

  // ── Construir el payload Facturapi ─────────────────────────────────────
  const facturapi = getFacturapiClient(company.facturapiApiKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = {
    type: "N",
    use: "CN01",
    payment_form: "99",
    payment_method: "PUE",
    customer: {
      legal_name: `${employee.nombre} ${employee.apellidoPaterno} ${employee.apellidoMaterno ?? ""}`.trim().toUpperCase(),
      tax_id: employee.rfc,
      tax_system: "605", // Sueldos y Salarios e Ingresos Asimilados
      address: {
        country: "MEX",
        zip: company.codigoPostal, // we use empresa's CP since we don't store empleado's
      },
      email: employee.email ?? undefined,
    },
    items: [
      {
        quantity: 1,
        product: {
          description: `Pago de nómina ${input.periodoInicio.toISOString().slice(0, 10)} a ${input.periodoFin.toISOString().slice(0, 10)}`,
          product_key: "84111505", // Servicios de nómina (SAT default)
          price: totalPercepciones,
          tax_included: true,
          taxes: [], // nómina no lleva IVA en items, las deducciones van en el complemento
        },
      },
    ],
    complements: [
      {
        type: "nomina",
        data: {
          tipo_nomina: "O", // O=Ordinaria, E=Extraordinaria
          fecha_pago: input.fechaPago.toISOString(),
          fecha_inicial_pago: input.periodoInicio.toISOString(),
          fecha_final_pago: input.periodoFin.toISOString(),
          num_dias_pagados: input.diasPagados,
          emisor: {
            curp: CURP_PM_PLACEHOLDER,
            registro_patronal: company.registroPatronal,
          },
          receptor: {
            curp: employee.curp,
            num_seguridad_social: employee.nss,
            fecha_inicio_rel_laboral: employee.fechaIngreso.toISOString(),
            antiguedad: computeAntiguedadCode(employee, input.periodoFin),
            tipo_contrato: employee.tipoContrato,
            tipo_jornada: employee.tipoJornada,
            tipo_regimen: employee.tipoRegimen,
            num_empleado: employee.numEmpleado ?? employee.id.slice(-6).toUpperCase(),
            departamento: employee.departamento ?? undefined,
            puesto: employee.puesto ?? undefined,
            riesgo_puesto: employee.riesgoPuesto,
            periodicidad_pago: employee.periodicidadPago,
            salario_base_cot_apor: employee.salarioDiario,
            salario_diario_integrado: sdi,
            clave_ent_fed: employee.claveEntFed,
          },
          percepciones: {
            percepcion: [
              {
                tipo_percepcion: "001", // Sueldos, Salarios Rayas y Jornales
                clave: "001",
                concepto: "Sueldo",
                importe_gravado: totalPercepciones,
                importe_exento: 0,
              },
            ],
          },
          deducciones: [
            ...(isrCalc.isrRetenido > 0
              ? [
                  {
                    tipo_deduccion: "002", // ISR
                    clave: "002",
                    concepto: "ISR",
                    importe: isrCalc.isrRetenido,
                  },
                ]
              : []),
            ...(imssObrero > 0
              ? [
                  {
                    tipo_deduccion: "001", // Seguridad Social (IMSS obrero)
                    clave: "001",
                    concepto: "IMSS",
                    importe: imssObrero,
                  },
                ]
              : []),
            ...(infonavitDeduccion > 0
              ? [
                  {
                    tipo_deduccion: "010", // Descuento INFONAVIT (vivienda)
                    clave: "006",
                    concepto: "INFONAVIT",
                    importe: infonavitDeduccion,
                  },
                ]
              : []),
          ],
        },
      },
    ],
  };

  // ── Llamar a Facturapi ─────────────────────────────────────────────────
  let facturapiResp;
  try {
    facturapiResp = await facturapi.invoices.create(payload);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Error de Facturapi al timbrar nómina",
    };
  }

  // ── Persistir como Invoice ─────────────────────────────────────────────
  const invoice = await prisma.invoice.create({
    data: {
      companyId: company.id,
      tipo: "NOMINA",
      fecha: input.fechaPago,
      formaPago: "99",
      metodoPago: "PUE",
      usoCfdi: "CN01",
      moneda: "MXN",
      subtotal: totalPercepciones,
      total: netoAPagar,
      totalImpuestos: -totalDeducciones, // negative because retenciones reduce the total
      status: "STAMPED",
      uuid: facturapiResp.uuid ?? null,
      facturapiId: facturapiResp.id ?? null,
      notas: `Nómina ${employee.nombre} ${employee.apellidoPaterno} · ${input.periodoInicio.toISOString().slice(0, 10)} a ${input.periodoFin.toISOString().slice(0, 10)}`,
    },
  });

  return {
    ok: true,
    invoiceId: invoice.id,
    uuid: facturapiResp.uuid ?? undefined,
    totalPercepciones,
    totalDeducciones,
    netoAPagar,
  };
}

function computeAntiguedadCode(employee: Employee, periodoFin: Date): string {
  // SAT espera "P{semanas}W" (e.g. "P12W" = 12 semanas de antigüedad)
  const ms = periodoFin.getTime() - employee.fechaIngreso.getTime();
  const weeks = Math.max(1, Math.floor(ms / (1000 * 60 * 60 * 24 * 7)));
  return `P${weeks}W`;
}
