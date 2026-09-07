import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { nivelPagoEmpresas } from "@/lib/billing/pagadores";
import { planIncluyeSyntage } from "@/lib/planes";
import { datosPresentes, ultimasExtracciones } from "@/lib/fiscal/cumplimiento/syntage/provision";
import { debeArrancarCE, extractoresADisparar } from "@/lib/fiscal/cumplimiento/syntage/cadencia";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/operador/syntage-diagnostico?companyId=
//
// «¿POR QUÉ ESTA EMPRESA NO SE SINCRONIZA SOLA?»
//
// El cron de aprovisionamiento y el botón manual NO disparan lo mismo, y hasta
// ahora la única forma de saber cuál de los candados frenaba a una empresa era
// correr el cron con el CRON_SECRET y leer el `motivo` del JSON. Esto responde
// la pregunta de frente, por empresa, sin secretos y sin escribir nada:
// ejecuta las MISMAS funciones puras de la cadencia con y sin `force`, y
// enseña la diferencia.
//
// La diferencia es real y está en cadencia.ts: `force` gana ANTES del check de
// plan, así que el botón dispara todo aunque la empresa esté en ASISTENTE — y
// el cron, correctamente, no dispara nada (Syntage cuesta por extracción).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id || !(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });

  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      rfc: true,
      razonSocial: true,
      tier: true,
      isActive: true,
      ceBootstrapAt: true,
      fielCer: true,
      fielKey: true,
      fielPassword: true,
    },
  });
  if (!c) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const [niveles, ultimas, presentes, conteos] = await Promise.all([
    nivelPagoEmpresas([companyId]),
    ultimasExtracciones(companyId),
    datosPresentes(companyId),
    Promise.all([
      prisma.taxDeclaration.count({ where: { companyId } }),
      prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId } }).then((r) => r.length),
      prisma.complianceSnapshot.count({ where: { companyId } }),
    ]),
  ]);
  const nivelPago = niveles.get(companyId) ?? "NINGUNO";
  const tieneFiel = c.fielCer != null && c.fielKey != null && c.fielPassword != null;
  const ahora = new Date();
  const nivelExtraccion = nivelPago === "TRIAL" ? ("TRIAL" as const) : ("ACTIVO" as const);

  const args = {
    plan: c.tier,
    ultimaPorExtractor: ultimas.porExtractor,
    datosPresentes: presentes,
    ahora,
    nivelPago: nivelExtraccion,
  };
  const cron = extractoresADisparar(args);
  const boton = extractoresADisparar({ ...args, force: true });
  const argsCE = {
    plan: c.tier,
    ceBootstrapAt: c.ceBootstrapAt,
    ultimoIntentoCE: ultimas.ultimoIntentoCE,
    ahora,
    nivelPago: nivelExtraccion,
  };

  // Los cuatro candados del cron, en el mismo orden en que los aplica
  // provisionAllCompanies. El primero que falla es la respuesta.
  const candados = [
    { clave: "efirma", ok: tieneFiel, dice: tieneFiel ? "e.firma guardada" : "Sin e.firma: la empresa ni entra a la consulta del cron" },
    {
      clave: "pago",
      ok: nivelPago !== "NINGUNO",
      dice:
        nivelPago === "NINGUNO"
          ? "Sin pagador vigente: no se extrae nada, ni forzando"
          : nivelPago === "TRIAL"
            ? "En prueba: sólo opinión y CSF — declaraciones y CE NO se extraen, ni forzando"
            : "Pagador vigente",
    },
    {
      clave: "plan",
      ok: planIncluyeSyntage(c.tier),
      dice: planIncluyeSyntage(c.tier)
        ? `Plan ${c.tier}: incluye Syntage`
        : `Plan ${c.tier}: NO incluye Syntage — el cron la salta y sólo el botón (force) extrae`,
    },
    {
      clave: "cadencia",
      ok: cron.length > 0 || debeArrancarCE(argsCE),
      dice:
        cron.length > 0 || debeArrancarCE(argsCE)
          ? "La cadencia sí tiene algo pendiente ahora mismo"
          : "La cadencia dice que todo está fresco: no hay nada que extraer hoy",
    },
  ];
  const primerBloqueo = candados.find((x) => !x.ok) ?? null;

  return NextResponse.json({
    empresa: { companyId, rfc: c.rfc, razonSocial: c.razonSocial, tier: c.tier, activa: c.isActive },
    nivelPago,
    tieneFiel,
    candados,
    // Lo que se dispararía AHORA por cada vía. Si difieren, ahí está la razón
    // de que «el botón sí y el cron no».
    dispararia: {
      cron: { extractores: cron, contabilidadElectronica: debeArrancarCE(argsCE) },
      boton: { extractores: boton, contabilidadElectronica: debeArrancarCE({ ...argsCE, force: true }) },
    },
    ultimasExtracciones: {
      porExtractor: ultimas.porExtractor,
      ultimoIntentoCE: ultimas.ultimoIntentoCE,
    },
    datosPresentes: presentes,
    ceBootstrapAt: c.ceBootstrapAt,
    tiene: { declaraciones: conteos[0], mesesDeBalanzaCE: conteos[1], snapshotsDeCumplimiento: conteos[2] },
    veredicto: primerBloqueo
      ? `${primerBloqueo.dice}.`
      : "Nada la frena: el cron debería estar extrayendo. Si no llega el dato, mira la cosecha (compliance-sync, cada 6 h) o que Syntage resuelva la entidad por RFC.",
  });
}
