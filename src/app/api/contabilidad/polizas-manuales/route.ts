import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireWriter, withAuthz } from "@/lib/authz";
import { TOLERANCIA_CUADRE } from "@/lib/contabilidad/ce-readiness";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Pólizas MANUALES (ajustes, reclasificaciones, provisiones).
//
// Sin tabla nueva: una póliza manual es un conjunto BALANCEADO de
// AccountingEntry con fuente=MANUAL, referenciaTipo="POLIZA" y una referencia
// compartida (cuid). La agrupación derivada (clavePoliza) la muestra como UNA
// póliza en el libro diario y en el XML del Anexo 24, y postMonth NUNCA la
// regenera (MANUAL no está en REGENERATED_SOURCES) — estable entre re-posteos.
//
// POST   crea; PUT reemplaza todas las líneas de una referencia; DELETE borra.
// Guardas: cargos = abonos (±TOLERANCIA_CUADRE), cuentas de la empresa,
// periodo no CLOSED (el candado de ejercicio llega en la Fase 3, la guarda
// queda lista desde ahora). Rol: escritura (no VIEWER).
// ─────────────────────────────────────────────────────────────────────────────

const lineaSchema = z.object({
  cuenta: z.string().min(3), // subcuenta ("102.01") o cuenta nivel-2 sin subcuentas
  concepto: z.string().trim().max(300).optional(),
  cargo: z.number().min(0).default(0),
  abono: z.number().min(0).default(0),
});

const polizaSchema = z.object({
  companyId: z.string().min(1),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  concepto: z.string().trim().min(3).max(300),
  lineas: z.array(lineaSchema).min(2).max(60),
  /** Sólo PUT: referencia de la póliza a reemplazar. */
  referencia: z.string().optional(),
});

const r2 = (n: number) => Math.round(n * 100) / 100;

async function validarYArmar(body: unknown) {
  const parsed = polizaSchema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos", status: 400 as const };
  }
  const p = parsed.data;

  const totalCargos = r2(p.lineas.reduce((s, l) => s + l.cargo, 0));
  const totalAbonos = r2(p.lineas.reduce((s, l) => s + l.abono, 0));
  if (Math.abs(totalCargos - totalAbonos) > TOLERANCIA_CUADRE) {
    return {
      error: `La póliza no cuadra: cargos ${totalCargos.toFixed(2)} vs abonos ${totalAbonos.toFixed(2)}.`,
      status: 422 as const,
    };
  }
  for (const l of p.lineas) {
    const monto = l.cargo > 0 ? l.cargo : l.abono;
    if (monto <= 0 || (l.cargo > 0 && l.abono > 0)) {
      return { error: "Cada línea lleva un cargo O un abono, mayor a cero.", status: 422 as const };
    }
  }

  const fecha = new Date(`${p.fecha}T12:00:00Z`);
  const year = fecha.getUTCFullYear();
  const month = fecha.getUTCMonth() + 1;

  const period = await prisma.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId: p.companyId, year, month } },
  });
  if (period?.status === "CLOSED") {
    return { error: `El periodo ${year}-${String(month).padStart(2, "0")} está cerrado (ejercicio bloqueado).`, status: 409 as const };
  }

  // Resolver cuentas (deben existir y ser de la empresa).
  const cuentas = [...new Set(p.lineas.map((l) => l.cuenta))];
  const accounts = await prisma.chartAccount.findMany({
    where: {
      companyId: p.companyId,
      OR: cuentas.flatMap((c) => [{ subcuenta: c }, { cuentaSAT: c, subcuenta: null }]),
    },
    select: { id: true, cuentaSAT: true, subcuenta: true },
  });
  const idPorCuenta = new Map(accounts.map((a) => [a.subcuenta ?? a.cuentaSAT, a.id]));
  const faltantes = cuentas.filter((c) => !idPorCuenta.has(c));
  if (faltantes.length > 0) {
    return { error: `Cuenta(s) no encontradas en el catálogo: ${faltantes.join(", ")}.`, status: 422 as const };
  }

  return { p, fecha, year, month, idPorCuenta, totalCargos };
}

async function escribirPoliza(args: {
  companyId: string;
  referencia: string;
  fecha: Date;
  year: number;
  month: number;
  concepto: string;
  lineas: Array<{ cuenta: string; concepto?: string; cargo: number; abono: number }>;
  idPorCuenta: Map<string, string>;
  reemplazar: boolean;
}) {
  await prisma.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.upsert({
      where: { companyId_year_month: { companyId: args.companyId, year: args.year, month: args.month } },
      update: {},
      create: { companyId: args.companyId, year: args.year, month: args.month, status: "DRAFT" },
    });
    if (args.reemplazar) {
      await tx.accountingEntry.deleteMany({
        where: { companyId: args.companyId, fuente: "MANUAL", referenciaTipo: "POLIZA", referencia: args.referencia },
      });
    }
    await tx.accountingEntry.createMany({
      data: args.lineas.map((l) => ({
        companyId: args.companyId,
        chartAccountId: args.idPorCuenta.get(l.cuenta)!,
        year: args.year,
        month: args.month,
        periodId: period.id,
        fecha: args.fecha,
        descripcion: l.concepto?.trim() || args.concepto,
        monto: l.cargo > 0 ? l.cargo : l.abono,
        tipo: l.cargo > 0 ? ("CARGO" as const) : ("ABONO" as const),
        fuente: "MANUAL" as const,
        referenciaTipo: "POLIZA",
        referencia: args.referencia,
      })),
    });
  });
}

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const companyId = String((body as { companyId?: string })?.companyId ?? "");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const { user } = await requireWriter(companyId, req);

  const v = await validarYArmar(body);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: v.status });

  const referencia = randomUUID();
  await escribirPoliza({
    companyId,
    referencia,
    fecha: v.fecha,
    year: v.year,
    month: v.month,
    concepto: v.p.concepto,
    lineas: v.p.lineas,
    idPorCuenta: v.idPorCuenta,
    reemplazar: false,
  });

  registrarBitacora({
    accion: "contabilidad.poliza-manual.crear",
    userId: user.id,
    companyId,
    entidad: "AccountingEntry",
    entidadId: referencia,
    detalle: { concepto: v.p.concepto, lineas: v.p.lineas.length, total: v.totalCargos, periodo: `${v.year}-${v.month}` },
  });
  return NextResponse.json({ ok: true, referencia }, { status: 201 });
});

export const PUT = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const companyId = String((body as { companyId?: string })?.companyId ?? "");
  const referencia = String((body as { referencia?: string })?.referencia ?? "");
  if (!companyId || !referencia) {
    return NextResponse.json({ error: "companyId y referencia requeridos" }, { status: 400 });
  }
  const { user } = await requireWriter(companyId, req);

  const existentes = await prisma.accountingEntry.count({
    where: { companyId, fuente: "MANUAL", referenciaTipo: "POLIZA", referencia },
  });
  if (existentes === 0) return NextResponse.json({ error: "Póliza manual no encontrada" }, { status: 404 });

  const v = await validarYArmar(body);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: v.status });

  await escribirPoliza({
    companyId,
    referencia,
    fecha: v.fecha,
    year: v.year,
    month: v.month,
    concepto: v.p.concepto,
    lineas: v.p.lineas,
    idPorCuenta: v.idPorCuenta,
    reemplazar: true,
  });

  registrarBitacora({
    accion: "contabilidad.poliza-manual.editar",
    userId: user.id,
    companyId,
    entidad: "AccountingEntry",
    entidadId: referencia,
    detalle: { concepto: v.p.concepto, lineas: v.p.lineas.length, total: v.totalCargos },
  });
  return NextResponse.json({ ok: true, referencia });
});

export const DELETE = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const referencia = searchParams.get("referencia");
  if (!companyId || !referencia) {
    return NextResponse.json({ error: "companyId y referencia requeridos" }, { status: 400 });
  }
  const { user } = await requireWriter(companyId, req);

  const entry = await prisma.accountingEntry.findFirst({
    where: { companyId, fuente: "MANUAL", referenciaTipo: "POLIZA", referencia },
    select: { year: true, month: true, descripcion: true },
  });
  if (!entry) return NextResponse.json({ error: "Póliza manual no encontrada" }, { status: 404 });

  const period = await prisma.accountingPeriod.findUnique({
    where: { companyId_year_month: { companyId, year: entry.year, month: entry.month } },
    select: { status: true },
  });
  if (period?.status === "CLOSED") {
    return NextResponse.json({ error: "El periodo está cerrado (ejercicio bloqueado)." }, { status: 409 });
  }

  const del = await prisma.accountingEntry.deleteMany({
    where: { companyId, fuente: "MANUAL", referenciaTipo: "POLIZA", referencia },
  });

  registrarBitacora({
    accion: "contabilidad.poliza-manual.borrar",
    userId: user.id,
    companyId,
    entidad: "AccountingEntry",
    entidadId: referencia,
    detalle: { lineas: del.count, concepto: entry.descripcion },
  });
  return NextResponse.json({ ok: true, eliminadas: del.count });
});
