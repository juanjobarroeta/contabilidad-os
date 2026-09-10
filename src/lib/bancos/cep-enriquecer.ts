// ─────────────────────────────────────────────────────────────────────────────
// Rellena el RFC de la contraparte consultando el CEP de Banxico.
//
// El RFC vale 120 puntos en la conciliación automática —más que el importe
// exacto— porque identifica a la PERSONA y el monto sólo confirma. Los estados
// de cuenta no lo traen (medido: 0 de 172 movimientos de un mes), pero el CEP
// de cada SPEI sí, y la clave de rastreo que el banco imprime es la llave para
// pedirlo.
//
// Disciplina de costo: una consulta por movimiento, UNA sola vez. `cepAt` se
// sella siempre —haya RFC o no— porque un SPEI que Banxico no encuentra
// (traspasos entre cuentas propias, claves mal leídas) se volvería a consultar
// en cada corrida para siempre. Es la misma lección que costó 243 re-parseos
// de acuses anuales.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import {
  consultarCep, contraparteDeCep, paramsDesdeMovimiento, type Cep, type FetchLike,
} from "./cep-tlaloc";

export interface ResultadoCep {
  companyId: string;
  /** Movimientos que tenían con qué consultar. */
  candidatos: number;
  consultados: number;
  /** De ésos, cuántos volvieron con RFC. */
  conRfc: number;
  /** Banxico no encontró la operación (no es error: se marca y no se reintenta). */
  sinCep: number;
  errores: number;
  /** Comprobantes (XML firmado) guardados. */
  comprobantes: number;
  /** Pares CLABE→contraparte aprendidos. */
  cuentasAprendidas: number;
  primerError?: string | null;
}

/**
 * GUARDA EL COMPROBANTE, no sólo los datos que le sacamos. El XML que firma
 * Banxico prueba que ESE importe llegó a la cuenta de ESE beneficiario en ESA
 * fecha: es la evidencia de materialidad que se le enseña al SAT cuando
 * pregunta si un pago fue real. Antes se parseaba y se tiraba.
 *
 * `update: {}` a propósito: el comprobante ya guardado no se pisa — es
 * evidencia, y la que vale es la primera que Banxico firmó.
 */
async function guardarComprobante(txId: string, cep: Cep | null): Promise<boolean> {
  if (!cep?.xml) return false;
  await prisma.cepMovimiento.upsert({
    where: { bankTransactionId: txId },
    update: {},
    create: {
      bankTransactionId: txId,
      xml: cep.xml,
      estado: cep.estado,
      fechaOperacion: cep.fechaOperacion,
      concepto: cep.concepto,
      monto: cep.monto ?? undefined,
      ordenanteNombre: cep.ordenante.nombre,
      ordenanteRfc: cep.ordenante.rfc,
      ordenanteCuenta: cep.ordenante.cuenta,
      ordenanteBanco: cep.ordenante.banco,
      beneficiarioNombre: cep.beneficiario.nombre,
      beneficiarioRfc: cep.beneficiario.rfc,
      beneficiarioCuenta: cep.beneficiario.cuenta,
      beneficiarioBanco: cep.beneficiario.banco,
    },
  });
  return true;
}

/**
 * APRENDE LA CUENTA. La CLABE identifica a la contraparte para siempre: la
 * próxima vez que se le pague no hace falta consultar nada. El CEP es la mejor
 * fuente posible porque trae CLABE y RFC juntos y firmados.
 */
async function aprenderCuenta(
  companyId: string,
  clabeCruda: string | null,
  parte: { rfc?: string | null; nombre?: string | null; banco?: string | null } | null,
): Promise<boolean> {
  if (!parte?.rfc || !clabeCruda) return false;
  const clabe = clabeCruda.replace(/\D/g, "");
  if (clabe.length !== 18) return false;
  await prisma.cuentaContraparte.upsert({
    where: { companyId_clabe: { companyId, clabe } },
    update: { rfc: parte.rfc, nombre: parte.nombre ?? undefined, banco: parte.banco ?? undefined },
    create: { companyId, clabe, rfc: parte.rfc, nombre: parte.nombre, banco: parte.banco, origen: "CEP" },
  });
  return true;
}

export async function enriquecerCepEmpresa(
  companyId: string,
  opts: { max?: number; fetchImpl?: FetchLike; apiKey?: string } = {},
): Promise<ResultadoCep> {
  const max = opts.max ?? 100;
  const out: ResultadoCep = { companyId, candidatos: 0, consultados: 0, conRfc: 0, sinCep: 0, errores: 0, comprobantes: 0, cuentasAprendidas: 0, primerError: null };

  const txs = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      claveRastreo: { not: null },
      contraparteClabe: { not: null },
      contraparteRfc: null,
      cepAt: null,
    },
    select: {
      id: true, fecha: true, monto: true, claveRastreo: true, contraparteClabe: true,
      contraparteNombre: true, conceptoPago: true,
      bankAccount: { select: { clabe: true } },
    },
    orderBy: { fecha: "desc" },
    take: max,
  });
  out.candidatos = txs.length;

  for (const tx of txs) {
    const params = paramsDesdeMovimiento(
      { fecha: tx.fecha, monto: Number(tx.monto), claveRastreo: tx.claveRastreo, contraparteClabe: tx.contraparteClabe },
      tx.bankAccount?.clabe ?? null,
    );
    if (!params) continue;
    out.consultados++;
    try {
      const cep = await consultarCep(params, { fetchImpl: opts.fetchImpl, apiKey: opts.apiKey });
      const parte = cep ? contraparteDeCep(cep, Number(tx.monto)) : null;

      if (await guardarComprobante(tx.id, cep)) out.comprobantes++;
      if (await aprenderCuenta(companyId, tx.contraparteClabe, parte)) out.cuentasAprendidas++;

      const data: Record<string, unknown> = { cepAt: new Date() };
      if (parte?.rfc) {
        data.contraparteRfc = parte.rfc;
        out.conRfc++;
        // El nombre del CEP sólo se usa si NO había otro: Banxico lo parte en
        // bloques de ancho fijo y el del banco suele leerse mejor.
        if (!tx.contraparteNombre && parte.nombre) data.contraparteNombre = parte.nombre;
        if (!tx.conceptoPago && cep?.concepto) data.conceptoPago = cep.concepto;
      } else {
        out.sinCep++;
      }
      await prisma.bankTransaction.update({ where: { id: tx.id }, data });
    } catch (e) {
      out.errores++;
      out.primerError ??= e instanceof Error ? e.message : String(e);
      // Un fallo de red NO se sella: se reintenta en la próxima corrida.
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPARACIÓN DE UNA SOLA VEZ: los CEP que se consultaron ANTES de que el
// comprobante se guardara.
//
// El 8 y 9 de sep-2026 el enriquecedor consultó 118 SPEI y sacó 114 RFCs, pero
// la parte que GUARDA el XML llegó después (#947, mergeada el 9-sep 06:29 UTC —
// horas más tarde que la última corrida). Como el enriquecedor es gap-driven
// por `cepAt IS NULL` y esos movimientos ya quedaron sellados, jamás se los
// vuelve a mirar: su evidencia de materialidad se perdió sin que nada lo
// dijera, y el visor del CEP abría vacío para toda la cartera.
//
// Esto NO va en el scheduler y no debe automatizarse: cada consulta cuesta una
// llamada a Banxico, y un SPEI que no aparece volvería a consultarse en cada
// corrida para siempre — la misma lección que puso `cepAt` en su lugar. Es un
// pase manual, acotado y contable (scripts/cep-recomprobantes.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoRecomprobante {
  companyId: string;
  /** Sellados (`cepAt`) que NO tienen comprobante guardado. */
  candidatos: number;
  consultados: number;
  /** Comprobantes (XML firmado) que quedaron guardados en esta pasada. */
  comprobantes: number;
  /** Banxico no halla la operación. No es error: es una respuesta. */
  sinCep: number;
  /** RFCs que faltaban y el CEP sí trajo (de paso, no es el objetivo). */
  rfcsRellenados: number;
  cuentasAprendidas: number;
  errores: number;
  primerError?: string | null;
}

export async function reconsultarComprobantesEmpresa(
  companyId: string,
  opts: { max?: number; fetchImpl?: FetchLike; apiKey?: string } = {},
): Promise<ResultadoRecomprobante> {
  const max = opts.max ?? 200;
  const out: ResultadoRecomprobante = {
    companyId, candidatos: 0, consultados: 0, comprobantes: 0, sinCep: 0,
    rfcsRellenados: 0, cuentasAprendidas: 0, errores: 0, primerError: null,
  };

  const txs = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      claveRastreo: { not: null },
      contraparteClabe: { not: null },
      // Lo contrario del enriquecedor: aquí interesan los YA consultados…
      cepAt: { not: null },
      // …a los que les falta la evidencia. Con el comprobante guardado no hay
      // nada que pedir: es lo que hace que esta pasada converja y no se
      // convierta en un gasto recurrente.
      cepMovimiento: { is: null },
    },
    select: {
      id: true, fecha: true, monto: true, claveRastreo: true, contraparteClabe: true,
      contraparteNombre: true, contraparteRfc: true, conceptoPago: true,
      bankAccount: { select: { clabe: true } },
    },
    orderBy: { fecha: "desc" },
    take: max,
  });
  out.candidatos = txs.length;

  for (const tx of txs) {
    const params = paramsDesdeMovimiento(
      { fecha: tx.fecha, monto: Number(tx.monto), claveRastreo: tx.claveRastreo, contraparteClabe: tx.contraparteClabe },
      tx.bankAccount?.clabe ?? null,
    );
    if (!params) continue;
    out.consultados++;
    try {
      const cep = await consultarCep(params, { fetchImpl: opts.fetchImpl, apiKey: opts.apiKey });
      if (!cep) { out.sinCep++; continue; }
      const parte = contraparteDeCep(cep, Number(tx.monto));
      if (await guardarComprobante(tx.id, cep)) out.comprobantes++;
      if (await aprenderCuenta(companyId, tx.contraparteClabe, parte)) out.cuentasAprendidas++;
      // El RFC es de la primera pasada; sólo se rellena si sigue faltando —
      // nunca se pisa lo que ya se sabía de la contraparte.
      if (!tx.contraparteRfc && parte?.rfc) {
        await prisma.bankTransaction.update({
          where: { id: tx.id },
          data: { contraparteRfc: parte.rfc },
        });
        out.rfcsRellenados++;
      }
    } catch (e) {
      out.errores++;
      out.primerError ??= e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}
