import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { puedeLigarCfdi } from "@/lib/hospital/ligado-permisos";
import { listarLineas, religarPendientes } from "@/lib/hospital/cfdi-ligado";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hospital/compras/por-ligar?companyId=…[&estado=POR_LIGAR|LIGADA|IGNORADA][&q=…][&page=0]
//
// Renglones de CFDIs de compra frente al catálogo físico (lib/hospital/
// cfdi-ligado). Default: la cola POR_LIGAR, con hasta tres sugerencias del
// catálogo por renglón. Antes de listar la primera página de la cola reintenta
// lo barato (facturas que ya se ligaron a su orden, claves ya aprendidas).
// `puedeLigar` dice si el usuario ve los botones (PATCH …/por-ligar/[id]).
// ─────────────────────────────────────────────────────────────────────────────

const ESTADOS = new Set(["POR_LIGAR", "LIGADA", "IGNORADA"]);

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const { user, membership } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const estadoParam = (searchParams.get("estado") ?? "POR_LIGAR").toUpperCase();
  const estado = estadoParam === "TODAS" ? undefined : ESTADOS.has(estadoParam) ? estadoParam : "POR_LIGAR";
  const page = Math.max(parseInt(searchParams.get("page") ?? "0", 10) || 0, 0);
  const q = searchParams.get("q") ?? "";

  if (estado === "POR_LIGAR" && page === 0 && !q) {
    try {
      await religarPendientes(prisma, companyId);
    } catch (e) {
      console.error("[hospital/compras/por-ligar] reintento de la cola falló:", e);
    }
  }

  const r = await listarLineas(prisma, companyId, { estado, q, page });
  return NextResponse.json({ ...r, estado: estado ?? "TODAS", puedeLigar: await puedeLigarCfdi(companyId, user.id, membership.role) });
});
