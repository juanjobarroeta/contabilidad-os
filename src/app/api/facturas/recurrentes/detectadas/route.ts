import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import {
  agruparFacturasRecurrentes,
  derivarTratamientoIva,
  firmaDe,
} from "@/lib/facturas/sugerencias";
import { inferirCadencia, describirCadencia } from "@/lib/facturas/cadencia";

// ─────────────────────────────────────────────────────────────────────────────
// Series recurrentes DETECTADAS — "esto ya lo facturas cada mes, ¿lo automatizo?"
//
// GET  ?companyId=  — formas de factura repetidas CON ritmo, que todavía no
//                     tienen serie ni fueron descartadas.
// POST { companyId, firma } — descartar una sugerencia para siempre.
//
// El detector de formas (agruparFacturasRecurrentes) ya existía y alimentaba el
// atajo "vuelve a facturar" del compositor. Lo que faltaba era mirar las FECHAS
// de cada grupo: sabía que a un cliente se le facturó 11 veces lo mismo, no que
// fue el día 1 de cada mes. La cadencia se infiere en lib/facturas/cadencia.
//
// Sólo se miran facturas TIMBRADAS: un borrador no prueba que esa factura se
// emita de verdad, y proponer una serie a partir de borradores automatizaría
// algo que quizá nunca se cobró.
// ─────────────────────────────────────────────────────────────────────────────

/** Facturas recientes que se escanean. Las viejas no cambian el diagnóstico. */
const VENTANA_FACTURAS = 300;
/** Formas candidatas antes de filtrar por cadencia. */
const FORMAS_A_EVALUAR = 40;
/** Cuántas sugerencias se devuelven, ya filtradas. */
const TOP_SUGERENCIAS = 8;

export async function GET(req: Request) {
  try {
    const companyId = new URL(req.url).searchParams.get("companyId");
    if (!companyId) {
      return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    }
    await requireMembership(companyId);

    const [facturas, seriesExistentes, ignoradas] = await Promise.all([
      prisma.invoice.findMany({
        where: { companyId, tipo: "INGRESO", status: "STAMPED" },
        orderBy: { fecha: "desc" },
        take: VENTANA_FACTURAS,
        select: {
          id: true,
          fecha: true,
          total: true,
          customerId: true,
          // Los datos de pago del comprobante: sin ellos la sugerencia no se
          // puede convertir en serie de un clic (el alta los exige).
          formaPago: true,
          metodoPago: true,
          usoCfdi: true,
          customer: { select: { razonSocial: true } },
          items: {
            select: {
              claveProdServ: true,
              descripcion: true,
              cantidad: true,
              valorUnitario: true,
              claveUnidad: true,
              cuentaPredial: true,
            },
          },
          taxes: { select: { tipo: true, factor: true, tasa: true, retencion: true } },
        },
      }),
      prisma.facturaRecurrente.findMany({
        where: { companyId },
        select: { firma: true },
      }),
      prisma.recurrenteSugerenciaIgnorada.findMany({
        where: { companyId },
        select: { firma: true },
      }),
    ]);

    // Una forma ya automatizada o ya descartada no se vuelve a proponer.
    const silenciadas = new Set<string>([
      ...seriesExistentes.map((s) => s.firma).filter((f): f is string => !!f),
      ...ignoradas.map((i) => i.firma),
    ]);

    const grupos = agruparFacturasRecurrentes(
      facturas.map((inv) => ({
        id: inv.id,
        fecha: inv.fecha,
        total: Number(inv.total),
        customerId: inv.customerId,
        cliente: inv.customer?.razonSocial ?? "Sin cliente",
        items: inv.items.map((it) => ({ ...it, cantidad: Number(it.cantidad), valorUnitario: Number(it.valorUnitario) })),
        ivaTratamiento: derivarTratamientoIva(inv.taxes.map((t) => ({ ...t, tasa: Number(t.tasa) }))),
      })),
      FORMAS_A_EVALUAR
    );

    // La plantilla del grupo es una factura concreta: de ahí salen forma de
    // pago, método y uso del CFDI.
    const porId = new Map(facturas.map((f) => [f.id, f]));

    const hoy = new Date();
    const sugerencias = grupos
      .map((g) => {
        const firma = firmaDe(g.customerId, g.items);
        if (silenciadas.has(firma)) return null;

        const cadencia = inferirCadencia(
          g.fechas.map((f) => new Date(f)),
          hoy
        );
        if (!cadencia) return null;

        const plantilla = porId.get(g.facturaId);
        if (!plantilla) return null;

        return {
          firma,
          facturaId: g.facturaId,
          formaPago: plantilla.formaPago,
          metodoPago: plantilla.metodoPago,
          usoCfdi: plantilla.usoCfdi,
          customerId: g.customerId,
          cliente: g.cliente,
          total: g.total,
          veces: g.veces,
          items: g.items,
          ivaTratamiento: g.ivaTratamiento,
          periodicidad: cadencia.periodicidad,
          diaMes: cadencia.diaMes,
          ocurrencias: cadencia.ocurrencias,
          ultima: cadencia.ultima.toISOString(),
          proxima: cadencia.proxima.toISOString(),
          resumen: describirCadencia(cadencia),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      // Más repeticiones = patrón más sólido; a igualdad, la más reciente.
      .sort((a, b) => b.ocurrencias - a.ocurrencias || b.ultima.localeCompare(a.ultima))
      .slice(0, TOP_SUGERENCIAS);

    return NextResponse.json({ sugerencias });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

const descartarSchema = z.object({
  companyId: z.string().min(1),
  firma: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const parsed = descartarSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const { companyId, firma } = parsed.data;
    const { user } = await requireWriter(companyId, req);

    // Descartar dos veces la misma forma no es un error: el usuario pudo tener
    // dos pestañas abiertas. La unicidad la impone el índice.
    await prisma.recurrenteSugerenciaIgnorada.upsert({
      where: { companyId_firma: { companyId, firma } },
      create: { companyId, firma },
      update: {},
    });

    registrarBitacora({
      companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.recurrente.sugerencia.descartar",
      entidad: "RecurrenteSugerenciaIgnorada",
      entidadId: firma,
      detalle: { firma },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
