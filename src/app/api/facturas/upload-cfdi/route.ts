import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { importCfdiFromXml } from "@/lib/facturas/import-cfdi";
import { meteredCreate } from "@/lib/costos/anthropic";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST /api/facturas/upload-cfdi  (multipart/form-data, field "file", + companyId)
//
// Register a CFDI from an uploaded file. XML → exact parse (preferred). PDF →
// Claude vision extracts the key fields as a DRAFT, low-confidence (a PDF is
// just a rendering; the legal data lives in the XML). We always recommend the
// XML.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let file: File | null = null;
  let companyId = "";
  try {
    const fd = await req.formData();
    const f = fd.get("file");
    if (f instanceof File) file = f;
    companyId = String(fd.get("companyId") ?? "");
  } catch {
    return NextResponse.json({ error: "Espera multipart/form-data con 'file' y 'companyId'" }, { status: 400 });
  }
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!file) return NextResponse.json({ error: "Sube un archivo en el campo 'file'" }, { status: 400 });
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "El archivo excede 15 MB" }, { status: 413 });

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const isXml = file.type.includes("xml") || file.name.toLowerCase().endsWith(".xml");

  // ── XML path: exact, legally-correct ──────────────────────────────────────
  if (isXml) {
    const xml = await file.text();
    const result = await importCfdiFromXml({ companyId, companyRfc: company.rfc, xml });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  }

  // ── PDF path: vision, low-confidence DRAFT ────────────────────────────────
  const isPdf = file.type.includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json({ error: "Sube el XML del CFDI (recomendado) o el PDF." }, { status: 415 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Extracción con IA no configurada; sube el XML." }, { status: 503 });
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const anthropic = new Anthropic();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await meteredCreate(anthropic, { companyId, subtipo: "facturas.upload_cfdi" }, {
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    system: `Extrae los datos de esta factura/CFDI mexicana en JSON, sin markdown. Convención: tipo "INGRESO" si la empresa la emitió, "EGRESO" si la recibió. Campos: { "uuid": string|null, "fecha": "YYYY-MM-DD"|null, "rfcEmisor": string|null, "nombreEmisor": string|null, "rfcReceptor": string|null, "nombreReceptor": string|null, "subtotal": number, "totalImpuestos": number, "total": number, "metodoPago": "PUE"|"PPD"|null, "formaPago": string|null }. Montos como números. Si falta algo, null.`,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: "Extrae los datos de esta factura. Solo JSON." },
        ],
      },
    ],
  });

  const text = response.content.find((b: { type: string }) => b.type === "text")?.text ?? "";
  let p: {
    uuid: string | null; fecha: string | null; rfcEmisor: string | null;
    rfcReceptor: string | null; nombreEmisor: string | null; nombreReceptor: string | null;
    subtotal: number; totalImpuestos: number; total: number;
    metodoPago: string | null; formaPago: string | null;
  };
  try {
    p = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
  } catch {
    return NextResponse.json({ error: "No se pudo leer el PDF. Sube el XML del CFDI." }, { status: 502 });
  }
  // Folio fiscal canónico en MAYÚSCULAS (lo extrajo un LLM; puede venir en
  // minúsculas) para no duplicar el CFDI ni romper el empate de cancelaciones.
  if (p.uuid) p.uuid = p.uuid.toUpperCase();

  if (p.uuid) {
    // p.uuid ya viene en MAYÚSCULAS (parseCfdiXml lo canoniza); match insensible
    // a la caja para reconocer copias previas guardadas en minúsculas.
    const dup = await prisma.invoice.findFirst({ where: { companyId, uuid: { equals: p.uuid, mode: "insensitive" } }, select: { id: true } });
    if (dup) return NextResponse.json({ ok: true, invoiceId: dup.id, duplicate: true, message: "Este CFDI ya estaba registrado." });
  }

  const isEmisor = p.rfcEmisor === company.rfc;
  const tipo = isEmisor ? "INGRESO" : "EGRESO";
  const cpRfc = isEmisor ? p.rfcReceptor : p.rfcEmisor;
  const cpName = isEmisor ? p.nombreReceptor : p.nombreEmisor;
  let customerId: string | null = null;
  if (cpRfc && cpRfc !== "XAXX010101000") {
    const found = await prisma.customer.findFirst({ where: { companyId, rfc: cpRfc }, select: { id: true } });
    if (found) customerId = found.id;
    else if (cpName) {
      try {
        const c = await prisma.customer.create({ data: { companyId, rfc: cpRfc, razonSocial: cpName, regimenFiscal: "616" } });
        customerId = c.id;
      } catch { /* ignore */ }
    }
  }

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      customerId,
      tipo,
      fecha: p.fecha ? new Date(p.fecha) : new Date(),
      formaPago: p.formaPago ?? "99",
      metodoPago: p.metodoPago === "PPD" ? "PPD" : "PUE",
      usoCfdi: "G03",
      // PDF lossy → usoCfdi se asume G03; naturaleza queda GASTO por default
      // (sin items para detectar activo fijo). El re-upload del XML la corrige.
      naturaleza: tipo === "EGRESO" ? "GASTO" : null,
      subtotal: p.subtotal ?? 0,
      totalImpuestos: p.totalImpuestos ?? 0,
      total: p.total ?? 0,
      // DRAFT, not STAMPED: PDF extraction is not authoritative. The user must
      // verify (ideally re-upload the XML) before it counts as fiscal data.
      status: "DRAFT",
      uuid: p.uuid ?? null,
      notas: "Subido (PDF — verificar; se recomienda el XML)",
    },
  });

  return NextResponse.json({
    ok: true,
    invoiceId: invoice.id,
    uuid: p.uuid,
    lowConfidence: true,
    message: "Factura registrada como BORRADOR desde el PDF. Verifica los datos — para registro fiscal exacto sube el XML del CFDI.",
  });
}
