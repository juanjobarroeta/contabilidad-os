import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireUser } from "@/lib/authz";
import { validarCurp, validarNss, validarRfc } from "@/lib/fiscal/verificador/estructura";
import { consultar69b } from "@/lib/fiscal/verificador/lista69b";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/verificador?rfc=… | curp=… | nss=…
//
// El Verificador: valida ESTRUCTURA (formato + dígito verificador oficial) de
// RFC/CURP/NSS, y para RFC además:
//   - lista 69-B del SAT (EFOS presuntos/definitivos), cacheada 12 h;
//   - lo que TU cartera ya sabe de ese RFC (clientes, empleados y empresas de
//     las compañías donde el usuario tiene membresía — nunca de otras).
// Cualquier usuario con sesión puede consultar; cada consulta deja bitácora.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

/** Empresas visibles para el usuario: membresías directas + las del despacho
 *  (cualquier rol) + todas si es operador de plataforma. */
async function companyIdsVisibles(userId: string): Promise<string[] | "TODAS"> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { esOperador: true } });
  if (u?.esOperador) return "TODAS";
  const [directas, despachos] = await Promise.all([
    prisma.companyMember.findMany({ where: { userId }, select: { companyId: true } }),
    prisma.despachoMember.findMany({ where: { userId }, select: { despachoId: true } }),
  ]);
  const ids = new Set(directas.map((m) => m.companyId));
  if (despachos.length > 0) {
    const delDespacho = await prisma.company.findMany({
      where: { despachoId: { in: despachos.map((d) => d.despachoId) } },
      select: { id: true },
    });
    for (const c of delDespacho) ids.add(c.id);
  }
  return Array.from(ids);
}

type Conocido = {
  origen: "EMPRESA" | "CLIENTE" | "EMPLEADO";
  nombre: string;
  /** Razón social de la empresa donde lo conocemos (null si es la empresa misma). */
  empresa: string | null;
  codigoPostal: string | null;
  regimenFiscal: string | null;
};

async function conocidosDeRfc(rfc: string, visibles: string[] | "TODAS"): Promise<Conocido[]> {
  const scope = visibles === "TODAS" ? {} : { companyId: { in: visibles } };
  const scopeEmpresa = visibles === "TODAS" ? {} : { id: { in: visibles } };
  const [empresas, clientes, empleados] = await Promise.all([
    prisma.company.findMany({
      where: { rfc, ...scopeEmpresa },
      select: { razonSocial: true, codigoPostal: true, regimenFiscal: true },
      take: 3,
    }),
    prisma.customer.findMany({
      where: { rfc, ...scope },
      select: {
        razonSocial: true,
        codigoPostal: true,
        regimenFiscal: true,
        company: { select: { razonSocial: true } },
      },
      take: 5,
    }),
    prisma.employee.findMany({
      where: { rfc, ...scope },
      select: {
        nombre: true,
        apellidoPaterno: true,
        apellidoMaterno: true,
        codigoPostal: true,
        company: { select: { razonSocial: true } },
      },
      take: 5,
    }),
  ]);
  return [
    ...empresas.map((e): Conocido => ({
      origen: "EMPRESA",
      nombre: e.razonSocial,
      empresa: null,
      codigoPostal: e.codigoPostal ?? null,
      regimenFiscal: e.regimenFiscal ?? null,
    })),
    ...clientes.map((c): Conocido => ({
      origen: "CLIENTE",
      nombre: c.razonSocial,
      empresa: c.company.razonSocial,
      codigoPostal: c.codigoPostal ?? null,
      regimenFiscal: c.regimenFiscal ?? null,
    })),
    ...empleados.map((e): Conocido => ({
      origen: "EMPLEADO",
      nombre: [e.nombre, e.apellidoPaterno, e.apellidoMaterno].filter(Boolean).join(" "),
      empresa: e.company.razonSocial,
      codigoPostal: e.codigoPostal ?? null,
      regimenFiscal: null,
    })),
  ];
}

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    const status = e instanceof AuthzError ? e.status : 401;
    return NextResponse.json({ error: "No autorizado" }, { status });
  }

  const url = new URL(req.url);
  const rfc = url.searchParams.get("rfc");
  const curp = url.searchParams.get("curp");
  const nss = url.searchParams.get("nss");

  const bitacora = (tipo: string, valor: string) =>
    registrarBitacora({
      companyId: null,
      userId: user.id,
      actorEmail: user.email ?? null,
      accion: "verificador.consulta",
      entidad: "Verificador",
      detalle: { tipo, valor },
      req,
    });

  if (curp) {
    bitacora("CURP", curp.trim().toUpperCase());
    return NextResponse.json({ tipo: "CURP", estructura: validarCurp(curp) });
  }
  if (nss) {
    bitacora("NSS", nss.trim());
    return NextResponse.json({ tipo: "NSS", estructura: validarNss(nss) });
  }
  if (!rfc) {
    return NextResponse.json({ error: "Indica rfc, curp o nss" }, { status: 400 });
  }

  const estructura = validarRfc(rfc);
  bitacora("RFC", estructura.valor);

  // 69-B y cartera sólo con un RFC bien formado (sobre un dedazo no informan).
  if (!estructura.formatoValido) {
    return NextResponse.json({ tipo: "RFC", estructura, lista69b: null, conocidos: [] });
  }

  const visibles = await companyIdsVisibles(user.id);
  const [lista69b, conocidos] = await Promise.all([
    consultar69b(estructura.valor).catch((e) => ({
      error: e instanceof Error ? e.message : "No se pudo consultar la lista 69-B",
    })),
    conocidosDeRfc(estructura.valor, visibles),
  ]);

  return NextResponse.json({ tipo: "RFC", estructura, lista69b, conocidos });
}
