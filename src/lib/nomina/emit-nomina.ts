// ─────────────────────────────────────────────────────────────────────────────
// Emite un CFDI nómina vía Facturapi y persiste el resultado como Invoice
// con tipo NOMINA. Reutiliza la misma estructura que /api/facturas pero con
// el complemento de nómina específico que requiere SAT v4.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { getFacturapiClient } from "../facturapi";
import { recordTimbrado } from "../costos/record";
import { calcularIsrRetenido } from "./isr";
import { calcularImss } from "./imss";
import { calcularInfonavit } from "./infonavit";
import { calcularValesDespensa } from "./prestaciones";
import { calcularPensionAlimenticia } from "./pension-alimenticia";
import { umaDiariaDelEjercicio } from "./constants";
import type { PercepcionItem, DeduccionItem } from "./calc-nomina";
import type { Employee } from "@prisma/client";

/**
 * Desglose ya calculado por calcularNomina. Cuando se pasa, el CFDI se
 * construye EXACTAMENTE con estas percepciones/deducciones (respetando la
 * separación gravado/exento de horas extra, prima vacacional, etc.) en lugar
 * de re-derivar una sola percepción de sueldo 100% gravada. Es la vía que usa
 * el timbrado de corridas con incidencias — nunca se editan a mano los
 * impuestos calculados.
 */
export type NominaDesglose = {
  percepciones: PercepcionItem[];
  deducciones: DeduccionItem[];
  totalPercepciones: number;
  totalDeducciones: number;
  netoAPagar: number;
};

export type EmitNominaInput = {
  companyId: string;
  employeeId: string;
  periodoInicio: Date;
  periodoFin: Date;
  diasPagados: number;
  fechaPago: Date;
  /** Sueldo bruto del periodo (gravable). Si no se pasa, se calcula como SBC × días. */
  sueldoBruto?: number;
  /** Desglose precalculado (ver NominaDesglose). Tiene prioridad sobre sueldoBruto. */
  desglose?: NominaDesglose;
  /**
   * TipoNomina del complemento: "O" ordinaria (default) o "E" extraordinaria
   * (aguinaldo, PTU y demás pagos fuera del periodo regular — Guía de llenado
   * del complemento nómina, Apéndices 4 y 5). Con "E" la periodicidad de pago
   * del receptor se reporta como "99" (Otra periodicidad), conforme a la guía.
   */
  tipoNomina?: "O" | "E";
  /**
   * Omite los conceptos recurrentes de la ficha del empleado (vales de
   * despensa 029, pensión alimenticia 007) en la vía SIN desglose. Lo activan
   * las corridas NO ordinarias al timbrar: sus items se calcularon sin estos
   * conceptos y el CFDI debe coincidir exactamente con lo revisado.
   */
  omitirConceptosRecurrentes?: boolean;
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
  const sdi = employee.salarioDiarioIntegrado ?? employee.salarioDiario;

  let totalPercepciones: number;
  let totalDeducciones: number;
  let netoAPagar: number;
  // Percepciones/deducciones del complemento en el formato Facturapi.
  let percepcionesCfdi: {
    tipo_percepcion: string;
    clave: string;
    concepto: string;
    importe_gravado: number;
    importe_exento: number;
  }[];
  let deduccionesCfdi: {
    tipo_deduccion: string;
    clave: string;
    concepto: string;
    importe: number;
  }[];

  if (input.desglose) {
    // Desglose precalculado por calcularNomina (corridas con incidencias):
    // el CFDI refleja exactamente lo calculado — separación gravado/exento de
    // horas extra (Art. 93 fracc. I LISR) y prima vacacional (fracc. XIV),
    // bonos/comisiones gravados y descuentos netos incluidos.
    totalPercepciones = input.desglose.totalPercepciones;
    totalDeducciones = input.desglose.totalDeducciones;
    netoAPagar = input.desglose.netoAPagar;
    percepcionesCfdi = input.desglose.percepciones.map((p) => ({
      tipo_percepcion: p.tipoPercepcion,
      clave: p.clave,
      concepto: p.concepto,
      importe_gravado: p.importeGravado,
      importe_exento: p.importeExento,
    }));
    deduccionesCfdi = input.desglose.deducciones.map((d) => ({
      tipo_deduccion: d.tipoDeduccion,
      clave: d.clave,
      concepto: d.concepto,
      importe: d.importe,
    }));
    console.log(`[nomina] ${employee.nombre}: desglose precalculado percepciones=${totalPercepciones} deducciones=${totalDeducciones} neto=${netoAPagar}`);
  } else {
    const sueldoBruto = input.sueldoBruto ?? +(employee.salarioDiario * input.diasPagados).toFixed(2);

    // Vales de despensa recurrentes de la ficha del empleado (percepción 029):
    // prorrateo del monto mensual a los días pagados y exención de 40% UMA
    // diaria por día trabajado — el excedente entra a la base de ISR (misma
    // lógica que calcularNomina; ver calcularValesDespensa, prestaciones.ts).
    const valesCalc = input.omitirConceptosRecurrentes
      ? { monto: 0, exento: 0, gravado: 0 }
      : calcularValesDespensa({
          valesMensual: employee.valesDespensaMensual ?? 0,
          diasPagados: input.diasPagados,
          umaDiaria: umaDiariaDelEjercicio(input.fechaPago.getFullYear()) ?? undefined,
        });

    const isrCalc = calcularIsrRetenido({
      baseGravable: +(sueldoBruto + valesCalc.gravado).toFixed(2),
      periodicidadPago: employee.periodicidadPago,
      ejercicio: input.fechaPago.getFullYear(),
      mes: input.fechaPago.getMonth() + 1,
    });
    const imssCalc = calcularImss({
      salarioBaseCotizacion: sdi,
      diasPagados: input.diasPagados,
      riesgoPuesto: employee.riesgoPuesto,
      // Columna del ejercicio para la CEAV patronal progresiva (DOF 16-dic-2020).
      ejercicio: input.fechaPago.getFullYear(),
    });
    const imssObrero = imssCalc.obrero.total;
    const imssPatronal = imssCalc.patronal.total;
    const infonavitDeduccion = calcularInfonavit({
      tipoDescuento: (employee as Employee & { tipoDescuentoInfonavit?: string | null }).tipoDescuentoInfonavit ?? null,
      descuentoInfonavit: employee.descuentoInfonavit ?? null,
      salarioBaseCotizacion: sdi,
      diasPagados: input.diasPagados,
    });

    // Pensión alimenticia (deducción CFDI 007) — post-impuestos, sobre el
    // neto tras deducciones de ley (misma lógica que calcularNomina).
    const pensionAlimenticia = input.omitirConceptosRecurrentes
      ? 0
      : calcularPensionAlimenticia({
          tipo: employee.pensionAlimenticiaTipo ?? null,
          valor: employee.pensionAlimenticiaValor ?? null,
          netoAntesPension: +(
            sueldoBruto + valesCalc.monto - isrCalc.isrRetenido - imssObrero - infonavitDeduccion
          ).toFixed(2),
          salarioBaseCotizacion: sdi,
          diasPagados: input.diasPagados,
        });

    totalPercepciones = +(sueldoBruto + valesCalc.monto).toFixed(2);
    totalDeducciones = +(
      isrCalc.isrRetenido + imssObrero + infonavitDeduccion + pensionAlimenticia
    ).toFixed(2);
    netoAPagar = +(totalPercepciones - totalDeducciones).toFixed(2);

    percepcionesCfdi = [
      {
        tipo_percepcion: "001", // Sueldos, Salarios Rayas y Jornales
        clave: "001",
        concepto: "Sueldo",
        importe_gravado: sueldoBruto,
        importe_exento: 0,
      },
      ...(valesCalc.monto > 0
        ? [{
            tipo_percepcion: "029", // Vales de despensa
            clave: "029",
            concepto: "Vales de Despensa",
            importe_gravado: valesCalc.gravado,
            importe_exento: valesCalc.exento,
          }]
        : []),
    ];
    deduccionesCfdi = [
      ...(isrCalc.isrRetenido > 0
        ? [{ tipo_deduccion: "002", clave: "002", concepto: "ISR", importe: isrCalc.isrRetenido }]
        : []),
      ...(imssObrero > 0
        ? [{ tipo_deduccion: "001", clave: "001", concepto: "IMSS", importe: imssObrero }]
        : []),
      ...(infonavitDeduccion > 0
        ? [{ tipo_deduccion: "010", clave: "006", concepto: "INFONAVIT", importe: infonavitDeduccion }]
        : []),
      ...(pensionAlimenticia > 0
        ? [{ tipo_deduccion: "007", clave: "007", concepto: "Pensión Alimenticia", importe: pensionAlimenticia }]
        : []),
    ];

    // Log for debugging
    console.log(`[nomina] ${employee.nombre}: bruto=${sueldoBruto} vales=${valesCalc.monto} ISR=${isrCalc.isrRetenido} IMSS_obrero=${imssObrero} IMSS_patronal=${imssPatronal} INFONAVIT=${infonavitDeduccion} pension=${pensionAlimenticia} neto=${netoAPagar}`);
  }

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
          tipo_nomina: input.tipoNomina ?? "O", // O=Ordinaria, E=Extraordinaria (aguinaldo/PTU)
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
            // Nómina extraordinaria: periodicidad "99" (Otra periodicidad),
            // Guía de llenado del complemento nómina, Apéndices 4 y 5.
            periodicidad_pago: input.tipoNomina === "E" ? "99" : employee.periodicidadPago,
            salario_base_cot_apor: employee.salarioDiario,
            salario_diario_integrado: sdi,
            clave_ent_fed: employee.claveEntFed,
          },
          percepciones: {
            percepcion: percepcionesCfdi,
          },
          deducciones: deduccionesCfdi,
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
  // Costo del timbre de nómina (fire-and-forget; no rompe la emisión).
  void recordTimbrado("nomina", 1, { companyId: company.id, subtipo: "nomina.emit" });

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
      uuid: facturapiResp.uuid?.toUpperCase() ?? null, // folio fiscal canónico en MAYÚSCULAS
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
