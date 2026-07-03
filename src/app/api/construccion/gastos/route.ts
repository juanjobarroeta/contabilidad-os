/**
 * GET  /api/construccion/gastos?companyId=... [&proyectoId=...] [&estado=...]
 *        [&caja=true]
 * POST /api/construccion/gastos
 *
 * Katia's field-expense workflow. Lightweight alternative to SolicitudCompra
 * for the WhatsApp-driven spending Rosy does every week. See the Gasto
 * schema comment for the why.
 *
 * POST body:
 *   {
 *     proyectoId, bankAccountId,
 *     beneficiarioNombre, descripcion, importe,
 *     presupuestoPartidaId?, insumoId?,
 *     comprobanteUrl?, notas?, caja?
 *   }
 * Returns the created Gasto in PENDIENTE state.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const createSchema = z.object({
  proyectoId: z.string().min(1),
  // Opcional: la cuenta real se determina en la conciliación (CFDI ↔ movimiento
  // importado). Se sigue aceptando para caja chica / datos históricos.
  bankAccountId: z.string().min(1).nullable().optional(),
  beneficiarioNombre: z.string().min(1).max(200),
  descripcion: z.string().min(1).max(500),
  importe: z.number().positive(),
  presupuestoPartidaId: z.string().min(1).nullable().optional(),
  insumoId: z.string().min(1).nullable().optional(),
  comprobanteUrl: z.string().max(1000).nullable().optional(),
  // Direct file attachment (base64). Served back via /comprobante endpoint.
  comprobanteData: z.string().nullable().optional(),
  comprobanteMime: z.string().max(80).nullable().optional(),
  comprobanteName: z.string().max(200).nullable().optional(),
  notas: z.string().max(1000).nullable().optional(),
  caja: z.boolean().optional(),
  // Indirecto = overhead / costo indirecto. See Gasto schema comment.
  indirecto: z.boolean().optional(),
  categoriaIndirecto: z.string().max(40).nullable().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const proyectoId = url.searchParams.get("proyectoId");
  const estado = url.searchParams.get("estado");
  const cajaOnly = url.searchParams.get("caja") === "true";

  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const gastos = await prisma.gasto.findMany({
    where: {
      companyId,
      ...(proyectoId ? { proyectoId } : {}),
      ...(estado ? { estado: estado as "PENDIENTE" | "APROBADO" | "PAGADO" | "RECHAZADO" } : {}),
      ...(cajaOnly ? { caja: true } : {}),
    },
    // Explicitly omit comprobanteData / pagoComprobanteData — they can be
    // megabytes each, and the list view only needs the name+mime to
    // render the "📎" link. The full bytes stream via /comprobante on demand.
    omit: { comprobanteData: true, pagoComprobanteData: true },
    include: {
      proyecto: { select: { id: true, codigo: true, nombre: true } },
      bankAccount: { select: { id: true, banco: true, nombre: true, tipo: true, titular: true } },
      presupuestoPartida: {
        select: {
          id: true,
          codigo: true,
          concepto: { select: { codigo: true, descripcion: true, unidad: true } },
        },
      },
      insumo: { select: { id: true, codigo: true, descripcion: true, unidad: true, costoActual: true } },
      bankTransaction: { select: { id: true, fecha: true, referencia: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(gastos);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const proyecto = await prisma.proyecto.findUnique({
    where: { id: parsed.data.proyectoId },
    select: { companyId: true },
  });
  if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
  await requireWriter(proyecto.companyId, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION");

  // Validate bank account belongs to same company (only when provided — the
  // account is optional now; conciliación resolves the real one later).
  let account: { id: string; companyId: string; tipo: string } | null = null;
  if (parsed.data.bankAccountId) {
    account = await prisma.bankAccount.findUnique({
      where: { id: parsed.data.bankAccountId },
      select: { id: true, companyId: true, tipo: true },
    });
    if (!account || account.companyId !== proyecto.companyId) {
      return NextResponse.json({ error: "BankAccount inválido" }, { status: 400 });
    }
  }

  // If insumo/partida provided, validate they belong to the same company
  if (parsed.data.presupuestoPartidaId) {
    const pp = await prisma.presupuestoPartida.findUnique({
      where: { id: parsed.data.presupuestoPartidaId },
      select: { presupuesto: { select: { companyId: true } } },
    });
    if (!pp || pp.presupuesto.companyId !== proyecto.companyId) {
      return NextResponse.json({ error: "presupuestoPartidaId inválido" }, { status: 400 });
    }
  }
  if (parsed.data.insumoId) {
    const ins = await prisma.insumo.findUnique({
      where: { id: parsed.data.insumoId },
      select: { companyId: true },
    });
    if (!ins || ins.companyId !== proyecto.companyId) {
      return NextResponse.json({ error: "insumoId inválido" }, { status: 400 });
    }
  }

  // Auto-detect caja flag from account type if not provided
  const caja =
    parsed.data.caja !== undefined
      ? parsed.data.caja
      : account?.tipo === "CAJA";

  const created = await prisma.gasto.create({
    data: {
      companyId: proyecto.companyId,
      proyectoId: parsed.data.proyectoId,
      bankAccountId: parsed.data.bankAccountId ?? null,
      beneficiarioNombre: parsed.data.beneficiarioNombre,
      descripcion: parsed.data.descripcion,
      importe: parsed.data.importe,
      presupuestoPartidaId: parsed.data.presupuestoPartidaId ?? null,
      insumoId: parsed.data.insumoId ?? null,
      comprobanteUrl: parsed.data.comprobanteUrl ?? null,
      comprobanteData: parsed.data.comprobanteData ?? null,
      comprobanteMime: parsed.data.comprobanteMime ?? null,
      comprobanteName: parsed.data.comprobanteName ?? null,
      notas: parsed.data.notas ?? null,
      caja,
      indirecto: parsed.data.indirecto ?? false,
      categoriaIndirecto: parsed.data.categoriaIndirecto ?? null,
    },
    include: {
      bankAccount: { select: { id: true, banco: true, nombre: true, tipo: true, titular: true } },
      presupuestoPartida: {
        select: {
          id: true,
          codigo: true,
          concepto: { select: { codigo: true, descripcion: true } },
        },
      },
      insumo: { select: { id: true, codigo: true, descripcion: true } },
    },
  });

  return NextResponse.json(created, { status: 201 });
});
