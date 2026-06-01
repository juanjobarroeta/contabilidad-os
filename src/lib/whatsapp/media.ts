import { prisma } from "@/lib/prisma";
import { extractStatementFromDocument } from "@/lib/bancos/vision-statement";
import { persistTransactions } from "@/lib/bancos/import";
import { importCfdiFromXml } from "@/lib/facturas/import-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp inbound media → the right extractor.
//
// - XML → CFDI register (exact).
// - PDF/image → classify: bank statement vs invoice, then extract.
// Returns a short Spanish summary to send back to the user. Never throws to the
// caller — always returns a user-facing message.
// ─────────────────────────────────────────────────────────────────────────────

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

function classifyContentType(ct: string, filename: string): "xml" | "pdf" | "image" | "audio" | "other" {
  const c = ct.toLowerCase();
  const f = filename.toLowerCase();
  if (c.includes("xml") || f.endsWith(".xml")) return "xml";
  if (c.includes("pdf") || f.endsWith(".pdf")) return "pdf";
  if (c.startsWith("image/")) return "image";
  if (c.startsWith("audio/")) return "audio";
  return "other";
}

/** Picks a bank account for statement import: explicit only-account, else null. */
async function resolveBankAccount(companyId: string): Promise<string | null> {
  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true },
    take: 2,
  });
  return accounts.length === 1 ? accounts[0].id : null;
}

export async function handleWhatsappMedia(opts: {
  companyId: string;
  buffer: Buffer;
  contentType: string;
  filename: string;
}): Promise<string> {
  const { companyId, buffer, contentType, filename } = opts;
  const kind = classifyContentType(contentType, filename);

  // ── XML → exact CFDI register ─────────────────────────────────────────────
  if (kind === "xml") {
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
    if (!company) return "No encontré la empresa para registrar el CFDI.";
    try {
      const r = await importCfdiFromXml({ companyId, companyRfc: company.rfc, xml: buffer.toString("utf-8") });
      if (!r.ok) return "No pude leer ese XML como CFDI válido.";
      return r.duplicate ? "Ese CFDI ya estaba registrado. ✅" : "Listo, registré el CFDI. ✅";
    } catch {
      return "Tuve un problema registrando el CFDI. Inténtalo de nuevo.";
    }
  }

  // Audio is handled upstream (transcription) before reaching here.
  if (kind !== "pdf" && kind !== "image") {
    return "No reconozco ese tipo de archivo. Mándame un PDF, una foto, o el XML del CFDI.";
  }

  // ── PDF/image: classify statement vs invoice via vision ───────────────────
  const mediaType =
    kind === "pdf"
      ? ("application/pdf" as const)
      : contentType.includes("png")
      ? ("image/png" as const)
      : contentType.includes("webp")
      ? ("image/webp" as const)
      : ("image/jpeg" as const);

  // The statement extractor returns balances + movimientos; if it finds neither,
  // it's probably an invoice — fall back to the invoice nudge.
  let extraction;
  try {
    extraction = await extractStatementFromDocument(buffer, mediaType);
  } catch {
    return "No pude leer el documento. Manda un archivo más claro, o si es una factura, su XML.";
  }

  // Heuristic: a bank statement has multiple movimientos and/or balances.
  const looksLikeStatement =
    extraction.transactions.length >= 2 ||
    extraction.balanceCheck.saldoInicial != null ||
    extraction.balanceCheck.saldoFinal != null;

  if (!looksLikeStatement) {
    return (
      "Parece una factura, no un estado de cuenta. Para registrarla con exactitud, " +
      "mándame el *XML* del CFDI (el PDF no es suficiente para uso fiscal)."
    );
  }

  // It's a statement. Balance must reconcile before we import.
  if (extraction.transactions.length === 0) {
    return "No detecté movimientos en ese estado de cuenta. ¿Puedes mandar el archivo del banco (CSV/Excel) o una imagen más clara?";
  }
  if (extraction.balanceCheck.cuadra === false) {
    return (
      `Leí ${extraction.transactions.length} movimientos pero los *saldos no cuadran* ` +
      `(diferencia ${MXN(extraction.balanceCheck.diferencia ?? 0)}). No lo importé para no meter datos incorrectos. ` +
      "Revísalo en la app o mándame el archivo CSV/Excel del banco."
    );
  }

  const bankAccountId = await resolveBankAccount(companyId);
  if (!bankAccountId) {
    return (
      `Leí ${extraction.transactions.length} movimientos y los saldos cuadran ✅, pero tienes varias cuentas bancarias ` +
      "(o ninguna). Dime a cuál cuenta van, o súbelo desde la app en la cuenta correcta."
    );
  }

  const { imported, skipped } = await persistTransactions({
    bankAccountId,
    companyId,
    transactions: extraction.transactions,
    source: "WHATSAPP",
  });

  const banco = extraction.banco ? ` de ${extraction.banco}` : "";
  return (
    `Listo ✅ Importé ${imported} movimiento(s)${banco}` +
    `${skipped > 0 ? ` (${skipped} ya existían)` : ""}. Los saldos cuadran. ` +
    "Ya puedes conciliarlos en la app."
  );
}
