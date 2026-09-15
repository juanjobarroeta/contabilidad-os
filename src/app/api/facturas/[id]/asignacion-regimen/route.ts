import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  REGIMEN_LABELS,
  type CompanyRegimenPeriodRow,
} from "@/lib/fiscal/regimen-capabilities";
import {
  invoiceRegimenPeriodContext,
  validateInvoiceRegimenAllocations,
} from "@/lib/fiscal/regimen-allocation";

const ASSIGNABLE_INVOICE_TYPES = new Set(["INGRESO", "EGRESO"]);
const MAX_NOTE_LENGTH = 500;

class RevisionConflictError extends Error {
  constructor() {
    super("La asignación cambió desde que la abriste.");
    this.name = "RevisionConflictError";
  }
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

async function loadInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      tipo: true,
      fecha: true,
      serie: true,
      folio: true,
      uuid: true,
      company: {
        select: {
          regimenFiscal: true,
          regimenes: {
            select: { code: true, since: true, endedAt: true, active: true },
          },
        },
      },
      regimenAssignment: {
        include: {
          allocations: { orderBy: { regimenCode: "asc" } },
        },
      },
    },
  });
}

function invoiceContext(invoice: {
  fecha: Date;
  company: {
    regimenFiscal: string | null;
    regimenes: CompanyRegimenPeriodRow[];
  };
}) {
  return invoiceRegimenPeriodContext({
    fecha: invoice.fecha,
    regimenFiscal: invoice.company.regimenFiscal,
    regimenes: invoice.company.regimenes,
  });
}

function serializeInvoiceAssignment(invoice: NonNullable<Awaited<ReturnType<typeof loadInvoice>>>) {
  const context = invoiceContext(invoice);
  if (!context) throw new Error("La factura tiene una fecha inválida.");

  const assignment = invoice.regimenAssignment;
  const validation = assignment
    ? validateInvoiceRegimenAllocations({
        effectiveRegimenCodes: context.regimenCodes,
        allocations: assignment.allocations,
      })
    : null;

  return {
    invoice: {
      id: invoice.id,
      tipo: invoice.tipo,
      fecha: invoice.fecha.toISOString(),
      serie: invoice.serie,
      folio: invoice.folio,
      uuid: invoice.uuid,
    },
    periodo: context.periodo,
    asignable: ASSIGNABLE_INVOICE_TYPES.has(invoice.tipo),
    regimenesDisponibles: context.regimenCodes.map((code) => ({
      code,
      label: REGIMEN_LABELS[code] ?? null,
    })),
    estado: !assignment
      ? "SIN_ASIGNAR"
      : validation?.ok
        ? "COMPLETA"
        : "REQUIERE_REVISION",
    ...(validation && !validation.ok
      ? { observacion: { code: validation.code, error: validation.error } }
      : {}),
    asignacion: assignment
      ? {
          revision: assignment.revision,
          reviewedById: assignment.reviewedById,
          reviewedByEmail: assignment.reviewedByEmail,
          reviewedAt: assignment.reviewedAt.toISOString(),
          note: assignment.note,
          allocations: assignment.allocations.map((allocation) => ({
            regimenCode: allocation.regimenCode,
            basisPoints: allocation.basisPoints,
            porcentaje: allocation.basisPoints / 100,
          })),
        }
      : null,
    // This endpoint deliberately establishes evidence only. Removing this flag
    // requires the separate mixed-regime composition engine and its fiscal QA.
    usadaEnCalculoAutomatico: false,
  };
}

async function conflictResponse(invoiceId: string) {
  const current = await prisma.invoiceRegimenAssignment.findUnique({
    where: { invoiceId },
    select: { revision: true },
  });
  return NextResponse.json(
    {
      code: "REVISION_CONFLICT",
      error: "La asignación cambió desde que la abriste. Recárgala antes de guardar.",
      currentRevision: current?.revision ?? 0,
    },
    { status: 409 },
  );
}

// GET /api/facturas/[id]/asignacion-regimen
// Reads the effective regimes for the invoice month and its current reviewed
// attribution. VIEWER may inspect it; writes require an accountant-capable role.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const invoice = await loadInvoice(id);
  if (!invoice) {
    return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  return NextResponse.json(serializeInvoiceAssignment(invoice));
}

// PUT /api/facturas/[id]/asignacion-regimen
// Full, optimistic-concurrency replacement. Body:
// { expectedRevision: 0|n, allocations: [{ regimenCode, basisPoints }], note? }
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? null;

  const { id } = await params;
  const invoice = await loadInvoice(id);
  if (!invoice) {
    return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
  }

  const member = await getEffectiveCompanyMembership(userId, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  if (!ASSIGNABLE_INVOICE_TYPES.has(invoice.tipo)) {
    return NextResponse.json(
      {
        code: "INVOICE_TYPE_NOT_ASSIGNABLE",
        error: "Sólo los CFDI de ingreso o egreso se asignan a un régimen para ISR.",
      },
      { status: 422 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const expectedRevision = (body as { expectedRevision?: unknown }).expectedRevision;
  if (
    typeof expectedRevision !== "number"
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
  ) {
    return NextResponse.json(
      { error: "expectedRevision debe ser un entero mayor o igual a cero." },
      { status: 400 },
    );
  }

  const noteValue = (body as { note?: unknown }).note;
  if (
    noteValue !== undefined
    && noteValue !== null
    && (typeof noteValue !== "string" || noteValue.trim().length > MAX_NOTE_LENGTH)
  ) {
    return NextResponse.json(
      { error: `note debe ser texto de hasta ${MAX_NOTE_LENGTH} caracteres.` },
      { status: 400 },
    );
  }
  const note = typeof noteValue === "string" && noteValue.trim()
    ? noteValue.trim()
    : null;

  const rawAllocations = (body as { allocations?: unknown }).allocations;
  if (!Array.isArray(rawAllocations)) {
    return NextResponse.json({ error: "allocations debe ser un arreglo." }, { status: 400 });
  }

  const context = invoiceContext(invoice);
  if (!context) {
    return NextResponse.json({ error: "La factura tiene una fecha inválida." }, { status: 422 });
  }
  const validation = validateInvoiceRegimenAllocations({
    effectiveRegimenCodes: context.regimenCodes,
    allocations: rawAllocations,
  });
  if (!validation.ok) {
    return NextResponse.json(
      { code: validation.code, error: validation.error },
      { status: 422 },
    );
  }

  const reviewedAt = new Date();
  const reviewedByEmail = userEmail;
  try {
    await prisma.$transaction(async (tx) => {
      if (expectedRevision === 0) {
        await tx.invoiceRegimenAssignment.create({
          data: {
            invoiceId: invoice.id,
            revision: 1,
            reviewedById: userId,
            reviewedByEmail,
            reviewedAt,
            note,
            allocations: {
              create: validation.allocations,
            },
          },
        });
        return;
      }

      const updated = await tx.invoiceRegimenAssignment.updateMany({
        where: { invoiceId: invoice.id, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          reviewedById: userId,
          reviewedByEmail,
          reviewedAt,
          note,
        },
      });
      if (updated.count !== 1) throw new RevisionConflictError();

      await tx.invoiceRegimenAllocation.deleteMany({
        where: { assignment: { invoiceId: invoice.id } },
      });
      const assignment = await tx.invoiceRegimenAssignment.findUniqueOrThrow({
        where: { invoiceId: invoice.id },
        select: { id: true },
      });
      await tx.invoiceRegimenAllocation.createMany({
        data: validation.allocations.map((allocation) => ({
          assignmentId: assignment.id,
          ...allocation,
        })),
      });
    });
  } catch (error) {
    if (error instanceof RevisionConflictError || hasPrismaCode(error, "P2002")) {
      return conflictResponse(invoice.id);
    }
    console.error("[asignacion-regimen] no se pudo guardar:", error);
    return NextResponse.json({ error: "No se pudo guardar la asignación." }, { status: 500 });
  }

  registrarBitacora({
    companyId: invoice.companyId,
    userId,
    actorEmail: reviewedByEmail,
    accion: "factura.asignar-regimen",
    entidad: "Invoice",
    entidadId: invoice.id,
    detalle: {
      periodo: context.periodo,
      revisionAnterior: expectedRevision,
      revisionNueva: expectedRevision + 1,
      allocations: validation.allocations.map(({ regimenCode, basisPoints }) => ({
        regimenCode,
        basisPoints,
      })),
    },
    req,
  });

  const updatedInvoice = await loadInvoice(invoice.id);
  if (!updatedInvoice) {
    return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
  }
  return NextResponse.json(serializeInvoiceAssignment(updatedInvoice));
}

// DELETE removes a wrong current attribution. It deliberately returns the
// invoice to SIN_ASIGNAR, so every calculation remains fail-closed.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await loadInvoice(id);
  if (!invoice) {
    return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const expectedRevision = body && typeof body === "object"
    ? (body as { expectedRevision?: unknown }).expectedRevision
    : undefined;
  if (
    typeof expectedRevision !== "number"
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 1
  ) {
    return NextResponse.json(
      { error: "expectedRevision debe ser un entero mayor o igual a uno." },
      { status: 400 },
    );
  }

  const deleted = await prisma.invoiceRegimenAssignment.deleteMany({
    where: { invoiceId: invoice.id, revision: expectedRevision },
  });
  if (deleted.count !== 1) return conflictResponse(invoice.id);

  registrarBitacora({
    companyId: invoice.companyId,
    userId: session.user.id,
    actorEmail: session.user.email ?? null,
    accion: "factura.quitar-asignacion-regimen",
    entidad: "Invoice",
    entidadId: invoice.id,
    detalle: { revisionEliminada: expectedRevision },
    req,
  });

  const updatedInvoice = await loadInvoice(invoice.id);
  if (!updatedInvoice) {
    return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
  }
  return NextResponse.json(serializeInvoiceAssignment(updatedInvoice));
}
