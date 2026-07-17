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
import { receptorDesdeXmlNomina, registroPatronalDesdeXmlNomina } from "./receptor-xml";
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
  // Registro patronal: si no está capturado, se rescata del complemento de un
  // recibo de nómina YA TIMBRADO de la empresa (los importados del SAT lo
  // traen validado) y se guarda en la ficha — mismo auto-backfill que el CP
  // fiscal del receptor. Solo si tampoco hay historial se pide capturarlo.
  let registroPatronal = company.registroPatronal;
  if (!registroPatronal) {
    const previo = await prisma.invoice.findFirst({
      where: { companyId: company.id, tipo: "NOMINA", status: "STAMPED", rawXml: { not: null } },
      orderBy: { fecha: "desc" },
      select: { rawXml: true },
    });
    registroPatronal = previo?.rawXml ? registroPatronalDesdeXmlNomina(previo.rawXml) : null;
    if (registroPatronal) {
      await prisma.company.update({ where: { id: company.id }, data: { registroPatronal } });
    }
  }
  if (!registroPatronal) {
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

    const isrCalc = calcularIsrRetenido({
      baseGravable: sueldoBruto,
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
      // Art. 36 LSS: al trabajador de salario mínimo no se le retiene IMSS
      // (la cuota obrera la absorbe el patrón).
      salarioDiario: employee.salarioDiario,
    });
    const imssObrero = imssCalc.obrero.total;
    const imssPatronal = imssCalc.patronal.total;
    const infonavitDeduccion = calcularInfonavit({
      tipoDescuento: (employee as Employee & { tipoDescuentoInfonavit?: string | null }).tipoDescuentoInfonavit ?? null,
      descuentoInfonavit: employee.descuentoInfonavit ?? null,
      salarioBaseCotizacion: sdi,
      diasPagados: input.diasPagados,
    });

    totalPercepciones = sueldoBruto;
    totalDeducciones = +(isrCalc.isrRetenido + imssObrero + infonavitDeduccion).toFixed(2);
    netoAPagar = +(totalPercepciones - totalDeducciones).toFixed(2);

    percepcionesCfdi = [
      {
        tipo_percepcion: "001", // Sueldos, Salarios Rayas y Jornales
        clave: "001",
        concepto: "Sueldo",
        importe_gravado: totalPercepciones,
        importe_exento: 0,
      },
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
    ];

    // Log for debugging
    console.log(`[nomina] ${employee.nombre}: bruto=${sueldoBruto} ISR=${isrCalc.isrRetenido} IMSS_obrero=${imssObrero} IMSS_patronal=${imssPatronal} INFONAVIT=${infonavitDeduccion} neto=${netoAPagar}`);
  }

  // ── Identidad fiscal del receptor (CP y nombre EXACTOS del SAT) ────────
  // CFDI 4.0 valida RFC + Nombre + DomicilioFiscalReceptor contra el padrón.
  // Fuente de verdad en cascada: (1) el CP capturado en la ficha; (2) el
  // Receptor de un recibo de nómina previo YA TIMBRADO del mismo RFC (pasó esa
  // validación, así que trae los datos exactos) — y si de ahí sale, se guarda
  // en la ficha para no volver a buscar; (3) el CP de la empresa (último
  // recurso, puede fallar la validación). El nombre textual del XML previo
  // también sustituye al reconstruido (evita desajustes por acentos/espacios).
  let cpReceptor = employee.codigoPostal;
  let nombreReceptor = `${employee.nombre} ${employee.apellidoPaterno} ${employee.apellidoMaterno ?? ""}`
    .trim()
    .toUpperCase();
  {
    const previo = await prisma.invoice.findFirst({
      where: {
        companyId: company.id,
        tipo: "NOMINA",
        status: "STAMPED",
        rawXml: { contains: employee.rfc },
      },
      orderBy: { fecha: "desc" },
      select: { rawXml: true },
    });
    const receptor = previo?.rawXml ? receptorDesdeXmlNomina(previo.rawXml, employee.rfc) : null;
    if (receptor?.nombre) nombreReceptor = receptor.nombre;
    if (receptor?.codigoPostal) {
      if (!cpReceptor) {
        cpReceptor = receptor.codigoPostal;
        await prisma.employee.update({
          where: { id: employee.id },
          data: { codigoPostal: receptor.codigoPostal },
        });
      } else if (cpReceptor !== receptor.codigoPostal) {
        // Captura manual distinta al CP de un recibo validado: gana la captura
        // (puede haber cambiado el domicilio fiscal), sólo se deja rastro.
        console.warn(
          `[nomina] CP capturado (${cpReceptor}) difiere del CP de recibo timbrado (${receptor.codigoPostal}) para ${employee.rfc}`,
        );
      }
    }
  }

  // ── Subsidio para el empleo (OtrosPagos clave 002) ─────────────────────
  // El SAT exige reportar el subsidio causado cuando el trabajador tiene
  // derecho (decreto 1-may-2024 vigente; validación: "El elemento OtroPago no
  // contiene un atributo TipoOtroPago con la clave 002…"). Se calcula sobre el
  // GRAVADO del periodo con el mismo motor del ISR; el importe ENTREGADO es 0
  // — el subsidio actual solo se acredita contra el ISR, nunca se paga en
  // efectivo. Las extraordinarias (aguinaldo/PTU) no llevan subsidio.
  const gravadoPeriodo = percepcionesCfdi.reduce((s, p) => s + p.importe_gravado, 0);
  const subsidioCausado =
    input.tipoNomina === "E"
      ? 0
      : calcularIsrRetenido({
          baseGravable: gravadoPeriodo,
          periodicidadPago: employee.periodicidadPago,
          ejercicio: input.fechaPago.getFullYear(),
          mes: input.fechaPago.getMonth() + 1,
        }).subsidio;

  // ── Construir el payload Facturapi ─────────────────────────────────────
  const facturapi = getFacturapiClient(company.facturapiApiKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = {
    type: "N",
    use: "CN01",
    payment_form: "99",
    payment_method: "PUE",
    customer: {
      // Nombre y CP resueltos arriba: captura de la ficha → recibo timbrado
      // previo del mismo RFC → CP de la empresa (último recurso).
      legal_name: nombreReceptor,
      tax_id: employee.rfc,
      tax_system: "605", // Sueldos y Salarios e Ingresos Asimilados
      address: {
        country: "MEX",
        zip: cpReceptor ?? company.codigoPostal,
      },
      email: employee.email ?? undefined,
    },
    // SIN `items`: en los recibos de nómina (type "N") Facturapi deriva los
    // conceptos y totales del propio complemento (percepciones/deducciones) y
    // RECHAZA el campo con `"items" is not allowed` — visto al timbrar la
    // primera corrida real (las anteriores venían importadas del SAT).
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
            // Nomina12:Emisor:Curp SOLO aplica a patrón persona física (RFC de
            // 13); para una PM el SAT rechaza el atributo ("no aplica para
            // persona moral") — se omite. El placeholder queda únicamente para
            // el caso PF legado.
            ...(company.rfc.length === 13 ? { curp: CURP_PM_PLACEHOLDER } : {}),
            registro_patronal: registroPatronal,
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
          ...(subsidioCausado > 0
            ? {
                otros_pagos: [
                  {
                    tipo_otro_pago: "002",
                    clave: "002",
                    concepto: "Subsidio para el empleo",
                    importe: 0,
                    subsidio_causado: +subsidioCausado.toFixed(2),
                  },
                ],
              }
            : {}),
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
