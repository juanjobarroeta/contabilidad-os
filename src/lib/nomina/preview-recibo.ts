// ─────────────────────────────────────────────────────────────────────────────
// Vista previa del recibo de nómina SIN TIMBRAR (borrador).
//
// Arma un objeto con la MISMA forma `Representacion` que consume la
// representación impresa, pero desde el cálculo local (calcularNomina) en vez
// del XML de un CFDI — cero llamadas al PAC. La meta es que lo que se ve en la
// vista previa sea EXACTAMENTE lo que el timbrado emitiría: mismos insumos que
// stampPayrollRun (días pagados de la corrida, incidencias del periodo,
// overrides de corridas especiales) y mismo motor.
//
// tfd = null ⇒ la UI muestra la marca de agua BORRADOR y omite sellos/QR.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import type { Representacion, RepNominaConcepto } from "../facturas/representacion";
import { calcularNomina } from "./calc-nomina";
import { calcularIsrRetenido } from "./isr";
import {
  incidenciasDelPeriodo,
  resumirIncidencias,
  rangoDelPeriodo,
  type IncidenciasResumen,
} from "./incidencias";
import { diasPagadosDeRun } from "./payroll-run";
import { PTU_EXENTO_UMA, UMA_DIARIO, umaDiariaDelEjercicio } from "./constants";
import { registroPatronalEfectivo } from "./registro-patronal";

export type PreviewReciboResult =
  | { ok: true; rep: Representacion }
  | { ok: false; status: number; error: string };

const d = (x: Date) => x.toISOString().slice(0, 10);

export async function previewRecibo(companyId: string, payrollItemId: string): Promise<PreviewReciboResult> {
  const item = await prisma.payrollItem.findUnique({
    where: { id: payrollItemId },
    include: { employee: true, payrollRun: true },
  });
  if (!item || item.payrollRun.companyId !== companyId) {
    return { ok: false, status: 404, error: "Recibo no encontrado" };
  }
  const run = item.payrollRun;
  if (run.origen === "SAT") {
    return { ok: false, status: 422, error: "Los recibos importados del SAT ya están timbrados — usa su representación impresa." };
  }
  if (!["ORDINARIA", "AGUINALDO", "PTU"].includes(run.tipo)) {
    return { ok: false, status: 422, error: `Vista previa no disponible para corridas ${run.tipo}.` };
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true, registroPatronal: true },
  });
  if (!company) return { ok: false, status: 404, error: "Empresa no encontrada" };

  const employee = item.employee;
  const [periodoInicio, periodoFin] = run.periodo.split("/").map((s) => new Date(s));
  const diasPagadosRun = diasPagadosDeRun(run);

  // Mismos insumos que el timbrado (stampPayrollRun): incidencias sólo ORDINARIA;
  // overrides de extraData en especiales; tipo E ⇒ 1 día y periodo = fecha de pago.
  let resumen: IncidenciasResumen | undefined;
  if (run.tipo === "ORDINARIA") {
    const rango = rangoDelPeriodo(run.periodo);
    if (rango) {
      const porEmpleado = await incidenciasDelPeriodo(companyId, [employee.id], rango.inicio, rango.fin);
      resumen = resumirIncidencias(porEmpleado.get(employee.id) ?? []);
    }
  }

  const extra = (run.extraData ?? {}) as Record<string, unknown>;
  const umaPago = umaDiariaDelEjercicio(run.fechaPago.getFullYear()) ?? UMA_DIARIO;
  const esEspecial = run.tipo === "AGUINALDO" || run.tipo === "PTU";

  const calc = calcularNomina({
    employee: employee as typeof employee & { tipoDescuentoInfonavit?: string | null },
    diasPagados: esEspecial ? 0 : diasPagadosRun,
    tipo: run.tipo,
    ejercicio: run.fechaPago.getFullYear(),
    mes: run.fechaPago.getMonth() + 1,
    ...(run.tipo === "ORDINARIA" ? { incidencias: resumen } : {}),
    ...(run.tipo === "AGUINALDO"
      ? {
          diasAguinaldo: Number(extra.diasAguinaldo) || undefined,
          fechaCorte: extra.fechaCorte ? new Date(String(extra.fechaCorte)) : undefined,
          aguinaldoMontoOverride: item.aguinaldo,
        }
      : {}),
    ...(run.tipo === "PTU"
      ? {
          ptuMonto: item.ptu,
          ptuExento: Math.round(Math.min(item.ptu, PTU_EXENTO_UMA * umaPago) * 100) / 100,
        }
      : {}),
  });

  // Igual que en el timbrado: si el cálculo ya no coincide con el item revisado,
  // la vista previa lo dice en vez de mostrar un recibo que no se va a emitir.
  if (Math.abs(calc.netoAPagar - item.netoAPagar) > 0.05) {
    return {
      ok: false,
      status: 409,
      error: `Los importes cambiaron desde el último cálculo (neto ${calc.netoAPagar.toFixed(2)} vs ${item.netoAPagar.toFixed(2)}). Recalcula la corrida y vuelve a abrir la vista previa.`,
    };
  }

  const tipoNomina: "O" | "E" = esEspecial ? "E" : calc.tipoNomina;
  const diasCfdi = esEspecial ? 1 : calc.diasEfectivos;
  const iniCfdi = esEspecial ? run.fechaPago : periodoInicio;
  const finCfdi = esEspecial ? run.fechaPago : periodoFin;

  // Subsidio causado — mismo criterio que emit-nomina (sólo ordinaria).
  const gravadoPeriodo = calc.percepciones.reduce((s, p) => s + p.importeGravado, 0);
  const subsidioCausado =
    tipoNomina === "E"
      ? 0
      : calcularIsrRetenido({
          baseGravable: gravadoPeriodo,
          periodicidadPago: employee.periodicidadPago,
          ejercicio: run.fechaPago.getFullYear(),
          mes: run.fechaPago.getMonth() + 1,
        }).subsidio;

  const percepciones: RepNominaConcepto[] = calc.percepciones.map((p) => ({
    tipo: p.tipoPercepcion,
    clave: p.clave,
    concepto: p.concepto,
    gravado: p.importeGravado,
    exento: p.importeExento,
    importe: null,
  }));
  const deducciones: RepNominaConcepto[] = calc.deducciones.map((dd) => ({
    tipo: dd.tipoDeduccion,
    clave: dd.clave,
    concepto: dd.concepto,
    gravado: null,
    exento: null,
    importe: dd.importe,
  }));
  const otrosPagos: RepNominaConcepto[] =
    subsidioCausado > 0
      ? [{ tipo: "002", clave: "002", concepto: "Subsidio para el empleo", gravado: null, exento: null, importe: 0 }]
      : [];

  const sdi = employee.salarioDiarioIntegrado ?? employee.salarioDiario;
  const antigSemanas = Math.max(1, Math.floor((finCfdi.getTime() - employee.fechaIngreso.getTime()) / (1000 * 60 * 60 * 24 * 7)));
  const nombreEmpleado = [employee.nombre, employee.apellidoPaterno, employee.apellidoMaterno].filter(Boolean).join(" ");

  const rep: Representacion = {
    version: "4.0",
    tipoComprobante: "N",
    serie: null,
    folio: null,
    fecha: null, // sin emitir — es un borrador
    lugarExpedicion: company.codigoPostal,
    formaPago: "99",
    metodoPago: "PUE",
    condicionesDePago: null,
    moneda: "MXN",
    tipoCambio: null,
    subtotal: calc.totalPercepciones,
    descuento: calc.totalDeducciones,
    total: calc.netoAPagar,
    totalImpuestosTrasladados: null,
    totalImpuestosRetenidos: null,
    noCertificadoEmisor: null,
    emisor: { rfc: company.rfc, nombre: company.razonSocial, regimenFiscal: company.regimenFiscal },
    receptor: {
      rfc: employee.rfc,
      nombre: nombreEmpleado,
      domicilioFiscal: employee.codigoPostal ?? company.codigoPostal,
      regimenFiscal: "605",
      usoCfdi: "CN01",
    },
    conceptos: [
      {
        claveProdServ: "84111505",
        noIdentificacion: null,
        cantidad: 1,
        claveUnidad: "ACT",
        unidad: null,
        descripcion: "Pago de nómina",
        valorUnitario: calc.totalPercepciones,
        importe: calc.totalPercepciones,
        descuento: calc.totalDeducciones,
        objetoImp: "01",
        cuentasPrediales: [],
      },
    ],
    traslados: [],
    retenciones: [],
    tfd: null,
    cadenaOriginalTFD: null,
    verificacionUrl: null,
    nomina: {
      tipoNomina,
      fechaPago: d(run.fechaPago),
      fechaInicialPago: d(iniCfdi),
      fechaFinalPago: d(finCfdi),
      numDiasPagados: diasCfdi,
      totalPercepciones: calc.totalPercepciones,
      totalDeducciones: calc.totalDeducciones,
      totalOtrosPagos: otrosPagos.length > 0 ? 0 : null,
      // Registro EFECTIVO: el del centro de trabajo del empleado gana (multi-estado).
      registroPatronal: registroPatronalEfectivo(employee, company),
      curp: employee.curp,
      nss: employee.nss,
      fechaInicioRelLaboral: d(employee.fechaIngreso),
      antiguedad: `P${antigSemanas}W`,
      tipoContrato: employee.tipoContrato,
      tipoRegimen: employee.tipoRegimen,
      numEmpleado: employee.numEmpleado ?? employee.id.slice(-6).toUpperCase(),
      departamento: employee.departamento,
      puesto: employee.puesto,
      riesgoPuesto: employee.riesgoPuesto != null ? String(employee.riesgoPuesto) : null,
      periodicidadPago: tipoNomina === "E" ? "99" : employee.periodicidadPago,
      salarioBaseCotApor: employee.salarioDiario,
      salarioDiarioIntegrado: sdi,
      percepciones,
      deducciones,
      otrosPagos,
    },
    pagos: null,
  };

  return { ok: true, rep };
}
