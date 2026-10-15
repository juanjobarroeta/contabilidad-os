/**
 * GET /api/hospital/ayuda/exportar?d=…&t=…
 * El Excel de lo que la mascota consultó (lib/hospital/ayuda/exportar). El
 * enlace va firmado (24 h) y atado a la empresa y al usuario; se vuelven a
 * revisar su membresía y sus páginas al bajarlo.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ejecutarHerramienta } from "@/lib/hospital/ayuda/herramientas";
import { NOMBRE_ARCHIVO, leerExportacion, xlsxDeResultado } from "@/lib/hospital/ayuda/exportar";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const e = leerExportacion(searchParams.get("d"), searchParams.get("t"));
  if (!e) return NextResponse.json({ error: "El enlace no es válido o ya venció; pídeselo otra vez a la mascota." }, { status: 403 });
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: e.userId, companyId: e.companyId } },
    select: { hospitalPaginas: true },
  });
  if (!member) return NextResponse.json({ error: "Ya no tienes acceso a esta empresa." }, { status: 403 });
  const r = await ejecutarHerramienta(prisma, { companyId: e.companyId, paginas: member.hospitalPaginas ?? [] }, e.herramienta, e.parametros, { completo: true });
  if (r.sinPermiso) return NextResponse.json({ error: String(r.mensaje ?? "Sin permiso") }, { status: 403 });
  if (r.error) return NextResponse.json({ error: String(r.error) }, { status: 400 });
  const archivo = `${NOMBRE_ARCHIVO[e.herramienta] ?? "consulta"}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(xlsxDeResultado(r)), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${archivo}"`,
      "Cache-Control": "no-store",
    },
  });
}
