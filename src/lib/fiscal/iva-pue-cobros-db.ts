import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  calculatePueCollections,
  pueDay,
  type PueCollection,
  type PueTimingReview,
} from "./iva-pue-cobros";
import { variantesUuid } from "./uuid";
import { calcularActosDelPeriodo, type InvoiceConTaxes } from "./iva";
import { accountReview } from "@/lib/bancos/statements/review";

const LIMIT = 5000;
export const ivaTimingInput = z
  .object({
    companyId: z.string().min(1),
    expected: z.string().length(64),
    tratamiento: z.enum(["FLUJO_GENERAL", "REVISION_ESPECIAL"]),
    fechaCobro: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    evidencia: z.string().trim().max(1000).nullable().default(null),
    motivo: z.string().trim().min(15).max(2000),
  })
  .strict();
const storedReview = ivaTimingInput
  .omit({ companyId: true, expected: true })
  .extend({
    version: z.literal(1),
    fingerprint: z.string().length(64),
    actorId: z.string().min(1),
    reviewedAt: z.string().datetime(),
  });
export const pueInvoiceInclude = {
  taxes: true,
  items: { select: { claveProdServ: true, descripcion: true } },
  customer: { select: { razonSocial: true, rfc: true } },
} as const;
type Invoice = Prisma.InvoiceGetPayload<{ include: typeof pueInvoiceInclude }>;
const normalize = (i: Invoice) => ({
  ...i,
  total: Number(i.total),
  subtotal: Number(i.subtotal),
  descuento: Number(i.descuento),
  taxes: i.taxes.map((t) => ({
    ...t,
    tasa: Number(t.tasa),
    importe: Number(t.importe),
    base: t.base === null ? null : Number(t.base),
  })),
});
export function pueInvoiceFingerprint(i: Invoice): string {
  const n = normalize(i);
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: i.id,
        companyId: i.companyId,
        uuid: i.uuid,
        status: i.status,
        tipo: i.tipo,
        tipoSat: i.tipoSat,
        fecha: i.fecha.toISOString(),
        moneda: i.moneda,
        formaPago: i.formaPago,
        metodoPago: i.metodoPago,
        total: n.total,
        subtotal: n.subtotal,
        descuento: n.descuento,
        sustituidoPorUuid: i.sustituidoPorUuid,
        ivaNoCausado: i.ivaNoCausado,
        taxes: n.taxes
          .map(({ tipo, factor, tasa, base, importe, retencion }) => ({
            tipo,
            factor,
            tasa,
            base,
            importe,
            retencion,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        items: n.items
          .slice()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }),
    )
    .digest("hex");
}
export function readPueReview(i: Invoice): PueTimingReview | null {
  const result = storedReview.safeParse(i.ivaCausacionRevision);
  return result.success && result.data.fingerprint === pueInvoiceFingerprint(i)
    ? result.data
    : null;
}
export function pueReviewToken(i: Invoice): string {
  return createHash("sha256")
    .update(JSON.stringify([pueInvoiceFingerprint(i), i.ivaCausacionRevision]))
    .digest("hex");
}

const bankSelect = {
  id: true,
  companyId: true,
  invoiceId: true,
  bankAccountId: true,
  fecha: true,
  monto: true,
  tipo: true,
  referencia: true,
  bankAccount: { select: { companyId: true, moneda: true } },
  conciliacionDetalles: {
    take: LIMIT + 1,
    select: {
      invoiceId: true,
      montoAsignado: true,
      invoice: { select: { companyId: true } },
    },
  },
} as const;

/** A read-only snapshot; both the calculator and workpaper consume this contract. */
export async function loadPueIncomeCollections(
  companyId: string,
  from: Date,
  to: Date,
) {
  return prisma.$transaction(
    async (db) => {
      const period = pueDay(from).slice(0, 7);
      const invoices = await db.invoice.findMany({
        where: {
          companyId,
          tipo: "INGRESO",
          metodoPago: "PUE",
          AND: [{ OR: [{ tipoSat: "I" }, { tipoSat: null }] }],
          OR: [
            {
              status: "STAMPED",
              sustituidoPorUuid: null,
              fecha: { gte: from, lt: to },
            },
            {
              bankTransactions: {
                some: {
                  companyId,
                  status: "MATCHED",
                  fecha: { gte: from, lt: to },
                },
              },
            },
            {
              conciliacionDetalles: {
                some: {
                  bankTransaction: {
                    companyId,
                    status: "MATCHED",
                    fecha: { gte: from, lt: to },
                  },
                },
              },
            },
            {
              ivaCausacionRevision: {
                path: ["fechaCobro"],
                string_starts_with: period,
              },
            },
          ],
        },
        include: pueInvoiceInclude,
        take: LIMIT + 1,
        orderBy: { id: "asc" },
      });
      if (invoices.length > LIMIT)
        throw new Error(
          "Demasiados CFDI PUE para determinar el IVA con evidencia completa; divide la revisión. No se calculó un total parcial.",
        );
      const ids = invoices.map((i) => i.id);
      const byId = new Map(invoices.map((i) => [i.id, i]));
      const reviews = new Map(invoices.map((i) => [i.id, readPueReview(i)]));
      const movements = ids.length
        ? await db.bankTransaction.findMany({
            where: {
              companyId,
              status: "MATCHED",
              OR: [
                { invoiceId: { in: ids } },
                { conciliacionDetalles: { some: { invoiceId: { in: ids } } } },
              ],
            },
            select: bankSelect,
            take: LIMIT + 1,
            orderBy: [{ fecha: "asc" }, { id: "asc" }],
          })
        : [];
      if (
        movements.length > LIMIT ||
        movements.some((m) => m.conciliacionDetalles.length > LIMIT)
      )
        throw new Error(
          "Demasiadas aplicaciones PUE para determinar el IVA completo. No se calculó un total parcial.",
        );
      const byInvoice = new Map<string, PueCollection[]>(),
        issues = new Map<string, string[]>();
      const statementIssues = new Map<string, string[]>();
      const scopes = new Map(
        movements
          .filter((m) => m.bankAccount.companyId === companyId)
          .map((m) => [
            `${m.bankAccountId}|${pueDay(m.fecha).slice(0, 7)}`,
            {
              companyId,
              bankAccountId: m.bankAccountId,
              year: m.fecha.getUTCFullYear(),
              month: m.fecha.getUTCMonth() + 1,
            },
          ]),
      );
      if (scopes.size > 120)
        throw new Error(
          "Demasiados periodos bancarios para revisar en un solo cálculo de IVA PUE.",
        );
      for (const [key, scope] of scopes) {
        const bank = await accountReview(scope, db);
        if (!bank.verified)
          statementIssues.set(key, [
            "El estado de cuenta del cobro está provisional o cambió. Verifica su original en Bancos o documenta el cobro completo con evidencia independiente.",
          ]);
        if (bank.duplicates.length || bank.unresolved.length)
          statementIssues.set(key, [
            "Hay duplicados o filas bancarias pendientes de decidir en el periodo del cobro. Resuelve la revisión bancaria antes de determinar el IVA.",
          ]);
      }
      const issue = (id: string, message: string) =>
        issues.set(id, [...(issues.get(id) ?? []), message]);
      for (const m of movements) {
        const allocated = m.conciliacionDetalles;
        // Detailed applications are canonical. A legacy pointer must never add
        // the whole movement a second time to the same invoice.
        const links = allocated.length
          ? allocated.map((d) => ({
              id: d.invoiceId,
              monto: Number(d.montoAsignado),
            }))
          : m.invoiceId
            ? [{ id: m.invoiceId, monto: Number(m.monto) }]
            : [];
        const linkedIds = new Set([
          ...links.map((l) => l.id),
          ...(m.invoiceId ? [m.invoiceId] : []),
        ]);
        const invalid =
          m.bankAccount.companyId !== companyId ||
          m.bankAccount.moneda !== "MXN" ||
          m.tipo !== "CREDITO" ||
          Number(m.monto) <= 0 ||
          allocated.some(
            (d) =>
              d.invoice.companyId !== companyId || Number(d.montoAsignado) <= 0,
          ) ||
          allocated.reduce(
            (s, d) => s + Math.round(Number(d.montoAsignado) * 100),
            0,
          ) >
            Math.round(Number(m.monto) * 100) + 1 ||
          Boolean(
            m.invoiceId &&
              allocated.length &&
              (allocated.length !== 1 ||
                allocated[0].invoiceId !== m.invoiceId ||
                Math.abs(Number(allocated[0].montoAsignado) - Number(m.monto)) >
                  0.01),
          );
        if (invalid) {
          for (const id of linkedIds)
            if (byId.has(id))
              issue(
                id,
                "Aplicación bancaria contradictoria, moneda no soportada o dirección incorrecta. Revisa el movimiento y sus porciones.",
              );
          continue;
        }
        for (const link of links)
          if (byId.has(link.id)) {
            byInvoice.set(link.id, [
              ...(byInvoice.get(link.id) ?? []),
              {
                id: m.id,
                fecha: m.fecha,
                monto: link.monto,
                referencia: m.referencia ?? m.id,
              },
            ]);
            // A separately documented full receipt can corroborate a provisional
            // statement, but cannot override unresolved duplicates/applications.
            for (const message of statementIssues.get(
              `${m.bankAccountId}|${pueDay(m.fecha).slice(0, 7)}`,
            ) ?? []) {
              if (
                !reviews.get(link.id)?.fechaCobro ||
                message.startsWith("Hay duplicados")
              )
                issue(link.id, message);
            }
          }
      }
      const uuids = variantesUuid(invoices.map((i) => i.uuid));
      const notes = uuids.length
        ? await db.invoice.findMany({
            where: {
              companyId,
              tipo: "INGRESO",
              tipoSat: "E",
              status: "STAMPED",
              cfdiRelacionadoUuid: { in: uuids },
            },
            select: { cfdiRelacionadoUuid: true },
            take: LIMIT + 1,
          })
        : [];
      if (notes.length > LIMIT)
        throw new Error(
          "Demasiadas notas relacionadas para revisar el cobro PUE completo.",
        );
      const notesParents = new Set(
        notes.map((n) => n.cfdiRelacionadoUuid?.toUpperCase()),
      );
      const rows = invoices.map((i) => {
        const review = reviews.get(i.id) ?? null,
          extra = [...(issues.get(i.id) ?? [])];
        if (i.status !== "STAMPED" || i.sustituidoPorUuid)
          extra.push(
            "El cobro está ligado a un CFDI no vigente o sustituido. Vincula el comprobante vigente y revisa la operación; cancelar el CFDI no demuestra devolver el cobro.",
          );
        if (i.ivaCausacionRevision && !review)
          extra.push(
            "La revisión fiscal quedó desactualizada al cambiar el CFDI; confirma de nuevo el tratamiento y su evidencia.",
          );
        if (i.uuid && notesParents.has(i.uuid.toUpperCase()))
          extra.push(
            "El CFDI tiene notas de crédito: revisa el efecto del cobro y la restitución de IVA antes de determinar el periodo.",
          );
        if (
          !["02", "03"].includes(i.formaPago) &&
          !review?.fechaCobro &&
          !i.ivaNoCausado
        )
          extra.push(
            "Esta forma de pago requiere documentar su fecha efectiva: la fecha del depósito bancario puede ser posterior al cobro (LIVA 1-B).",
          );
        return {
          invoice: normalize(i),
          fingerprint: pueReviewToken(i),
          review,
          result: calculatePueCollections(
            normalize(i),
            byInvoice.get(i.id) ?? [],
            from,
            to,
            review,
            extra,
          ),
        };
      });
      const affected = new Set(
        rows.flatMap((r) =>
          [r.result.fechaCfdi, ...r.result.fechasCobro].map((d) =>
            d.slice(0, 7),
          ),
        ),
      );
      const [filed, closed] = await Promise.all([
        affected.size
          ? db.taxDeclaration.findMany({
              where: {
                companyId,
                tipo: "IVA_MENSUAL",
                periodo: { in: [...affected] },
                status: { in: ["FILED", "PAID"] },
              },
              select: { periodo: true },
            })
          : [],
        affected.size
          ? db.accountingPeriod.findMany({
              where: {
                companyId,
                status: "CLOSED",
                OR: [...affected].map((p) => ({
                  year: Number(p.slice(0, 4)),
                  month: Number(p.slice(5, 7)),
                })),
              },
              select: { year: true, month: true },
            })
          : [],
      ]);
      const crossPeriods = new Set(
        rows
          .filter((r) =>
            r.result.fechasCobro.some(
              (d) => d.slice(0, 7) !== r.result.fechaCfdi.slice(0, 7),
            ),
          )
          .flatMap((r) =>
            [r.result.fechaCfdi, ...r.result.fechasCobro].map((d) =>
              d.slice(0, 7),
            ),
          ),
      );
      const locked = [
        ...new Set([
          ...filed.map((f) => f.periodo),
          ...closed.map((c) => `${c.year}-${String(c.month).padStart(2, "0")}`),
        ]),
      ].filter((p) => crossPeriods.has(p));
      const summary = {
        determinado: rows.every((r) => r.result.determinado),
        importeDeterminado: rows.every((r) => r.result.determinado)
          ? Math.round(
              rows.reduce((s, r) => s + r.result.trasladado, 0) * 100,
            ) / 100
          : null,
        trasladado:
          Math.round(rows.reduce((s, r) => s + r.result.trasladado, 0) * 100) /
          100,
        retenido:
          Math.round(rows.reduce((s, r) => s + r.result.retenido, 0) * 100) /
          100,
        gravados:
          Math.round(rows.reduce((s, r) => s + r.result.gravados, 0) * 100) /
          100,
        exentos:
          Math.round(rows.reduce((s, r) => s + r.result.exentos, 0) * 100) /
          100,
        pendientes: rows
          .filter((r) => !r.result.determinado)
          .map((r) => ({
            invoiceId: r.invoice.id,
            uuid: r.invoice.uuid,
            motivos: r.result.incidencias,
          })),
        periodosARevisar: locked,
        asignaciones: rows.map((r) => ({ ...r.result, uuid: r.invoice.uuid })),
      };
      return { rows, summary };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30000,
    },
  );
}

export function pueCollectionWarnings(
  summary: Awaited<ReturnType<typeof loadPueIncomeCollections>>["summary"],
): string[] {
  return [
    ...(!summary.determinado
      ? [
          `IVA PUE preliminar: ${summary.pendientes.length} CFDI(s) requieren confirmar el cobro o el tratamiento fiscal. No uses la estimación como declaración definitiva; revisa el papel de IVA.`,
        ]
      : []),
    ...summary.periodosARevisar.map(
      (p) =>
        `Revisa ${p}: un cobro y su CFDI pertenecen a meses distintos y el periodo ya está cerrado o declarado. No se modificó la declaración ni la contabilidad guardada.`,
    ),
  ];
}

export function actosConCobrosPue(
  invoices: (InvoiceConTaxes & {
    metodoPago: string;
    tipoSat: string | null;
  })[],
  summary: { gravados: number; exentos: number },
) {
  const other = calcularActosDelPeriodo(
    invoices.filter((i) => i.metodoPago !== "PUE" || i.tipoSat === "E"),
  );
  const gravados = Math.round((other.gravados + summary.gravados) * 100) / 100;
  const exentos = Math.round((other.exentos + summary.exentos) * 100) / 100;
  return {
    gravados,
    exentos,
    proporcion:
      exentos > 0 && gravados + exentos > 0
        ? gravados / (gravados + exentos)
        : 1,
  };
}
