/**
 * Ligar unidades del piso con su venta EXISTENTE que el derivador no pudo ver.
 *
 * El VIN es la llave del derivador, pero hay ventas reales sin VIN en el XML:
 * las que traen el NÚMERO DE MOTOR en el texto, y las refacturas que no
 * referencian a la cancelada (sin TipoRelacion 04, sin VIN). Medido en MARGOM
 * (2026-08-17): 1 venta vigente sin ligar + 5 por motor + ~5 por firma de
 * refactura (mismo RFC, mismo subtotal ±$1, ±45 días de la cancelación).
 *
 * Clases de evidencia:
 *   VIN     — venta vigente y libre cuyo XML trae el VIN. La más fuerte.
 *   MOTOR   — venta vigente y libre cuyo texto trae el numeroMotor (≥6 chars).
 *   REFACT  — firma de refactura. Circunstancial: sólo se aplica con FORZAR=1.
 *
 * APPLY liga: ventaInvoiceId, fechaVenta (fecha del CFDI) y precioVenta
 * (subtotal) — lo mismo que fija el derivador. Una factura se liga a UNA sola
 * unidad; si dos unidades compiten por el mismo CFDI, ninguna se liga y se
 * reporta. No toca unidades cuya venta ya está ligada ni facturas tomadas.
 *
 * Uso (dry-run por default):
 *   DATABASE_URL=<url> [APPLY=1] [FORZAR=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/ligar-ventas-huerfanas-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import { resolverEmpresa } from "./lib/empresa";

const APPLY = process.env.APPLY === "1";
const FORZAR = process.env.FORZAR === "1"; // incluye la clase REFACT

interface Candidato {
  veh: string;
  vin: string;
  clase: "VIN" | "TEXTO" | "MOTOR" | "REFACT";
  inv: string;
  uuid: string | null;
  fecha: Date;
  subtotal: number;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);
    const piso = await prisma.vehiculo.findMany({
      where: { companyId: COMPANY, ventaInvoiceId: null },
      select: { id: true, vin: true, numeroMotor: true, fechaCompra: true, createdAt: true },
    });
    const desde = new Map(piso.map((v) => [v.id, (v.fechaCompra ?? v.createdAt)]));

    // 1) VIN y MOTOR en UNA pasada del servidor (regexp sobre rawXml; ~15s),
    // no un LIKE por unidad: 540 escaneos de 1GB no terminan nunca — la regla
    // del handoff. `vehiculosVendidos: none` se aplica con NOT EXISTS.
    const candidatos: Candidato[] = [];
    type Hit = { veh: string; vin: string; clase: "VIN" | "TEXTO" | "MOTOR"; inv: string; uuid: string | null; fecha: Date; subtotal: number; n: bigint };
    const hits = await prisma.$queryRawUnsafe<Hit[]>(`
      WITH piso AS (
        SELECT v.id veh, v.vin, v."numeroMotor" motor,
               COALESCE(v."fechaCompra", v."createdAt") f_compra
        FROM "Vehiculo" v
        WHERE v."companyId" = '${COMPANY}' AND v."ventaInvoiceId" IS NULL
      ),
      libres AS (
        SELECT i.id, i.uuid, i.fecha, i.subtotal, i."rawXml"
        FROM "Invoice" i
        WHERE i."companyId" = '${COMPANY}' AND i.tipo = 'INGRESO'
          AND i."tipoSat" = 'I' AND i.status = 'STAMPED'
          AND NOT EXISTS (SELECT 1 FROM "Vehiculo" o WHERE o."ventaInvoiceId" = i.id)
      ),
      vins AS (
        -- Niv del complemento VentaVehiculos: la evidencia fuerte.
        SELECT l.id, l.uuid, l.fecha, l.subtotal, upper(m[1]) tok, 'VIN'::text clase
        FROM libres l, LATERAL regexp_matches(l."rawXml", '\sNiv\s*=\s*"([^"]*)"', 'gi') m
      ),
      textos AS (
        -- VIN suelto en el texto: sólo cuenta si el CFDI tiene importe de
        -- unidad — un servicio de $17k que MENCIONA el VIN no es su venta.
        SELECT l.id, l.uuid, l.fecha, l.subtotal, upper(m[1]) tok, 'TEXTO'::text clase
        FROM libres l, LATERAL regexp_matches(l."rawXml", '([A-HJ-NPR-Z0-9]{17})', 'g') m
        WHERE l.subtotal >= 50000
      ),
      motores AS (
        SELECT l.id, l.uuid, l.fecha, l.subtotal, upper(m[1]) tok, 'MOTOR'::text clase
        FROM libres l, LATERAL regexp_matches(l."rawXml", 'MOTOR[^A-Z0-9]{0,4}([A-Z0-9]{6,14})', 'gi') m
        WHERE l.subtotal >= 50000
      ),
      empates AS (
        SELECT p.veh, p.vin, t.clase, t.id inv, t.uuid, t.fecha, t.subtotal
        FROM piso p
        JOIN (SELECT * FROM vins UNION ALL SELECT * FROM textos UNION ALL SELECT * FROM motores) t
          ON (t.clase IN ('VIN','TEXTO') AND t.tok = p.vin)
          OR (t.clase = 'MOTOR' AND p.motor IS NOT NULL AND length(p.motor) >= 6 AND t.tok = upper(p.motor))
        WHERE t.fecha >= p.f_compra
      )
      , conteo AS (
        SELECT veh, clase, COUNT(DISTINCT inv) n FROM empates GROUP BY 1, 2
      )
      SELECT DISTINCT ON (e.veh, e.clase) e.veh, e.vin, e.clase, e.inv, e.uuid, e.fecha, e.subtotal, c.n
      FROM empates e JOIN conteo c ON c.veh = e.veh AND c.clase = e.clase
      ORDER BY e.veh, e.clase DESC, e.fecha ASC`);
    // VIN gana sobre MOTOR; n>1 = ambigua, no se adivina.
    const porVeh = new Map<string, Hit>();
    for (const h of hits) {
      if (Number(h.n) !== 1) continue;
      const rango = { VIN: 3, TEXTO: 2, MOTOR: 1 } as const;
      const prev = porVeh.get(h.veh);
      if (!prev || rango[h.clase] > rango[prev.clase]) porVeh.set(h.veh, h);
    }
    for (const h of porVeh.values()) {
      candidatos.push({ veh: h.veh, vin: h.vin, clase: h.clase, inv: h.inv, uuid: h.uuid, fecha: h.fecha, subtotal: Number(h.subtotal) });
    }

    // 2) REFACT: firma de refactura (mismo RFC, mismo subtotal, ±45 días de la
    //    cancelación) — también en una consulta.
    type Ref = { veh: string; vin: string; inv: string; uuid: string | null; fecha: Date; subtotal: number; n: bigint };
    const yaConLlave = new Set(candidatos.map((c) => c.veh));
    const refs = await prisma.$queryRawUnsafe<Ref[]>(`
      WITH piso AS (
        SELECT v.id veh, v.vin, COALESCE(v."fechaCompra", v."createdAt") f_compra
        FROM "Vehiculo" v
        WHERE v."companyId" = '${COMPANY}' AND v."ventaInvoiceId" IS NULL
      ),
      canc AS (
        SELECT DISTINCT ON (p.veh) p.veh, p.vin, i.fecha f_canc, i.subtotal, i."contraparteRfc" rfc
        FROM piso p
        JOIN "Invoice" i ON i."companyId" = '${COMPANY}' AND i.tipo = 'INGRESO'
          AND i.status = 'CANCELLED' AND i.fecha >= p.f_compra
          AND i."rawXml" LIKE '%' || p.vin || '%'
        ORDER BY p.veh, i.fecha DESC
      )
      SELECT c.veh, c.vin, s.id inv, s.uuid, s.fecha, s.subtotal,
             COUNT(*) OVER (PARTITION BY c.veh) n
      FROM canc c
      JOIN "Invoice" s ON s."companyId" = '${COMPANY}' AND s.tipo = 'INGRESO'
        AND s."tipoSat" = 'I' AND s.status = 'STAMPED'
        AND s."contraparteRfc" = c.rfc
        AND abs(s.subtotal - c.subtotal) < 1
        AND s.fecha BETWEEN c.f_canc - interval '45 days' AND c.f_canc + interval '45 days'
        AND NOT EXISTS (SELECT 1 FROM "Vehiculo" o WHERE o."ventaInvoiceId" = s.id)`);
    for (const r of refs) {
      if (Number(r.n) !== 1 || yaConLlave.has(r.veh)) continue;
      candidatos.push({ veh: r.veh, vin: r.vin, clase: "REFACT", inv: r.inv, uuid: r.uuid, fecha: r.fecha, subtotal: Number(r.subtotal) });
    }

    // Una factura, una unidad: si dos unidades compiten, fuera las dos.
    const porInv = new Map<string, Candidato[]>();
    for (const c of candidatos) porInv.set(c.inv, [...(porInv.get(c.inv) ?? []), c]);
    const unicos = [...porInv.values()].filter((g) => g.length === 1).map((g) => g[0]);
    const competidos = [...porInv.values()].filter((g) => g.length > 1);

    let aplicados = 0;
    for (const c of unicos.sort((a, b) => a.clase.localeCompare(b.clase))) {
      const aplicable = c.clase !== "REFACT" || FORZAR;
      console.log(
        `${APPLY && aplicable ? "APLICA " : "[dry]  "}${c.clase.padEnd(7)}${c.vin}  → ${c.uuid ?? c.inv}  ` +
        `${c.fecha.toISOString().slice(0, 10)}  $${Math.round(c.subtotal).toLocaleString("en-US")}` +
        (aplicable ? "" : "  (REFACT: requiere FORZAR=1)"),
      );
      if (APPLY && aplicable) {
        await prisma.vehiculo.update({
          where: { id: c.veh },
          data: { ventaInvoiceId: c.inv, fechaVenta: c.fecha, precioVenta: c.subtotal },
        });
        aplicados++;
      }
    }
    for (const g of competidos) {
      console.log(`COMPETIDA ${g[0].uuid ?? g[0].inv}: ${g.map((x) => x.vin).join(", ")} — nadie se liga`);
    }
    console.log(`\n${APPLY ? "" : "[dry-run] "}listo: ${unicos.length} candidatos, ${aplicados} aplicados, ${competidos.length} competidas`);
    if (APPLY && aplicados > 0) console.log("Re-postear los períodos afectados para que el ledger lo refleje.");
  } finally {
    await prisma.$disconnect();
  }
}

main();
