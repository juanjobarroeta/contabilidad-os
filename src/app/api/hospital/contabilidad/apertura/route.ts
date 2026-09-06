/**
 * GET  /api/hospital/contabilidad/apertura?companyId=
 *   → { apertura: { fecha, cuentas: [{ codigo, nombre, tipo, naturaleza, saldo }], total: { cargos, abonos, cuentas } } | null,
 *      catalogo: [{ codigo, nombre, tipo, naturaleza, nivel }] }
 * POST /api/hospital/contabilidad/apertura { companyId, fecha: "YYYY-MM-DD", lineas: [{ codigo, saldo }] }
 *   → postApertura del hub (asiento APERTURA, una sola por empresa; reemplaza la anterior).
 *
 * `codigo` es el de la cuenta en el catálogo de la empresa (subcuenta o
 * cuenta) y `saldo` va en signo natural (deudora +cargo, acreedora +abono) —
 * lo que devuelve leer-balanza en `lineas[].saldo`. Debe cuadrar dentro de la
 * tolerancia de redondeo del hub (medio centavo por cuenta). Misma lógica que
 * /api/contabilidad/apertura, bajo la autorización del módulo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { AperturaError, postApertura } from "@/lib/contabilidad/apertura";
import { PeriodoCerradoError } from "@/lib/contabilidad/ejercicio";
import { catalogoDeEmpresa } from "@/lib/hospital/contabilidad";
import { r2 } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const [catalogo, asientos] = await Promise.all([
    catalogoDeEmpresa(prisma, companyId),
    prisma.accountingEntry.findMany({
      where: { companyId, fuente: "APERTURA" },
      select: { fecha: true, tipo: true, monto: true, chartAccount: { select: { cuentaSAT: true, subcuenta: true } } },
    }),
  ]);
  if (asientos.length === 0) return NextResponse.json({ apertura: null, catalogo });

  const porCodigo = new Map<string, { cargo: number; abono: number }>();
  let fecha: string | null = null;
  let cargos = 0;
  let abonos = 0;
  for (const e of asientos) {
    const codigo = e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT;
    const s = porCodigo.get(codigo) ?? { cargo: 0, abono: 0 };
    const monto = Number(e.monto);
    if (e.tipo === "CARGO") {
      s.cargo += monto;
      cargos += monto;
    } else {
      s.abono += monto;
      abonos += monto;
    }
    porCodigo.set(codigo, s);
    if (!fecha) fecha = e.fecha.toISOString().slice(0, 10);
  }
  const cuentas = catalogo
    .filter((c) => porCodigo.has(c.codigo))
    .map((c) => {
      const s = porCodigo.get(c.codigo)!;
      return { codigo: c.codigo, nombre: c.nombre, tipo: c.tipo, naturaleza: c.naturaleza, saldo: r2(c.naturaleza === "D" ? s.cargo - s.abono : s.abono - s.cargo) };
    })
    .filter((c) => Math.abs(c.saldo) >= 0.005);
  return NextResponse.json({ apertura: { fecha, cuentas, total: { cargos: r2(cargos), abonos: r2(abonos), cuentas: cuentas.length } }, catalogo });
});

const postSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha YYYY-MM-DD"),
  lineas: z.array(z.object({ codigo: z.string().trim().min(1).max(60), saldo: z.number().finite() })).min(1),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, fecha, lineas } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  try {
    const resultado = await postApertura(companyId, fecha, lineas);
    bitacora(user, req, {
      companyId,
      accion: "hospital.contabilidad.apertura",
      entidad: "AccountingEntry",
      entidadId: `${companyId}:apertura`,
      detalle: { lineas: lineas.length, ...resultado },
    });
    return NextResponse.json({ ok: true, ...resultado });
  } catch (e) {
    if (e instanceof AperturaError) return NextResponse.json({ error: e.message, diferencia: e.diferencia ?? null }, { status: 400 });
    if (e instanceof PeriodoCerradoError) return error(e.message, e.status);
    throw e;
  }
});
