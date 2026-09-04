import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { whereBusquedaFacturas } from "@/lib/facturas/busqueda";
import { recordTimbrado } from "@/lib/costos/record";
import { ensureFacturapiCustomer, getFacturapiClient } from "@/lib/facturapi";
import { parseFacturapiError } from "@/lib/facturapi-errors";
import { z } from "zod";
import { getEffectiveCompanyMembership, requireScope, requireUser, AuthzError } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { gateEscritura } from "@/lib/subscription";
import { MAX_LARGO_CUENTA_PREDIAL, normalizarCuentaPredial } from "@/lib/facturas/predial";
import { invoiceTaxRowsFromItems } from "@/lib/facturas/taxes-persist";

const invoiceItemSchema = z.object({
  quantity: z.number().positive(),
  // Cuenta predial del inmueble arrendado (CFDI 4.0: nodo CuentaPredial del
  // concepto). Va en la PARTIDA, no en el producto. Sin validación de formato:
  // la cuenta catastral la define cada municipio y no hay dígito verificador
  // universal — sólo se acota el largo del atributo del SAT.
  cuentaPredial: z.string().trim().min(1).max(MAX_LARGO_CUENTA_PREDIAL).optional(),
  product: z.object({
    description: z.string(),
    product_key: z.string(),
    price: z.number().positive(),
    unit_key: z.string().default("E48"),
    tax_included: z.boolean().default(false),
    taxes: z
      .array(
        z.object({
          type: z.string(),
          rate: z.number(),
          factor: z.string(),
          withholding: z.boolean().default(false),
        })
      )
      .optional(),
    // Impuestos locales (complemento implocal): e.g. la retención local "5 al
    // millar" en contratos de gobierno. `type` es el nombre que aparece como
    // ImpLocRetenido; `rate` es la tasa en fracción (0.005 = 0.50%).
    local_taxes: z
      .array(
        z.object({
          type: z.string(),
          rate: z.number(),
          withholding: z.boolean().default(false),
          // Optional explicit base. Lets a caller emit a single consolidated
          // local retención (one RetencionesLocales node) by attaching it to one
          // concept with base = the whole subtotal, instead of one node per item.
          base: z.number().optional(),
        })
      )
      .optional(),
  }),
});

const createInvoiceSchema = z.object({
  companyId: z.string(),
  customerId: z.string(),
  formaPago: z.string(),
  metodoPago: z.enum(["PUE", "PPD"]),
  usoCfdi: z.string(),
  items: z.array(invoiceItemSchema),
  notes: z.string().optional(),
  // Llave de idempotencia (alternativa al header Idempotency-Key). Única por
  // empresa: reintentos con la misma llave NO timbran un segundo CFDI.
  idempotencyKey: z.string().min(1).max(200).optional(),
  global: z.object({
    periodicity: z.enum(["day", "week", "fortnight", "month", "two_months"]),
    months: z.string(),
    year: z.number(),
  }).optional(),
});

// GET /api/facturas?companyId=xxx&q=search&tipo=EGRESO&take=20
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  // Verify membership
  const membership = await getEffectiveCompanyMembership(user.id, companyId);
  if (!membership) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const q = searchParams.get("q")?.trim();
  const tipo = searchParams.get("tipo");
  const take = Math.min(parseInt(searchParams.get("take") ?? "50"), 200);
  // Offset pagination for API consumers that walk the full list (e.g.
  // FlotaGob's invoice sync). Backward compatible: defaults to 0.
  const skip = Math.max(0, parseInt(searchParams.get("skip") ?? "0") || 0);
  const customerId = searchParams.get("customerId")?.trim() || null;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const unmatchedOnly = searchParams.get("unmatchedOnly") === "true";

  const where: import("@prisma/client").Prisma.InvoiceWhereInput = { companyId };
  // Mismo contrato que /export: "CANCELLED" es un valor especial que trae SÓLO
  // las canceladas; cualquier otro tipo las EXCLUYE. Una cancelada no es "te
  // pagaron" ni candidata de conciliación (bancos usa este endpoint), y el
  // chip de la pantalla de Facturas ya la trata como categoría propia.
  if (tipo === "CANCELLED") {
    where.status = "CANCELLED";
  } else if (tipo && ["INGRESO", "EGRESO", "TRASLADO", "NOMINA", "PAGO"].includes(tipo)) {
    where.tipo = tipo as "INGRESO" | "EGRESO" | "TRASLADO" | "NOMINA" | "PAGO";
    where.status = { not: "CANCELLED" };
  }
  if (customerId) where.customerId = customerId;
  // Optional fecha window (ISO dates); invalid values are ignored.
  const fromDate = fromParam ? new Date(fromParam) : null;
  const toDate = toParam ? new Date(toParam) : null;
  const validFrom = fromDate && !isNaN(fromDate.getTime()) ? fromDate : null;
  const validTo = toDate && !isNaN(toDate.getTime()) ? toDate : null;
  if (validFrom || validTo) {
    where.fecha = {
      ...(validFrom ? { gte: validFrom } : {}),
      ...(validTo ? { lte: validTo } : {}),
    };
  }
  // Por palabras, no por frase: «victor bilbao» encuentra a VICTOR JOSE BILBAO.
  const busqueda = whereBusquedaFacturas(q);
  if (busqueda) where.AND = busqueda.AND;

  // When unmatchedOnly, pull extra rows and filter in code since aggregating
  // against bankTransactions requires either raw SQL or a two-step query.
  const fetchTake = unmatchedOnly ? Math.min(take * 4, 400) : take;

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      customer: true,
      items: true,
      bankTransactions: {
        where: { status: "MATCHED" },
        select: { id: true, monto: true },
      },
      // Conciliación uno-a-varios: porciones asignadas a esta factura.
      conciliacionDetalles: { select: { montoAsignado: true } },
      // Para los REP (tipo PAGO) el comprobante trae Total/IVA = 0; los montos
      // reales viven en el complemento. Los exponemos para que el detalle no
      // muestre $0.00.
      doctosRelacionados: { select: { impPagado: true, ivaTrasladado: true, fechaPago: true } },
    },
    // El desempate por id hace DETERMINISTA la paginación: con sólo `fecha`,
    // los comprobantes que comparten timestamp (importaciones masivas del SAT)
    // pueden reordenarse entre páginas y salir duplicados o perderse al paginar.
    orderBy: [{ fecha: "desc" }, { id: "desc" }],
    skip,
    take: fetchTake,
  });

  const enriched = invoices.map((inv) => {
    // Neto firmado: un reembolso (cargo) resta de lo cobrado, así un sobrepago
    // y su devolución dan el total exacto en vez de sobre-conciliar. Las
    // porciones asignadas (conciliación múltiple) suman por su monto asignado.
    const matchedAmount =
      Math.abs(inv.bankTransactions.reduce((s, tx) => s + Number(tx.monto), 0)) +
      inv.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0);
    const fullyMatched = matchedAmount >= Number(inv.total) - 0.01;
    // Totales del REP desde el complemento (monto pagado, IVA trasladado y la
    // fecha de pago — que es la que causa el IVA, no la fecha del comprobante).
    const esPago = inv.tipo === "PAGO";
    const pagoMonto = esPago ? inv.doctosRelacionados.reduce((s, d) => s + Number(d.impPagado ?? 0), 0) : null;
    const pagoIva = esPago ? inv.doctosRelacionados.reduce((s, d) => s + Number(d.ivaTrasladado ?? 0), 0) : null;
    const pagoFecha = esPago
      ? inv.doctosRelacionados.map((d) => d.fechaPago).filter(Boolean).sort()[0] ?? null
      : null;
    // bankTransactions / conciliacionDetalles / doctosRelacionados sólo se
    // cargaron para derivar lo de arriba.
    const { bankTransactions: _bts, conciliacionDetalles: _cd, doctosRelacionados: _dr, ...rest } = inv;
    void _bts; void _cd; void _dr;
    return { ...rest, matchedAmount, fullyMatched, pagoMonto, pagoIva, pagoFecha };
  });

  const filtered = unmatchedOnly ? enriched.filter((i) => !i.fullyMatched) : enriched;

  return NextResponse.json(filtered.slice(0, take));
}

// POST /api/facturas — emit CFDI via Facturapi
export async function POST(req: Request) {
  let userId: string;
  let userEmail: string | null = null;
  try {
    const user = await requireUser(req);
    requireScope(user, "facturas"); // sólo aplica a tokens emitidos con scope
    userId = user.id;
    userEmail = user.email;
  } catch (e) {
    const status = e instanceof AuthzError ? e.status : 401;
    const error = e instanceof AuthzError ? e.message : "Unauthorized";
    return NextResponse.json({ error }, { status });
  }

  const body = await req.json();
  const parsed = createInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { companyId, customerId, formaPago, metodoPago, usoCfdi, items, notes, global: globalInfo } = parsed.data;

  // Llave de idempotencia: header Idempotency-Key (preferido) o campo del body.
  // Sin llave (llamadores externos/API) el flujo es exactamente el de siempre.
  const idempotencyKey =
    req.headers.get("idempotency-key")?.trim() || parsed.data.idempotencyKey?.trim() || null;

  // Verify membership with at least ACCOUNTANT role
  const membership = await getEffectiveCompanyMembership(userId, companyId);
  if (!membership || membership.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(userId);
  if (gate) return gate;

  // Get company + customer
  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId } }),
    prisma.customer.findUnique({ where: { id: customerId } }),
  ]);

  if (!company?.facturapiApiKey) {
    return NextResponse.json(
      { error: "Configura la clave de Facturapi en la empresa antes de timbrar" },
      { status: 422 }
    );
  }
  if (!customer) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }
  // Sync perezoso: si el cliente aún no existe en Facturapi, se registra AQUÍ
  // (antes esto era un 422 sin salida — ver ensureFacturapiCustomer).
  const sync = await ensureFacturapiCustomer(company.facturapiApiKey, customer);
  if (!sync.ok) {
    return NextResponse.json({ error: sync.error }, { status: 422 });
  }

  const facturapi = getFacturapiClient(company.facturapiApiKey);

  // CFDI 4.0: Información Global is mandatory when RFC = XAXX010101000
  const isPublicoGeneral = customer.rfc === "XAXX010101000";
  let resolvedGlobal = globalInfo;
  if (isPublicoGeneral && !resolvedGlobal) {
    // Auto-build a sensible default: current month, monthly periodicity
    const now = new Date();
    resolvedGlobal = {
      periodicity: "month",
      months: String(now.getMonth() + 1).padStart(2, "0"),
      year: now.getFullYear(),
    };
  }

  console.log("[facturas] isPublicoGeneral:", isPublicoGeneral, "global:", resolvedGlobal);

  // Subtotal desde los items del request (fuente de verdad; ver nota abajo
  // sobre el subtotal de Facturapi). Se necesita ya para la reserva.
  const computedSubtotal = items.reduce(
    (s, it) => s + it.quantity * it.product.price,
    0
  );

  // ── Idempotencia: RESERVAR la llave ANTES de timbrar ───────────────────────
  // Creamos una fila DRAFT con la llave antes de llamar al PAC. Si otro request
  // ya la reservó, el create truena con P2002 en @@unique([companyId,
  // idempotencyKey]) y devolvemos la factura existente (200 si ya se timbró,
  // 409 si sigue en proceso) — nunca se consume un segundo timbre.
  // Si el timbrado falla, borramos la reserva para que el reintento funcione.
  // Nota: si el proceso muere ENTRE la reserva y el timbrado/borrado (crash,
  // deploy), queda una fila DRAFT huérfana que responde 409 para esa llave;
  // como el UI genera una llave nueva por clic, el usuario simplemente vuelve
  // a intentar. Borrar la fila DRAFT a mano la libera.
  let reservedInvoiceId: string | null = null;
  if (idempotencyKey) {
    try {
      const reserved = await prisma.invoice.create({
        data: {
          companyId,
          customerId,
          tipo: "INGRESO",
          fecha: new Date(),
          formaPago,
          metodoPago,
          usoCfdi,
          subtotal: computedSubtotal,
          total: computedSubtotal,
          notas: notes,
          status: "DRAFT",
          idempotencyKey,
        },
      });
      reservedInvoiceId = reserved.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const existing = await prisma.invoice.findUnique({
          where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
          include: { items: true, customer: true },
        });
        if (existing && existing.status !== "DRAFT") {
          // Replay de un request ya completado: misma respuesta, sin re-timbrar.
          return NextResponse.json(existing, { status: 200 });
        }
        return NextResponse.json(
          { error: "La factura ya se está procesando" },
          { status: 409 }
        );
      }
      throw e;
    }
  }

  // Create invoice in Facturapi — wrap in try/catch so SDK errors become
  // structured 422s instead of opaque 500s. Also detects a dead/unauthorized
  // key so we can tell the user to re-provision Facturapi.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facturapiInvoice: any;
  try {
    facturapiInvoice = await facturapi.invoices.create({
      customer: sync.facturapiId,
      payment_form: formaPago,
      payment_method: metodoPago,
      use: usoCfdi,
      items: items.map((item) => ({
        quantity: item.quantity,
        product: item.product,
        // Arrendamiento: CuentaPredial va en la partida y Facturapi la recibe
        // como arreglo (un concepto puede amparar varias cuentas catastrales).
        ...(normalizarCuentaPredial(item.cuentaPredial)
          ? { property_tax_account: [normalizarCuentaPredial(item.cuentaPredial)!] }
          : {}),
      })),
      ...(notes && { pdf_custom_section: notes }),
      ...(resolvedGlobal && { global: resolvedGlobal }),
    });
  } catch (e) {
    // El timbrado falló: liberar la reserva de idempotencia para que un
    // reintento (misma llave u otra) pueda volver a timbrar.
    if (reservedInvoiceId) {
      await prisma.invoice
        .delete({ where: { id: reservedInvoiceId } })
        .catch((delErr) => console.error("[facturas] No se pudo liberar la reserva:", delErr));
    }
    const info = parseFacturapiError(e);
    console.error("[facturas] Facturapi error:", info);
    return NextResponse.json(
      {
        error: info.message,
        kind: info.kind,
        needsReconfigure: info.needsReconfigure,
        details: info.details,
      },
      { status: info.status }
    );
  }
  // Costo del timbre (fire-and-forget).
  void recordTimbrado("factura", 1, { companyId, subtipo: "facturas.create" });

  // Compute totals.
  // The Facturapi SDK sometimes returns `subtotal: 0` when there are no taxes
  // (e.g. water sales exempt from IVA), which would corrupt our DB row.
  // Always trust the request items as the source of truth for subtotal
  // (computedSubtotal, calculado arriba), and compute totalImpuestos as the
  // residual from Facturapi's authoritative total (which already accounts for
  // retenciones, descuentos, etc.).
  const total = facturapiInvoice.total ?? computedSubtotal;
  // Trust Facturapi's subtotal only if it's meaningfully > 0
  const subtotal =
    typeof facturapiInvoice.subtotal === "number" && facturapiInvoice.subtotal > 0.01
      ? facturapiInvoice.subtotal
      : computedSubtotal;
  const totalImpuestos = +(total - subtotal).toFixed(2);

  // Persist to DB: los datos comunes a ambos caminos (reserva vs directo).
  const stampedData = {
    subtotal,
    total,
    totalImpuestos,
    status: "STAMPED" as const,
    uuid: facturapiInvoice.uuid?.toUpperCase() ?? null, // folio fiscal canónico en MAYÚSCULAS
    facturapiId: facturapiInvoice.id,
    items: {
      create: items.map((item) => ({
        cantidad: item.quantity,
        claveUnidad: item.product.unit_key ?? "E48",
        claveProdServ: item.product.product_key,
        descripcion: item.product.description,
        valorUnitario: item.product.price,
        importe: item.quantity * item.product.price,
        cuentaPredial: normalizarCuentaPredial(item.cuentaPredial),
      })),
    },
    // Desglose de impuestos del comprobante, derivado de lo que se mandó al
    // PAC. Sin estas filas, la factura no puede llevar complemento de pago
    // (el REP arma los impuestos del documento relacionado desde aquí) y los
    // papeles de IVA la ven sin desglose. El backfill por rawXml no alcanza a
    // las timbradas en la app: no guardan XML.
    taxes: {
      create: invoiceTaxRowsFromItems(items),
    },
  };

  // Con reserva: promover la fila DRAFT a STAMPED. Sin llave: crear como siempre.
  const invoice = reservedInvoiceId
    ? await prisma.invoice.update({
        where: { id: reservedInvoiceId },
        data: stampedData,
        include: { items: true, customer: true },
      })
    : await prisma.invoice.create({
        data: {
          companyId,
          customerId,
          tipo: "INGRESO",
          fecha: new Date(),
          formaPago,
          metodoPago,
          usoCfdi,
          notas: notes,
          ...stampedData,
        },
        include: { items: true, customer: true },
      });

  // Bitácora de seguridad: timbrado exitoso (fire-and-forget).
  registrarBitacora({
    companyId,
    userId,
    actorEmail: userEmail,
    accion: "factura.timbrar",
    entidad: "Invoice",
    entidadId: invoice.id,
    detalle: {
      uuid: invoice.uuid,
      total: invoice.total,
      clienteRfc: customer.rfc,
    },
    req,
  });

  return NextResponse.json(invoice, { status: 201 });
}
