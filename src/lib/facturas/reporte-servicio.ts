// ─────────────────────────────────────────────────────────────────────────────
// Reporte de facturas: quién puede pedirlo, cómo se guarda y cómo se descarga.
// Lo usan las dos caras de Mochi — el copiloto del hub (ContaBot) y la
// mascota de HospitalOS — para que las reglas sean una sola.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  consultarReporte,
  filtrosSchema,
  resolverContrapartes,
  resumir,
  tituloReporte,
  type Ambiguedad,
  type ResumenReporte,
} from "./reporte-facturas";

type Db = PrismaClient | Prisma.TransactionClient;

/** Páginas de HospitalOS desde las que ya se ven facturas. */
export const PAGINAS_CON_FACTURAS = ["facturacion", "clientes", "proveedores", "cuentas", "caja", "compras", "bancos", "contabilidad", "impuestos", "tesoreria"];

/**
 * ¿Este usuario puede ver facturas de esta empresa? Miembro (o acceso por
 * despacho), sin cuenta de sólo-construcción/purificadora, y en el hospital
 * con alguna página de finanzas (lista vacía = ve todo).
 */
export function decidirAccesoFacturas(m: {
  miembro: boolean;
  allowedModules: string[];
  hospitalPaginas: string[];
  satelite?: boolean;
}): { ok: true } | { ok: false; motivo: string } {
  if (!m.miembro) return { ok: false, motivo: "Sin acceso a esta empresa." };
  if (m.allowedModules.length > 0 && !m.allowedModules.some((x) => x === "CONTABILIDAD" || x === "HOSPITAL")) {
    return { ok: false, motivo: "Tu cuenta no tiene acceso a facturas." };
  }
  if (m.hospitalPaginas.length > 0 && !m.hospitalPaginas.some((p) => PAGINAS_CON_FACTURAS.includes(p))) {
    return { ok: false, motivo: "Tu usuario no ve facturas: pide a un administrador acceso a Facturación, Clientes o Proveedores." };
  }
  return { ok: true };
}

export async function puedeVerFacturas(db: Db, userId: string, companyId: string) {
  // Import diferido: authz arrastra next-auth, que no hace falta para lo puro.
  const { getEffectiveCompanyMembership } = await import("@/lib/authz");
  const efectivo = await getEffectiveCompanyMembership(userId, companyId, { platformOperatorMode: "deny" });
  const directo = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { allowedModules: true, hospitalPaginas: true, construccionRol: true, purifPuesto: true },
  });
  if (directo?.construccionRol || directo?.purifPuesto) return { ok: false as const, motivo: "Tu cuenta no tiene acceso a facturas." };
  return decidirAccesoFacturas({
    miembro: !!efectivo,
    allowedModules: directo?.allowedModules ?? [],
    hospitalPaginas: directo?.hospitalPaginas ?? [],
  });
}

export type ResultadoReporte =
  | { estado: "LISTO"; id: string; titulo: string; resumen: ResumenReporte; cortado: boolean }
  | { estado: "ACLARAR"; ambiguas: Ambiguedad[]; noEncontradas: string[] }
  | { estado: "SIN_PERMISO"; motivo: string };

/** Valida, resuelve contrapartes, corre la consulta, guarda el reporte y deja rastro. */
export async function crearReporte(db: Db, args: { companyId: string; userId: string; origen: "contabot" | "hospital-ayuda"; filtros: unknown }): Promise<ResultadoReporte> {
  const acceso = await puedeVerFacturas(db, args.userId, args.companyId);
  if (!acceso.ok) return { estado: "SIN_PERMISO", motivo: acceso.motivo };
  const filtros = filtrosSchema.parse(args.filtros ?? {});
  let customerIds: string[] | null = null;
  let nombres: string[] = [];
  if (filtros.contrapartes?.length) {
    const r = await resolverContrapartes(db, args.companyId, filtros.contrapartes);
    if (r.ambiguas.length || r.noEncontradas.length) return { estado: "ACLARAR", ambiguas: r.ambiguas, noEncontradas: r.noEncontradas };
    customerIds = [...new Set(r.resueltas.flatMap((x) => x.customerIds))];
    nombres = r.resueltas.map((x) => x.nombre ?? x.termino);
  }
  const { rows, cortado } = await consultarReporte(db, args.companyId, filtros, customerIds);
  const resumen = resumir(rows);
  const titulo = tituloReporte(filtros, nombres);
  const fila = await db.reporteFacturas.create({
    data: {
      companyId: args.companyId,
      userId: args.userId,
      origen: args.origen,
      titulo,
      filtros: filtros as unknown as Prisma.InputJsonValue,
      customerIds: customerIds ?? [],
      resumen: resumen as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await db.auditLog.create({
    data: { companyId: args.companyId, userId: args.userId, accion: "facturas.reporte", entidad: "ReporteFacturas", entidadId: fila.id, detalle: { origen: args.origen, titulo, facturas: resumen.facturas } },
  });
  return { estado: "LISTO", id: fila.id, titulo, resumen, cortado };
}

// ── Enlaces de descarga firmados ─────────────────────────────────────────────
// HospitalOS habla con el hub con un token Bearer que un <a href> no manda:
// el enlace lleva su propia firma, atada al reporte y al formato, y caduca.

const TTL_MS = 24 * 60 * 60 * 1000;
function secreto(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET no configurada para firmar descargas");
  return s;
}
export type FormatoReporte = "xlsx" | "zip";
export function firmarDescarga(id: string, formato: FormatoReporte, ahora = Date.now()): string {
  const exp = ahora + TTL_MS;
  const sig = crypto.createHmac("sha256", secreto()).update(`reporte.${id}.${formato}.${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}
export function verificarDescarga(id: string, formato: FormatoReporte, token: string, ahora = Date.now()): boolean {
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || ahora > exp) return false;
  const esperado = crypto.createHmac("sha256", secreto()).update(`reporte.${id}.${formato}.${exp}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Enlaces del reporte. `base` absoluto cuando el enlace se abre fuera del hub (HospitalOS). */
export function descargasDeReporte(id: string, opts: { base?: string; firmar?: boolean } = {}) {
  const url = (formato: FormatoReporte) => {
    const qs = new URLSearchParams({ formato, ...(opts.firmar ? { token: firmarDescarga(id, formato) } : {}) });
    return `${opts.base ?? ""}/api/facturas/reporte/${encodeURIComponent(id)}?${qs}`;
  };
  return [
    { label: "Excel", href: url("xlsx") },
    { label: "XML (ZIP)", href: url("zip") },
  ];
}

/** Texto del resumen para el chat (cifras de la consulta, nunca del modelo). */
export function textoResumen(r: Extract<ResultadoReporte, { estado: "LISTO" }>): string {
  const m = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  const s = r.resumen;
  const top = s.porContraparte.slice(0, 5).map((p) => `• ${p.contraparte}: ${p.facturas} · ${m(p.total)}${p.saldo > 0.01 ? ` · saldo ${m(p.saldo)}` : ""}`);
  return [
    `${r.titulo}: ${s.facturas} CFDI${s.facturas === 1 ? "" : "s"} · total ${m(s.total)} (IVA ${m(s.iva)}) · pagado ${m(s.pagado)} · saldo ${m(s.saldo)}.`,
    ...(top.length > 1 ? top : []),
    s.porContraparte.length > 5 ? `…y ${s.porContraparte.length - 5} contrapartes más en el Excel.` : null,
    s.sinXml ? `${s.sinXml} sin XML guardado (van en el Excel, no en el ZIP).` : null,
    r.cortado ? "El reporte se cortó en 5,000 renglones: acota el periodo o las contrapartes." : null,
  ].filter(Boolean).join("\n");
}
