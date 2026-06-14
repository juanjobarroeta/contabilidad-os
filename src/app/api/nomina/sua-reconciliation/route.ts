import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { meteredCreate } from "@/lib/costos/anthropic";
import { calcularImss } from "@/lib/nomina/imss";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/sua-reconciliation
//
// Upload an EMA/EBA PDF (SUA output) → Claude extracts per-employee IMSS
// cuotas → we compare vs our calculation → return discrepancies.
//
// Body: multipart/form-data with "file" (PDF) + "companyId" + "bimestre" + "year"
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `Eres un experto en IMSS y SUA. Extraes datos de documentos EMA (Emisión Mensual Anticipada) o EBA (Emisión Bimestral Anticipada) del SUA.

REGLAS:
1. SOLO devuelves JSON válido. Sin markdown.
2. Extrae cada empleado listado con sus cuotas.
3. Si el documento no es un EMA/EBA del SUA, devuelve type: "OTRO".

SCHEMA:
{
  "type": "EMA" | "EBA" | "OTRO",
  "periodo": string | null,
  "registroPatronal": string | null,
  "employees": [
    {
      "nss": string,
      "nombre": string,
      "sbc": number | null,
      "dias": number | null,
      "cuotaObrera": number | null,
      "cuotaPatronal": number | null,
      "cuotaTotal": number | null,
      "ramo": string | null,
      "infonavitMonto": number | null,
      "infonavitCredito": string | null,
      "infonavitTipo": string | null
    }
  ],
  "totales": {
    "cuotaObrera": number | null,
    "cuotaPatronal": number | null,
    "total": number | null
  }
}

Si hay múltiples líneas por empleado (por ramo), agrúpalas en una sola entrada con la suma. El campo "ramo" es informativo.
Si el documento muestra descuentos de Infonavit/crédito de vivienda por empleado, extrae infonavitMonto (el importe), infonavitCredito (número de crédito si aparece), e infonavitTipo ("PESOS" si es cuota fija, "PCT_SBC" si es porcentaje, "VSM" si es veces salario mínimo).
Montos como números sin comas ni signos de pesos.`;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI no configurado" }, { status: 503 });
  }

  let file: File | null = null;
  let companyId = "";
  let bimestre = 0;
  let year = 0;

  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
    companyId = (form.get("companyId") as string) ?? "";
    bimestre = parseInt((form.get("bimestre") as string) ?? "0");
    year = parseInt((form.get("year") as string) ?? "0");
  } catch {
    return NextResponse.json({ error: "Formato inválido" }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "Sube el PDF del EMA/EBA" }, { status: 400 });
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "Máximo 15 MB" }, { status: 413 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Parse PDF with Claude
  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");

  let suaData: {
    type: string;
    periodo: string | null;
    registroPatronal: string | null;
    employees: {
      nss: string;
      nombre: string;
      sbc: number | null;
      dias: number | null;
      cuotaObrera: number | null;
      cuotaPatronal: number | null;
      cuotaTotal: number | null;
      infonavitMonto: number | null;
      infonavitCredito: string | null;
      infonavitTipo: string | null;
    }[];
    totales: { cuotaObrera: number | null; cuotaPatronal: number | null; total: number | null };
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await meteredCreate(anthropic, { companyId, subtipo: "nomina.sua" }, {
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: "Extrae los datos de este EMA/EBA del SUA. JSON only." },
        ],
      }],
    });
    const text = response.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    suaData = JSON.parse(cleaned);
  } catch (e) {
    return NextResponse.json({
      error: "No se pudo procesar el documento",
      detail: e instanceof Error ? e.message : "desconocido",
    }, { status: 502 });
  }

  if (suaData.type === "OTRO") {
    return NextResponse.json({
      ok: false,
      error: "El documento no parece ser un EMA o EBA del SUA",
      type: suaData.type,
    });
  }

  // Fetch our employees for comparison
  const employees = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: {
      id: true, nombre: true, apellidoPaterno: true, nss: true,
      salarioDiario: true, salarioDiarioIntegrado: true, riesgoPuesto: true,
      descuentoInfonavit: true, tipoDescuentoInfonavit: true, creditoInfonavit: true,
    },
  });

  const ourByNss = new Map(employees.map((e) => [e.nss, e]));

  // Compare each SUA employee vs our calculation
  type Discrepancy = {
    nss: string;
    nombre: string;
    field: string;
    suaValue: number;
    ourValue: number;
    diff: number;
    severity: "info" | "warning" | "error";
  };

  const discrepancies: Discrepancy[] = [];
  const matched: { nss: string; nombre: string; status: "ok" | "diff" }[] = [];
  const suaOnly: string[] = [];
  const ourOnly: string[] = [];

  // Default dias if not provided
  const defaultDias = bimestre === 1 ? (year % 4 === 0 ? 60 : 59) : 61;

  for (const suaEmp of suaData.employees) {
    const ourEmp = ourByNss.get(suaEmp.nss);

    if (!ourEmp) {
      suaOnly.push(`${suaEmp.nss} — ${suaEmp.nombre}`);
      continue;
    }

    const sdi = ourEmp.salarioDiarioIntegrado ?? ourEmp.salarioDiario;
    const dias = suaEmp.dias ?? defaultDias;

    const ourCalc = calcularImss({
      salarioBaseCotizacion: sdi,
      diasPagados: dias,
      riesgoPuesto: ourEmp.riesgoPuesto,
    });

    let hasDiff = false;

    // Compare SBC
    if (suaEmp.sbc != null) {
      const sbcDiff = Math.abs(suaEmp.sbc - sdi);
      if (sbcDiff > 0.5) {
        discrepancies.push({
          nss: suaEmp.nss,
          nombre: suaEmp.nombre,
          field: "SBC",
          suaValue: suaEmp.sbc,
          ourValue: sdi,
          diff: suaEmp.sbc - sdi,
          severity: sbcDiff > 10 ? "error" : "warning",
        });
        hasDiff = true;
      }
    }

    // Compare cuota obrera
    if (suaEmp.cuotaObrera != null) {
      const diff = Math.abs(suaEmp.cuotaObrera - ourCalc.obrero.total);
      if (diff > 1) {
        discrepancies.push({
          nss: suaEmp.nss,
          nombre: suaEmp.nombre,
          field: "Cuota Obrera",
          suaValue: suaEmp.cuotaObrera,
          ourValue: ourCalc.obrero.total,
          diff: suaEmp.cuotaObrera - ourCalc.obrero.total,
          severity: diff > 50 ? "error" : "warning",
        });
        hasDiff = true;
      }
    }

    // Compare cuota patronal
    if (suaEmp.cuotaPatronal != null) {
      const diff = Math.abs(suaEmp.cuotaPatronal - ourCalc.patronal.total);
      if (diff > 1) {
        discrepancies.push({
          nss: suaEmp.nss,
          nombre: suaEmp.nombre,
          field: "Cuota Patronal",
          suaValue: suaEmp.cuotaPatronal,
          ourValue: ourCalc.patronal.total,
          diff: suaEmp.cuotaPatronal - ourCalc.patronal.total,
          severity: diff > 100 ? "error" : "warning",
        });
        hasDiff = true;
      }
    }

    matched.push({ nss: suaEmp.nss, nombre: suaEmp.nombre, status: hasDiff ? "diff" : "ok" });
  }

  // Employees we have but SUA doesn't
  const suaNssSet = new Set(suaData.employees.map((e) => e.nss));
  for (const emp of employees) {
    if (!suaNssSet.has(emp.nss)) {
      ourOnly.push(`${emp.nss} — ${emp.nombre} ${emp.apellidoPaterno}`);
    }
  }

  // ── Infonavit auto-detection ──
  // Flag employees that have Infonavit in SUA but NOT in our system
  type InfonavitAction = {
    nss: string;
    employeeId: string;
    nombre: string;
    action: "ADD" | "UPDATE" | "REMOVE";
    suaMonto: number | null;
    suaCredito: string | null;
    suaTipo: string | null;
    ourMonto: number | null;
  };
  const infonavitActions: InfonavitAction[] = [];

  for (const suaEmp of suaData.employees) {
    const ourEmp = ourByNss.get(suaEmp.nss);
    if (!ourEmp) continue;

    const suaHasInfonavit = suaEmp.infonavitMonto != null && suaEmp.infonavitMonto > 0;
    const ourHasInfonavit = ourEmp.descuentoInfonavit != null && ourEmp.descuentoInfonavit > 0;

    if (suaHasInfonavit && !ourHasInfonavit) {
      // SUA says they have Infonavit but we don't — need to add
      infonavitActions.push({
        nss: suaEmp.nss,
        employeeId: ourEmp.id,
        nombre: `${ourEmp.nombre} ${ourEmp.apellidoPaterno}`,
        action: "ADD",
        suaMonto: suaEmp.infonavitMonto,
        suaCredito: suaEmp.infonavitCredito,
        suaTipo: suaEmp.infonavitTipo,
        ourMonto: null,
      });
    } else if (suaHasInfonavit && ourHasInfonavit && Math.abs((suaEmp.infonavitMonto ?? 0) - (ourEmp.descuentoInfonavit ?? 0)) > 1) {
      // Both have it but amounts differ
      infonavitActions.push({
        nss: suaEmp.nss,
        employeeId: ourEmp.id,
        nombre: `${ourEmp.nombre} ${ourEmp.apellidoPaterno}`,
        action: "UPDATE",
        suaMonto: suaEmp.infonavitMonto,
        suaCredito: suaEmp.infonavitCredito,
        suaTipo: suaEmp.infonavitTipo,
        ourMonto: ourEmp.descuentoInfonavit,
      });
    } else if (!suaHasInfonavit && ourHasInfonavit) {
      // We have Infonavit but SUA doesn't — credit might be paid off
      infonavitActions.push({
        nss: suaEmp.nss,
        employeeId: ourEmp.id,
        nombre: `${ourEmp.nombre} ${ourEmp.apellidoPaterno}`,
        action: "REMOVE",
        suaMonto: null,
        suaCredito: null,
        suaTipo: null,
        ourMonto: ourEmp.descuentoInfonavit,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    suaType: suaData.type,
    periodo: suaData.periodo,
    summary: {
      suaEmployees: suaData.employees.length,
      ourEmployees: employees.length,
      matched: matched.length,
      withDiscrepancies: matched.filter((m) => m.status === "diff").length,
      suaOnly: suaOnly.length,
      ourOnly: ourOnly.length,
      infonavitActions: infonavitActions.length,
    },
    suaTotals: suaData.totales,
    discrepancies,
    infonavitActions,
    suaOnly,
    ourOnly,
  });
}
