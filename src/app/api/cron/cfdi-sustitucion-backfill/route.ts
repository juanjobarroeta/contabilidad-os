import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { relacionadosDeXml } from "@/lib/sat-fiel";
import { sustituidosDe, type ConteoPorTipo } from "@/lib/cfdi-sustitucion";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/cfdi-sustitucion-backfill   [?companyId=]
//
// Marca `sustituidoPorUuid` en los CFDIs que otro CFDI timbrado de la misma
// empresa sustituye (TipoRelacion 04). Los importadores ya lo hacen al llegar
// cada CFDI; esto cubre lo que ya estaba en la base y lo que llegó por un
// camino que no pasa por ellos. Caso que lo motivó: CENTRO, agosto 2026 — dos
// REPs sustituidos sin cancelar seguían contando junto con sus sustitutos y el
// motor acreditaba 7,440 de IVA de más sobre una sola factura.
//
// Local e idempotente. Una sola lectura de la tabla por corrida: primero los
// ids de los CFDIs con `TipoRelacion="04"` en el XML, después sólo el tramo de
// sus relaciones por lotes. Lo ya marcado no se vuelve a escribir, así que en
// régimen cada corrida es un barrido sin escrituras. Sin estado guardado: si el
// presupuesto de tiempo corta, `completado=false` hace que el scheduler vuelva
// pronto y el barrido entero se repite (barato: casi todo ya está marcado).
//
// Reporta los marcados por TipoDeComprobante: los «P» ya dejan de contar para
// impuestos (REP_VIGENTE); los «I»/«E» todavía no — su conteo dice si vale la
// pena excluirlos también. Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 500;
const TIME_BUDGET_MS = 240_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const onlyCompanyId = new URL(req.url).searchParams.get("companyId");
  const startedAt = Date.now();
  const marcados: ConteoPorTipo = {};
  const filtroEmpresa = onlyCompanyId ? Prisma.sql`AND "companyId" = ${onlyCompanyId}` : Prisma.empty;

  const candidatos = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Invoice"
    WHERE status = 'STAMPED' AND uuid IS NOT NULL AND "rawXml" LIKE '%TipoRelacion="04"%' ${filtroEmpresa}
    ORDER BY id
  `;

  let revisados = 0;
  let cortado = false;
  for (let i = 0; i < candidatos.length; i += PAGE) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { cortado = true; break; }
    const ids = candidatos.slice(i, i + PAGE).map((c) => c.id);
    // Sólo el tramo de las relaciones (van al principio del comprobante), no el XML entero.
    const lote = await prisma.$queryRaw<{ companyId: string; uuid: string; rel: string | null }[]>`
      SELECT "companyId", uuid,
             substring("rawXml" from '(<[A-Za-z0-9]*:?CfdiRelacionados.*</[A-Za-z0-9]*:?CfdiRelacionados>)') AS rel
      FROM "Invoice" WHERE id IN (${Prisma.join(ids)})
    `;
    revisados += lote.length;

    // empresa|UUID sustituido → UUID del sustituto.
    const marca = new Map<string, string>();
    for (const s of lote) {
      if (!s.rel) continue;
      for (const u of sustituidosDe(relacionadosDeXml(s.rel), s.uuid)) marca.set(`${s.companyId}|${u}`, normalizarUuid(s.uuid));
    }
    if (marca.size === 0) continue;

    const objetivos = await prisma.invoice.findMany({
      where: {
        companyId: { in: [...new Set(lote.map((s) => s.companyId))] },
        uuid: { in: variantesUuid([...marca.keys()].map((k) => k.split("|")[1])) },
        status: "STAMPED",
      },
      select: { id: true, companyId: true, uuid: true, tipoSat: true, sustituidoPorUuid: true },
    });
    for (const t of objetivos) {
      const m = marca.get(`${t.companyId}|${normalizarUuid(t.uuid ?? "")}`);
      if (!m || t.sustituidoPorUuid === m || normalizarUuid(t.uuid ?? "") === m) continue;
      await prisma.invoice.update({ where: { id: t.id }, data: { sustituidoPorUuid: m } });
      marcados[t.tipoSat ?? "?"] = (marcados[t.tipoSat ?? "?"] ?? 0) + 1;
    }
  }

  const summary = {
    ok: true,
    actualizadas: Object.values(marcados).reduce((a, b) => a + b, 0),
    marcadosPorTipo: marcados,
    candidatos: candidatos.length,
    revisados,
    // Señal para el ritmo del scheduler: si el presupuesto cortó el barrido, que vuelva pronto.
    completado: !cortado,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/cfdi-sustitucion-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:cfdi-sustitucion-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:cfdi-sustitucion-backfill", () => handle(req));
}
