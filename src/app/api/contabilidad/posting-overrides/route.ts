import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { coberturaPlanPropio } from "@/lib/contabilidad/resolver-plan-propio";
import { COE_CODES } from "@/lib/contabilidad/catalog";
import { CODIGO_AGRUPADOR_OFICIAL } from "@/lib/contabilidad/codigo-agrupador";
import { PREFIJO_REGLA_SERIE } from "@/lib/contabilidad/serie-cuenta";

// ─────────────────────────────────────────────────────────────────────────────
// La cola de ambigüedades del plan propio (brief UX, módulo P1-4): los códigos
// que el motor emite contra el catálogo del contador. Hasta hoy los overrides
// se escribían por script; esta ruta los vuelve decisiones de un clic.
//
// PostingCuentaOverride la comparten DOS subsistemas: los overrides de
// agrupador que vive aquí (codigoMotor = código del motor, «601.48») y las
// reglas de SERIE del satélite Automotriz (codigoMotor = «serie:NCA» →
// mapean por serie de folio, no por código SAT; ver lib/contabilidad/
// serie-cuenta.ts). El GET nunca las ve —sólo recorre COE_CODES— y la
// escritura las RECHAZA de forma explícita: son otra cosa y se administran
// desde su propio lado.
//
// GET    ?companyId=            → { cobertura, cuentas } — cobertura de cada
//                                 código del motor (única / override / ambigua /
//                                 sin_candidata) con el nombre oficial del
//                                 agrupador, y el catálogo propio completo
//                                 (id + codAgrup) para elegir candidatas.
// POST   { companyId, codigoMotor, chartAccountId } → upsert del override.
// DELETE ?companyId=&codigoMotor=                   → quita el override.
//
// El override NO re-postea por sí solo: aplica en el siguiente posteo del
// mes (la UI lo dice y liga al Cierre).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId") ?? "";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const [cobertura, cuentas] = await Promise.all([
    coberturaPlanPropio(companyId, Object.values(COE_CODES)),
    prisma.chartAccount.findMany({
      where: { companyId, isActive: true },
      select: {
        id: true,
        cuentaSAT: true,
        subcuenta: true,
        nombre: true,
        nivel: true,
        tipo: true,
        codAgrup: true,
      },
      orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
    }),
  ]);

  return NextResponse.json({
    cobertura: cobertura.map((c) => ({
      ...c,
      nombreAgrupador: CODIGO_AGRUPADOR_OFICIAL[c.codigoMotor] ?? null,
    })),
    cuentas: cuentas.map((a) => ({
      id: a.id,
      codigo: a.subcuenta ?? a.cuentaSAT,
      nombre: a.nombre,
      nivel: a.nivel,
      tipo: a.tipo,
      codAgrup: a.codAgrup,
    })),
  });
});

const postSchema = z.object({
  companyId: z.string().min(1),
  codigoMotor: z.string().min(1),
  chartAccountId: z.string().min(1),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "companyId, codigoMotor y chartAccountId requeridos" },
      { status: 400 }
    );
  }
  const { companyId, codigoMotor, chartAccountId } = parsed.data;
  if (codigoMotor.startsWith(PREFIJO_REGLA_SERIE)) {
    return NextResponse.json(
      {
        error:
          "Ese código es una regla de SERIE, no un override de agrupador: se administra desde el módulo que la define, no desde el catálogo.",
      },
      { status: 400 }
    );
  }
  const { user } = await requireWriter(companyId, req);

  const cuenta = await prisma.chartAccount.findFirst({
    where: { id: chartAccountId, companyId, isActive: true },
    select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true },
  });
  if (!cuenta) {
    return NextResponse.json(
      { error: "La cuenta no existe, no es de esta empresa o está inactiva" },
      { status: 404 }
    );
  }

  await prisma.postingCuentaOverride.upsert({
    where: { companyId_codigoMotor: { companyId, codigoMotor } },
    create: { companyId, codigoMotor, chartAccountId },
    update: { chartAccountId },
  });

  registrarBitacora({
    accion: "contabilidad.posting-override.guardar",
    userId: user.id,
    companyId,
    entidad: "PostingCuentaOverride",
    entidadId: codigoMotor,
    detalle: { codigoMotor, cuenta: cuenta.subcuenta ?? cuenta.cuentaSAT, nombre: cuenta.nombre },
  });

  return NextResponse.json({
    ok: true,
    codigoMotor,
    cuenta: { codigo: cuenta.subcuenta ?? cuenta.cuentaSAT, nombre: cuenta.nombre },
  });
});

export const DELETE = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId") ?? "";
  const codigoMotor = url.searchParams.get("codigoMotor") ?? "";
  if (!companyId || !codigoMotor) {
    return NextResponse.json({ error: "companyId y codigoMotor requeridos" }, { status: 400 });
  }
  if (codigoMotor.startsWith(PREFIJO_REGLA_SERIE)) {
    return NextResponse.json(
      {
        error:
          "Ese código es una regla de SERIE, no un override de agrupador: se administra desde el módulo que la define, no desde el catálogo.",
      },
      { status: 400 }
    );
  }
  const { user } = await requireWriter(companyId, req);

  const existente = await prisma.postingCuentaOverride.findUnique({
    where: { companyId_codigoMotor: { companyId, codigoMotor } },
  });
  if (!existente) {
    return NextResponse.json({ error: "No hay override para ese código" }, { status: 404 });
  }
  await prisma.postingCuentaOverride.delete({
    where: { companyId_codigoMotor: { companyId, codigoMotor } },
  });

  registrarBitacora({
    accion: "contabilidad.posting-override.quitar",
    userId: user.id,
    companyId,
    entidad: "PostingCuentaOverride",
    entidadId: codigoMotor,
    detalle: { codigoMotor },
  });

  return NextResponse.json({ ok: true });
});
