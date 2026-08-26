import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// ─────────────────────────────────────────────────────────────────────────────
// Expediente documental del empleado.
//
// GET  /api/nomina/empleado/[id]/documentos          — lista SIN los bytes
// POST /api/nomina/empleado/[id]/documentos          — sube uno (JSON base64)
//
// El archivo viaja como base64 dentro de JSON y no como multipart porque el
// cliente del satélite (apiFetch) habla sólo JSON; un contrato de 5 MB son
// ~7 MB de base64, dentro de lo razonable. Los bytes viven en la BD (bytea),
// mismo patrón y mismo TODO-de-migrar-a-R2 que los acuses de declaración.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BYTES = 8 * 1024 * 1024;
// PDF, imágenes (fotos de contratos firmados) y XML (alta IMSS). Nada
// ejecutable: el download siempre sale como attachment, pero el allowlist
// evita guardar basura que nadie va a poder abrir.
const MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/xml",
  "text/xml",
]);

async function empleadoDe(id: string) {
  return prisma.employee.findUnique({
    where: { id },
    select: { id: true, companyId: true, nombre: true, apellidoPaterno: true },
  });
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const empleado = await empleadoDe(id);
    if (!empleado) return NextResponse.json({ error: "Empleado no encontrado" }, { status: 404 });
    await requireMembership(empleado.companyId, undefined, req);

    const documentos = await prisma.employeeDocumento.findMany({
      where: { employeeId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, tipo: true, nombre: true, mime: true, bytes: true, createdAt: true },
    });
    return NextResponse.json({ documentos });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const empleado = await empleadoDe(id);
    if (!empleado) return NextResponse.json({ error: "Empleado no encontrado" }, { status: 404 });
    const { user } = await requireWriter(empleado.companyId, req);

    const body = await req.json();
    const tipo = String(body.tipo ?? "OTRO").slice(0, 40);
    const nombre = String(body.nombre ?? "").slice(0, 200);
    const mime = String(body.mime ?? "");
    const base64 = String(body.base64 ?? "");

    if (!nombre || !base64) {
      return NextResponse.json({ error: "nombre y base64 requeridos" }, { status: 400 });
    }
    if (!MIMES.has(mime)) {
      return NextResponse.json(
        { error: "Formato no admitido — PDF, imagen (JPG/PNG/WebP) o XML." },
        { status: 415 }
      );
    }
    const archivo = Buffer.from(base64, "base64");
    if (archivo.length === 0) return NextResponse.json({ error: "Archivo vacío" }, { status: 400 });
    if (archivo.length > MAX_BYTES) {
      return NextResponse.json(
        { error: `El archivo pesa ${(archivo.length / 1048576).toFixed(1)} MB; el máximo es 8 MB.` },
        { status: 413 }
      );
    }

    const doc = await prisma.employeeDocumento.create({
      data: {
        companyId: empleado.companyId,
        employeeId: id,
        tipo,
        nombre,
        mime,
        bytes: archivo.length,
        archivo,
      },
      select: { id: true, tipo: true, nombre: true, mime: true, bytes: true, createdAt: true },
    });

    registrarBitacora({
      companyId: empleado.companyId,
      userId: user.id,
      actorEmail: user.email ?? null,
      accion: "nomina.expediente.subir",
      entidad: "EmployeeDocumento",
      entidadId: doc.id,
      detalle: { employeeId: id, tipo, nombre, bytes: archivo.length },
    });

    return NextResponse.json({ documento: doc }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
