import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";
import { corridaDe, iniciarCorrida } from "@/lib/fiscal/cumplimiento/syntage/backfill-operador";

export const dynamic = "force-dynamic";

// Operator-only, on-demand. Ingests a company's prior FILED monthly declaraciones
// from Syntage (downloads each acuse PDF, parses the IVA/ISR desglose via Claude,
// and stores IVA_MENSUAL + ISR_PROVISIONAL rows). That populates the CARRYOVER
// CHAIN the motor reads — `ISR pagado anterior` (sum of prior isrPagar) and the
// IVA `saldo a favor` — so the monthly calc matches what the accountant filed.
//
//   POST { companyId|rfc, maxAcuses? }  → arranca la corrida EN SEGUNDO PLANO y
//                                         responde 202 al instante.
//   GET  ?companyId=&year=              → estado de la corrida + cadena del año.
//
// Por qué en segundo plano: 9–12 acuses son 2–4 min de Claude; Safari móvil
// cortaba la conexión a los ~2.5 min y el operador nunca veía el resultado
// aunque la corrida siguiera. Ver backfill-operador.ts.
//
// Same engine + gap-fill as the cron, so re-running never duplicates. Costs
// ~1 Claude call per missing month → operator-gated. If Syntage lacks a
// company's prior acuses, nothing is created — upload the acuse manually.

const COMPANY_SELECT = { id: true, rfc: true, razonSocial: true } as const;

async function operadorAutorizado(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }
  return null;
}

/** Cadena de arrastre del año + nota, la misma forma que devolvía la versión síncrona. */
async function estadoDe(company: { id: string; rfc: string; razonSocial: string }, year: number) {
  const corrida = corridaDe(company.id);
  const decls = await prisma.taxDeclaration.findMany({
    where: {
      companyId: company.id,
      tipo: { in: ["ISR_PROVISIONAL", "IVA_MENSUAL"] },
      periodo: { startsWith: `${year}-` },
      status: { in: ["CALCULATED", "FILED", "PAID"] },
    },
    select: { tipo: true, periodo: true, isrPagar: true, ivaPagar: true, ivaSaldoFavor: true, status: true },
    orderBy: { periodo: "asc" },
  });
  const isr = decls.filter((d) => d.tipo === "ISR_PROVISIONAL");
  const iva = decls.filter((d) => d.tipo === "IVA_MENSUAL");

  const nota = !corrida
    ? "Sin corrida en curso. Pulsa «Ingresar declaraciones previas» para traer de Syntage lo que falte."
    : corrida.estado === "corriendo"
      ? `Leyendo acuses en segundo plano${corrida.ultimoPeriodo ? ` (último: ${corrida.ultimoPeriodo})` : ""}… puedes cerrar esta página; la corrida sigue.`
      : corrida.error
        ? "Syntage no devolvió datos para esta empresa — captura los acuses manualmente en Impuestos/cierre."
        : corrida.mesesCreados === 0
          ? "No se creó ningún mes nuevo (ya capturados, o Syntage no tiene esos acuses). Si faltan, súbelos en Impuestos/cierre."
          : corrida.topeAlcanzado
            ? "Meses ingresados hasta el tope de esta corrida. Vuelve a pulsar para traer el resto."
            : "Meses ingresados. Vuelve a calcular el periodo: ISR pagado anterior y saldo a favor ya deberían reflejar lo presentado.";

  return {
    ok: true,
    company,
    corrida,
    backfill: {
      mesesCreados: corrida?.mesesCreados ?? 0,
      acusesParseados: corrida?.acusesParseados ?? 0,
      topeAlcanzado: corrida?.topeAlcanzado ?? false,
      error: corrida?.error ?? null,
    },
    cadena: {
      year,
      isrProvisional: isr.map((d) => ({ periodo: d.periodo, isrPagar: d.isrPagar, status: d.status })),
      ivaMensual: iva.map((d) => ({ periodo: d.periodo, ivaPagar: d.ivaPagar, ivaSaldoFavor: d.ivaSaldoFavor, status: d.status })),
    },
    nota,
  };
}

export async function POST(req: Request) {
  const denegado = await operadorAutorizado();
  if (denegado) return denegado;

  const body = await req.json().catch(() => ({}));
  const company = body?.companyId
    ? await prisma.company.findUnique({ where: { id: String(body.companyId) }, select: COMPANY_SELECT })
    : body?.rfc
      ? await prisma.company.findFirst({ where: { rfc: { equals: String(body.rfc).trim(), mode: "insensitive" } }, select: COMPANY_SELECT })
      : null;
  if (!company) return NextResponse.json({ error: "Empresa no encontrada (usa companyId o rfc)" }, { status: 404 });

  // Bound the Claude cost per run. One company's missing months is small.
  const maxAcuses = Math.min(Math.max(parseInt(String(body?.maxAcuses ?? "24"), 10) || 24, 1), 60);
  const { iniciada, corrida } = iniciarCorrida(company.id, maxAcuses);
  return NextResponse.json({ ok: true, iniciada, company, corrida }, { status: 202 });
}

export async function GET(req: Request) {
  const denegado = await operadorAutorizado();
  if (denegado) return denegado;

  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: COMPANY_SELECT });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const yearParam = parseInt(sp.get("year") ?? "", 10);
  const year = Number.isInteger(yearParam) ? yearParam : new Date().getFullYear();
  return NextResponse.json(await estadoDe(company, year));
}
