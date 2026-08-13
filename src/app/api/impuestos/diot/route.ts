import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { archivoDiot2025, archivoDiotLegacy } from "@/lib/fiscal/diot";
import { cargarProveedoresDiot, totalesDiot } from "@/lib/fiscal/diot-datos";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/impuestos/diot?companyId=xxx&month=4&year=2026
//
// DIOT (Declaración Informativa de Operaciones con Terceros)
// Generates two things:
//   1. JSON response with supplier-level IVA breakdown (for the UI)
//   2. When format=txt, returns the SAT batch upload file (.txt)
//      - Por defecto: layout DIOT 2025 (nueva plataforma, 54 campos, montos
//        en pesos enteros) — ver src/lib/fiscal/diot.ts y docs/DIOT-2025.md.
//      - ?layout=legacy: layout DEM anterior (15 campos), sólo por
//        compatibilidad/depuración — el SAT ya no lo acepta.
//
// Base de FLUJO DE EFECTIVO (Art. 32 fracc. VIII y Art. 1-B LIVA): la DIOT
// reporta el IVA EFECTIVAMENTE PAGADO a cada proveedor en el mes, no el
// devengado. Misma regla que el motor mensual (computeTaxPosition,
// src/lib/impuestos.ts):
//   - PUE: pagado en el mes de emisión de la factura.
//   - PPD: pagado en el mes de la FechaPago de cada pago del REP recibido; los
//     PPD sin REP NO se reportan (aún no están pagados). Pagos parciales
//     entran sólo por la porción pagada.
// La suma de ivaAcreditable del mes cuadra con iva.acreditableBruto del motor
// (el motor después aplica la proporción del Art. 5-V, que es global).
//
// TipoTercero: 04=Nacional, 05=Extranjero, 15=Global (sin RFC)
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const month = parseInt(searchParams.get("month") ?? "");
  const year = parseInt(searchParams.get("year") ?? "");
  const format = searchParams.get("format"); // "txt" for SAT file
  const layout = searchParams.get("layout"); // "legacy" = layout DEM anterior

  if (!companyId || isNaN(month) || isNaN(year)) {
    return NextResponse.json({ error: "companyId, month y year requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Carga y agregación por proveedor (base de flujo) — compartida con el
  // paquete mensual: src/lib/fiscal/diot-datos.ts
  const rows = await cargarProveedoresDiot(companyId, year, month);
  const totals = totalesDiot(rows);

  // SAT TXT — por defecto el layout DIOT 2025 de la nueva plataforma (54
  // campos, pesos enteros); ?layout=legacy conserva el layout DEM anterior de
  // 15 campos. Misma agregación de flujo en ambos: sólo cambia la
  // serialización (src/lib/fiscal/diot.ts, spec en docs/DIOT-2025.md).
  if (format === "txt") {
    const content =
      layout === "legacy" ? archivoDiotLegacy(rows) : archivoDiot2025(rows);
    const periodo = `${year}${String(month).padStart(2, "0")}`;
    const filename = `DIOT_${periodo}.txt`;

    return new Response(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    rows,
    totals,
  });
}
