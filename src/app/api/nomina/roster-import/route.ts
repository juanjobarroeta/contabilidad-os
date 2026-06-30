import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { detectarRosterDesdeCfdis } from "@/lib/nomina/roster-import";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap del roster de nómina desde los CFDIs de nómina propios.
//
// GET  /api/nomina/roster-import?companyId=xxx
//   Devuelve el roster SUGERIDO (sólo lectura) reconstruido del complemento de
//   nómina de los recibos timbrados por la empresa, con conteos de cobertura.
//
// POST /api/nomina/roster-import
//   Crea Employee para los RFCs SELECCIONADOS por el usuario. Idempotente:
//   omite los RFCs que ya existen. Nada se crea sin confirmación explícita.
//
// Permisos: roles que pueden gestionar nómina (todo menos VIEWER).
// ─────────────────────────────────────────────────────────────────────────────

async function requireNominaWriter(companyId: string, userId: string) {
  const member = await getEffectiveCompanyMembership(userId, companyId);
  if (!member) return { error: "Sin acceso a esta empresa", status: 403 as const };
  if (member.role === "VIEWER")
    return { error: "Sin permisos para gestionar la nómina", status: 403 as const };
  return { member };
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const guard = await requireNominaWriter(companyId, session.user.id);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const result = await detectarRosterDesdeCfdis(companyId, new Date(), prisma);
  return NextResponse.json(result);
}

// Cada empleado seleccionado: el usuario pudo editar nombre y salario; estado
// viene del clasificador. CLABE/banco se dejan en null (dispersión se configura
// después).
const seleccionadoSchema = z.object({
  rfc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/, "RFC inválido"),
  nombre: z.string().trim().min(1, "Nombre requerido"),
  apellidoPaterno: z.string().trim().min(1, "Apellido paterno requerido"),
  apellidoMaterno: z.string().trim().optional().nullable(),
  curp: z.string().trim().toUpperCase().optional().nullable(),
  nss: z.string().trim().optional().nullable(),
  fechaIngreso: z.string().optional().nullable(),
  tipoContrato: z.string().optional().nullable(),
  tipoRegimen: z.string().optional().nullable(),
  puesto: z.string().optional().nullable(),
  departamento: z.string().optional().nullable(),
  riesgoPuesto: z.string().optional().nullable(),
  periodicidadPago: z.string().optional().nullable(),
  salarioDiario: z.number().positive("El salario diario debe ser mayor a 0"),
  salarioDiarioIntegrado: z.number().positive().optional().nullable(),
  estado: z.enum(["ACTIVO", "PROBABLE_BAJA", "BAJA"]),
});

const importSchema = z.object({
  companyId: z.string().min(1),
  empleados: z.array(seleccionadoSchema).min(1, "Selecciona al menos un empleado"),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = importSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 }
    );
  }
  const { companyId, empleados } = parsed.data;

  const guard = await requireNominaWriter(companyId, session.user.id);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  // Idempotencia: omite los RFCs que ya existen como Employee en esta empresa.
  const existentes = await prisma.employee.findMany({
    where: { companyId },
    select: { rfc: true },
  });
  const yaExisten = new Set(existentes.map((e) => e.rfc.toUpperCase()));

  const creados: { rfc: string; nombre: string; id: string }[] = [];
  const omitidos: string[] = [];

  for (const e of empleados) {
    if (yaExisten.has(e.rfc)) {
      omitidos.push(e.rfc);
      continue;
    }

    const sdi =
      e.salarioDiarioIntegrado && e.salarioDiarioIntegrado > 0
        ? e.salarioDiarioIntegrado
        : +(e.salarioDiario * 1.0452).toFixed(2);

    // CURP/NSS pueden faltar en recibos viejos; el modelo los exige como string,
    // así que guardamos cadena vacía cuando no los hay (el usuario los completa
    // luego en el roster). isActive se deriva del estado clasificado.
    const created = await prisma.employee.create({
      data: {
        companyId,
        nombre: e.nombre,
        apellidoPaterno: e.apellidoPaterno,
        apellidoMaterno: e.apellidoMaterno?.trim() || null,
        rfc: e.rfc,
        curp: e.curp?.trim() || "",
        nss: e.nss?.trim() || "",
        fechaIngreso: e.fechaIngreso ? new Date(e.fechaIngreso) : new Date(),
        isActive: e.estado === "ACTIVO",
        fechaBaja: e.estado === "BAJA" ? new Date() : null,
        tipoContrato: e.tipoContrato || "01",
        tipoJornada: "01",
        tipoRegimen: e.tipoRegimen || "02",
        salarioDiario: e.salarioDiario,
        salarioDiarioIntegrado: sdi,
        periodicidadPago: e.periodicidadPago || "04",
        departamento: e.departamento?.trim() || null,
        puesto: e.puesto?.trim() || null,
        riesgoPuesto: e.riesgoPuesto || "1",
        // CLABE/banco se agregan después para la dispersión SPEI.
        clabe: null,
        banco: null,
      },
    });

    yaExisten.add(e.rfc); // evita duplicados dentro del mismo lote
    creados.push({ rfc: e.rfc, nombre: `${e.nombre} ${e.apellidoPaterno}`, id: created.id });

    // numEmpleado por defecto: últimos 6 del id.
    await prisma.employee.update({
      where: { id: created.id },
      data: { numEmpleado: created.id.slice(-6).toUpperCase() },
    });
  }

  return NextResponse.json({
    ok: true,
    creados: creados.length,
    omitidos: omitidos.length,
    empleados: creados,
    rfcsOmitidos: omitidos,
  });
}
