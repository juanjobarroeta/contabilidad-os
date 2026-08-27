import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, empresasAccesiblesIds, requireUser } from "@/lib/authz";
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

type Conocido = {
  origen: "EMPRESA" | "CLIENTE" | "EMPLEADO";
  nombre: string;
  /** Razón social de la empresa donde lo conocemos (null si es la empresa misma). */
  empresa: string | null;
  codigoPostal: string | null;
  regimenFiscal: string | null;
  /** Identidad cruzada (como la muestra check.id): RFC/CURP/NSS conocidos. */
  rfc: string | null;
  curp: string | null;
  nss: string | null;
};

const EMPLEADO_SELECT = {
  nombre: true,
  apellidoPaterno: true,
  apellidoMaterno: true,
  rfc: true,
  curp: true,
  nss: true,
  codigoPostal: true,
  company: { select: { razonSocial: true } },
} as const;

type EmpleadoRow = {
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  rfc: string;
  curp: string;
  nss: string;
  codigoPostal: string | null;
  company: { razonSocial: string };
};

function empleadoAConocido(e: EmpleadoRow): Conocido {
  return {
    origen: "EMPLEADO",
    nombre: [e.nombre, e.apellidoPaterno, e.apellidoMaterno].filter(Boolean).join(" "),
    empresa: e.company.razonSocial,
    codigoPostal: e.codigoPostal ?? null,
    regimenFiscal: null,
    rfc: e.rfc,
    curp: e.curp,
    nss: e.nss,
  };
}

async function conocidosDeRfc(rfc: string, visibles: string[]): Promise<Conocido[]> {
  const scope = { companyId: { in: visibles } };
  const scopeEmpresa = { id: { in: visibles } };
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
    prisma.employee.findMany({ where: { rfc, ...scope }, select: EMPLEADO_SELECT, take: 5 }),
  ]);
  return [
    ...empresas.map((e): Conocido => ({
      origen: "EMPRESA",
      nombre: e.razonSocial,
      empresa: null,
      codigoPostal: e.codigoPostal ?? null,
      regimenFiscal: e.regimenFiscal ?? null,
      rfc,
      curp: null,
      nss: null,
    })),
    ...clientes.map((c): Conocido => ({
      origen: "CLIENTE",
      nombre: c.razonSocial,
      empresa: c.company.razonSocial,
      codigoPostal: c.codigoPostal ?? null,
      regimenFiscal: c.regimenFiscal ?? null,
      rfc,
      curp: null,
      nss: null,
    })),
    ...empleados.map(empleadoAConocido),
  ];
}

/** Búsqueda INVERSA por CURP o NSS: sólo los empleados de la cartera los
 *  tienen capturados — devuelve a la persona con su RFC y demás identidad. */
async function conocidosDeEmpleado(
  campo: "curp" | "nss",
  valor: string,
  visibles: string[]
): Promise<Conocido[]> {
  const scope = { companyId: { in: visibles } };
  const empleados = await prisma.employee.findMany({
    where: { [campo]: valor, ...scope },
    select: EMPLEADO_SELECT,
    take: 5,
  });
  return empleados.map(empleadoAConocido);
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
    const estructura = validarCurp(curp);
    bitacora("CURP", estructura.valor);
    const conocidos = estructura.formatoValido
      ? await conocidosDeEmpleado("curp", estructura.valor, await empresasAccesiblesIds(user.id))
      : [];
    return NextResponse.json({ tipo: "CURP", estructura, conocidos });
  }
  if (nss) {
    const estructura = validarNss(nss);
    bitacora("NSS", estructura.valor);
    const conocidos = estructura.formatoValido
      ? await conocidosDeEmpleado("nss", estructura.valor, await empresasAccesiblesIds(user.id))
      : [];
    return NextResponse.json({ tipo: "NSS", estructura, conocidos });
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

  // Scoping canónico (P0-2): respeta DespachoMemberCompany; el operador
  // recibe la lista explícita de todas las empresas activas.
  const visibles = await empresasAccesiblesIds(user.id);
  const [lista69b, conocidos] = await Promise.all([
    consultar69b(estructura.valor).catch((e) => ({
      error: e instanceof Error ? e.message : "No se pudo consultar la lista 69-B",
    })),
    conocidosDeRfc(estructura.valor, visibles),
  ]);

  return NextResponse.json({ tipo: "RFC", estructura, lista69b, conocidos });
}
