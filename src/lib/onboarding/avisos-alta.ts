// ─────────────────────────────────────────────────────────────────────────────
// Avisos de los hitos del alta: «ya tengo lo reciente», «historial completo» y
// «llegó tu catálogo de cuentas». Para que nadie tenga que quedarse viendo la
// pantalla del historial: sigue con su día y le avisamos (push + Pendientes).
//
// Idempotente sin estado propio: cada hito es un dedupeKey
// (`alta:<empresa>:<hito>`) en registrarYNotificar con pushSoloAlCrear, así que
// sale una sola vez por usuario aunque el cron lo evalúe cada 10 min.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { registrarYNotificar } from "@/lib/notificaciones";
import { cargarEstadoAlta, type EstadoAltaDatos } from "./estado-alta";
import { sugerirCuentasBancarias } from "@/lib/bancos/cuentas-del-catalogo";

export interface Hito {
  clave: "reciente" | "completo" | "catalogo";
  titulo: string;
  cuerpo: string;
  url: string;
}

const fmt = (n: number) => n.toLocaleString("es-MX");

/**
 * Qué hitos ya se alcanzaron y vale la pena avisar. Lo del historial sólo para
 * empresas recién dadas de alta (a una empresa de hace un año no se le avisa
 * «historial completo»); el catálogo, a cualquiera, cuando acaba de llegar.
 */
export function hitosAlta(
  e: Pick<EstadoAltaDatos, "resumen" | "conteos" | "catalogo">,
  opts: { altaReciente: boolean; catalogoNuevo: boolean; cuentasSugeridas: number; razonSocial: string },
): Hito[] {
  const out: Hito[] = [];
  if (opts.altaReciente && e.resumen.total > 0) {
    if (e.resumen.completo) {
      out.push({
        clave: "completo",
        titulo: `Historial completo · ${opts.razonSocial}`,
        cuerpo: `Ya tengo tus ${fmt(e.resumen.ok)} meses del SAT: ${fmt(e.conteos.cfdis)} facturas, ${fmt(e.resumen.declaraciones)} declaraciones y ${fmt(e.resumen.balanzas)} balanzas.`,
        url: "/dashboard",
      });
    } else if (e.resumen.recienteListo) {
      out.push({
        clave: "reciente",
        titulo: `Ya tengo lo reciente · ${opts.razonSocial}`,
        cuerpo: "Bajé tus últimos meses del SAT: ya puedo calcular tus impuestos del mes. Sigo con el resto del historial.",
        url: "/impuestos",
      });
    }
  }
  if (opts.catalogoNuevo && e.catalogo) {
    out.push({
      clave: "catalogo",
      titulo: `Llegó tu catálogo de cuentas · ${opts.razonSocial}`,
      cuerpo:
        `Traje del SAT tu catálogo (${fmt(e.catalogo.cuentas)} cuentas) y lo apliqué a tu contabilidad.` +
        (opts.cuentasSugeridas > 0
          ? ` Encontré ${opts.cuentasSugeridas} ${opts.cuentasSugeridas === 1 ? "cuenta bancaria" : "cuentas bancarias"} por registrar en Bancos.`
          : ""),
      url: opts.cuentasSugeridas > 0 ? "/bancos" : "/contabilidad",
    });
  }
  return out;
}

const DIAS_ALTA_RECIENTE = 30;
const HORAS_CATALOGO_NUEVO = 48;

/** Evalúa y avisa los hitos de una empresa a sus dueños y administradores. */
export async function avisarHitosAlta(companyId: string, ahora = new Date()): Promise<number> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { createdAt: true, razonSocial: true } });
  if (!company) return 0;
  const [estado, ct, catalogo, bancos, miembros] = await Promise.all([
    cargarEstadoAlta(companyId),
    prisma.ceArchivo.findFirst({
      where: { companyId, tipo: "CT", importadoEn: { not: null } },
      orderBy: { importadoEn: "desc" },
      select: { importadoEn: true },
    }),
    prisma.chartAccount.findMany({
      where: { companyId, OR: [{ codAgrup: { startsWith: "102" } }, { cuentaSAT: "102" }] },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, codAgrup: true, padreCodigo: true, isActive: true },
    }),
    prisma.bankAccount.findMany({ where: { companyId }, select: { chartAccountId: true, numeroCuenta: true, clabe: true } }),
    prisma.companyMember.findMany({ where: { companyId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true } }),
  ]);
  if (!estado || miembros.length === 0) return 0;

  const hitos = hitosAlta(estado, {
    altaReciente: ahora.getTime() - company.createdAt.getTime() < DIAS_ALTA_RECIENTE * 24 * 3600_000,
    catalogoNuevo: !!ct?.importadoEn && ahora.getTime() - ct.importadoEn.getTime() < HORAS_CATALOGO_NUEVO * 3600_000,
    cuentasSugeridas: sugerirCuentasBancarias(catalogo, bancos).length,
    razonSocial: company.razonSocial,
  });

  let n = 0;
  for (const h of hitos) {
    for (const m of miembros) {
      await registrarYNotificar(
        {
          recipientUserId: m.userId,
          companyId,
          categoria: "otro",
          severidad: "info",
          titulo: h.titulo,
          cuerpo: h.cuerpo,
          url: h.url,
          dedupeKey: `alta:${companyId}:${h.clave}`,
          categoriaPush: "sistema",
          pushSoloAlCrear: true,
          abrirChat: false,
        },
        ahora,
      ).catch((e) => console.warn("[avisos-alta]", companyId, h.clave, e instanceof Error ? e.message : e));
      n++;
    }
  }
  return n;
}

/** Empresas a revisar: altas recientes con e.firma y las que acaban de recibir catálogo. */
export async function empresasConHitosPosibles(ahora = new Date()): Promise<string[]> {
  const [recientes, conCatalogo] = await Promise.all([
    prisma.company.findMany({
      where: { isActive: true, fielCer: { not: null }, createdAt: { gt: new Date(ahora.getTime() - DIAS_ALTA_RECIENTE * 24 * 3600_000) } },
      select: { id: true },
      take: 50,
    }),
    prisma.ceArchivo.findMany({
      where: { tipo: "CT", importadoEn: { gt: new Date(ahora.getTime() - HORAS_CATALOGO_NUEVO * 3600_000) } },
      select: { companyId: true },
      distinct: ["companyId"],
      take: 50,
    }),
  ]);
  return [...new Set([...recientes.map((c) => c.id), ...conCatalogo.map((c) => c.companyId)])];
}
