// Carga el contexto de la evidencia de traspaso (lib/bancos/traspaso-evidencia)
// para un lote de movimientos de UNA empresa: sus cuentas, su RFC y razón
// social, y los movimientos de sus otras cuentas alrededor de las fechas.
import { prisma } from "@/lib/prisma";
import { evidenciaTraspaso, type ContextoTraspaso, type EvidenciaTraspaso, type MovimientoTraspaso } from "./traspaso-evidencia";

const DIA_MS = 86_400_000;

export async function contextoTraspaso(companyId: string, fechas: Date[]): Promise<ContextoTraspaso | null> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true, razonSocial: true } });
  if (!company) return null;
  const cuentas = await prisma.bankAccount.findMany({ where: { companyId }, select: { id: true, numeroCuenta: true, clabe: true } });
  if (fechas.length === 0) return { empresa: company, cuentas, candidatosEspejo: [] };
  const min = new Date(Math.min(...fechas.map((f) => f.getTime())) - 4 * DIA_MS);
  const max = new Date(Math.max(...fechas.map((f) => f.getTime())) + 4 * DIA_MS);
  const candidatos = await prisma.bankTransaction.findMany({
    where: { companyId, fecha: { gte: min, lte: max } },
    select: { id: true, bankAccountId: true, fecha: true, monto: true },
  });
  return {
    empresa: company,
    cuentas,
    candidatosEspejo: candidatos.map((c) => ({ ...c, monto: Number(c.monto) })),
  };
}

/** La evidencia de cada movimiento (por id). Todos deben ser de `companyId`. */
export async function evidenciaTraspasosDb(
  companyId: string,
  movs: MovimientoTraspaso[],
): Promise<Map<string, EvidenciaTraspaso>> {
  const out = new Map<string, EvidenciaTraspaso>();
  if (movs.length === 0) return out;
  const ctx = await contextoTraspaso(companyId, movs.map((m) => m.fecha));
  if (!ctx) return out;
  for (const m of movs) out.set(m.id, evidenciaTraspaso(m, ctx));
  return out;
}

/** La misma evidencia leyendo los movimientos por id. */
export async function evidenciaTraspasoPorIds(companyId: string, ids: string[]): Promise<Map<string, EvidenciaTraspaso>> {
  const filas = await prisma.bankTransaction.findMany({
    where: { companyId, id: { in: ids } },
    select: { id: true, bankAccountId: true, fecha: true, monto: true, descripcion: true, contraparteNombre: true, contraparteRfc: true, contraparteClabe: true },
  });
  return evidenciaTraspasosDb(companyId, filas.map((f) => ({ ...f, monto: Number(f.monto) })));
}
