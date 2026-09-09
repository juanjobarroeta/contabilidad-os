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
  consultarCep, contraparteDeCep, paramsDesdeMovimiento, type FetchLike,
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

      // GUARDAR EL COMPROBANTE, no sólo los datos que le sacamos. El XML que
      // firma Banxico prueba que ESE importe llegó a la cuenta de ESE
      // beneficiario en ESA fecha: es la evidencia de materialidad que se le
      // enseña al SAT cuando pregunta si un pago fue real. Antes se parseaba
      // y se tiraba.
      if (cep?.xml) {
        await prisma.cepMovimiento.upsert({
          where: { bankTransactionId: tx.id },
          update: {},
          create: {
            bankTransactionId: tx.id,
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
        out.comprobantes++;
      }

      // APRENDER LA CUENTA. La CLABE identifica a la contraparte para siempre:
      // la próxima vez que se le pague no hace falta consultar nada. El CEP es
      // la mejor fuente posible porque trae CLABE y RFC juntos y firmados.
      if (parte?.rfc && tx.contraparteClabe) {
        const clabe = tx.contraparteClabe.replace(/\D/g, "");
        if (clabe.length === 18) {
          await prisma.cuentaContraparte.upsert({
            where: { companyId_clabe: { companyId, clabe } },
            update: { rfc: parte.rfc, nombre: parte.nombre ?? undefined, banco: parte.banco ?? undefined },
            create: { companyId, clabe, rfc: parte.rfc, nombre: parte.nombre, banco: parte.banco, origen: "CEP" },
          });
          out.cuentasAprendidas++;
        }
      }

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
