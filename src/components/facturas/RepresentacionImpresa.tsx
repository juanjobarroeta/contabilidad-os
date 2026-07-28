"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Representación impresa del CFDI — vista legible generada del XML almacenado.
// Tipada por tipo de comprobante (Ingreso/Egreso · Nómina · Pago/REP · Traslado).
// "Imprimir / Guardar PDF" usa el diálogo del navegador (print CSS), sin pipeline
// de PDF en el servidor. Sirve sobre todo para los CFDIs de Descarga Masiva, que
// no traen PDF del PAC.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { X, Printer, Loader2, ShieldCheck } from "lucide-react";
import type { Representacion, RepConcepto, RepTraslado, RepNominaConcepto } from "@/lib/facturas/representacion";

const TIPO_COMP: Record<string, string> = { I: "Ingreso", E: "Egreso", T: "Traslado", N: "Nómina", P: "Pago" };
const METODO: Record<string, string> = { PUE: "PUE — Pago en una sola exhibición", PPD: "PPD — Pago en parcialidades o diferido" };
const TIPO_NOMINA: Record<string, string> = { O: "Ordinaria", E: "Extraordinaria" };
const FORMA_PAGO: Record<string, string> = {
  "01": "Efectivo", "02": "Cheque nominativo", "03": "Transferencia electrónica", "04": "Tarjeta de crédito",
  "05": "Monedero electrónico", "06": "Dinero electrónico", "08": "Vales de despensa", "12": "Dación en pago",
  "13": "Pago por subrogación", "14": "Pago por consignación", "15": "Condonación", "17": "Compensación",
  "23": "Novación", "24": "Confusión", "25": "Remisión de deuda", "26": "Prescripción o caducidad",
  "27": "A satisfacción del acreedor", "28": "Tarjeta de débito", "29": "Tarjeta de servicios",
  "30": "Aplicación de anticipos", "31": "Intermediario pagos", "99": "Por definir",
};
const REGIMEN: Record<string, string> = {
  "601": "General de Ley Personas Morales", "603": "Personas Morales con Fines no Lucrativos",
  "605": "Sueldos y Salarios e Ingresos Asimilados", "606": "Arrendamiento", "607": "Enajenación o Adquisición de Bienes",
  "608": "Demás ingresos", "610": "Residentes en el Extranjero", "611": "Dividendos (socios y accionistas)",
  "612": "PF con Actividades Empresariales y Profesionales", "614": "Intereses", "615": "De los ingresos por obtención de premios",
  "616": "Sin obligaciones fiscales", "620": "Sociedades Cooperativas de Producción", "621": "Incorporación Fiscal",
  "622": "Act. Agrícolas, Ganaderas, Silvícolas y Pesqueras", "623": "Opcional para Grupos de Sociedades",
  "624": "Coordinados", "625": "Régimen Simplificado de Confianza (RESICO) PF", "626": "Régimen Simplificado de Confianza",
  "628": "Hidrocarburos", "629": "Regímenes Fiscales Preferentes", "630": "Enajenación de acciones en bolsa",
};
const USO_CFDI: Record<string, string> = {
  G01: "Adquisición de mercancías", G02: "Devoluciones, descuentos o bonificaciones", G03: "Gastos en general",
  I01: "Construcciones", I02: "Mobiliario y equipo de oficina", I03: "Equipo de transporte", I04: "Equipo de cómputo",
  I05: "Dados, troqueles, moldes", I06: "Comunicaciones telefónicas", I07: "Comunicaciones satelitales", I08: "Otra maquinaria",
  D01: "Honorarios médicos, dentales y hospitalarios", D02: "Gastos médicos por incapacidad", D03: "Gastos funerales",
  D04: "Donativos", D05: "Intereses por créditos hipotecarios", D06: "Aportaciones voluntarias al SAR",
  D07: "Primas por seguros de gastos médicos", D08: "Gastos de transportación escolar", D09: "Depósitos en cuentas para el ahorro",
  D10: "Pagos por servicios educativos", S01: "Sin efectos fiscales", CP01: "Pagos", CN01: "Nómina", P01: "Por definir",
};
const TIPO_REGIMEN_NOM: Record<string, string> = {
  "02": "Sueldos", "03": "Jubilados", "04": "Pensionados", "05": "Asimilados — Miembros Soc. Cooperativas",
  "06": "Asimilados — Integrantes Soc. y Asoc. Civiles", "07": "Asimilados — Miembros de consejos",
  "08": "Asimilados — Comisionistas", "09": "Asimilados — Honorarios", "10": "Asimilados — Acciones",
  "11": "Asimilados — Otros", "12": "Jubilados o Pensionados", "13": "Indemnización o Separación", "99": "Otro régimen",
};
const PERIODICIDAD: Record<string, string> = {
  "01": "Diario", "02": "Semanal", "03": "Catorcenal", "04": "Quincenal", "05": "Mensual", "06": "Bimestral",
  "07": "Unidad de obra", "08": "Comisión", "09": "Precio alzado", "10": "Decenal", "99": "Otra",
};

const label = (map: Record<string, string>, code: string | null) =>
  code ? (map[code] ? `${code} — ${map[code]}` : code) : "—";

const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

function fmtFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-MX", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type RepData = {
  representacion: Representacion;
  qrDataUrl: string | null;
  fromXml: boolean;
  cancelada: boolean;
};

export function RepresentacionImpresa({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const [data, setData] = useState<RepData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/facturas/${invoiceId}/representacion`);
        const d = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(d?.error ?? "No se pudo generar la representación impresa."); return; }
        setData(d);
      } catch {
        if (!cancelled) setError("No se pudo generar la representación impresa.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [invoiceId]);

  const r = data?.representacion;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-start justify-center overflow-y-auto bg-[oklch(0.2_0.02_258_/_0.55)] p-4 sm:p-8 print:bg-white print:p-0" onClick={onClose}>
      <style>{`@media print { body * { visibility: hidden !important; } .rep-sheet, .rep-sheet * { visibility: visible !important; } .rep-sheet { position: absolute !important; left: 0; top: 0; width: 100% !important; max-width: none !important; box-shadow: none !important; border-radius: 0 !important; } .rep-noprint { display: none !important; } }`}</style>

      {/* force-light: la hoja es un DOCUMENTO (blanco en pantalla y en papel);
          sin esto, en tema oscuro la tinta de tema se vuelve casi blanca sobre
          el fondo blanco fijo — texto invisible. */}
      <div className="rep-sheet force-light w-full max-w-[820px] rounded-[16px] bg-white text-cos-ink shadow-[0_30px_60px_-20px_oklch(0.2_0.05_258_/_0.5)]" onClick={(e) => e.stopPropagation()}>
        {/* Barra superior (no se imprime) */}
        <div className="rep-noprint flex items-center justify-between border-b border-cos-line-soft px-5 py-3">
          <p className="text-[14px] font-semibold text-cos-ink">Representación impresa</p>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} disabled={loading || !!error}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-[13px] font-semibold text-cos-ink hover:bg-cos-paper disabled:opacity-50">
              <Printer className="h-4 w-4" /> Imprimir / Guardar PDF
            </button>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper"><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="px-6 py-5 sm:px-8">
          {loading ? (
            <div className="flex items-center gap-2 py-16 text-[14px] text-cos-ink-faint"><Loader2 className="h-5 w-5 animate-spin" /> Generando…</div>
          ) : error || !r ? (
            <p className="py-16 text-center text-[14px] text-cos-red-ink">{error ?? "Sin datos."}</p>
          ) : (
            <>
              {data?.cancelada && (
                <div className="mb-4 rounded-[10px] border border-cos-red-tint bg-cos-red-tint px-4 py-2.5 text-[13px] font-semibold text-cos-red-ink">CFDI CANCELADO ante el SAT</div>
              )}
              {!data?.fromXml && (
                <div className="mb-4 rounded-[10px] bg-cos-amber-tint px-4 py-2.5 text-[12.5px] text-cos-amber-ink">No tenemos el XML original de este CFDI — esta vista se arma con los datos guardados y puede estar incompleta (sin sellos ni QR).</div>
              )}

              {/* Encabezado */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[18px] font-bold leading-tight text-cos-ink">{r.emisor.nombre ?? "—"}</p>
                  <p className="font-mono text-[12px] text-cos-ink-soft">{r.emisor.rfc ?? "—"}</p>
                  {r.emisor.regimenFiscal && <p className="mt-0.5 text-[11.5px] text-cos-ink-faint">{label(REGIMEN, r.emisor.regimenFiscal)}</p>}
                </div>
                <div className="flex-none text-right">
                  <span className="inline-block rounded-[7px] bg-cos-brand-tint px-2.5 py-1 text-[12px] font-semibold text-cos-brand-ink">
                    {r.tipoComprobante ? (TIPO_COMP[r.tipoComprobante] ?? r.tipoComprobante) : "CFDI"}
                  </span>
                  <p className="mt-1.5 text-[12px] text-cos-ink-soft">{r.serie ?? ""}{r.folio ? ` ${r.folio}` : ""}</p>
                </div>
              </div>

              {/* Receptor + datos del comprobante */}
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Box title="Receptor">
                  <Field k="Nombre" v={r.receptor.nombre} />
                  <Field k="RFC" v={r.receptor.rfc} mono />
                  {r.receptor.domicilioFiscal && <Field k="Domicilio fiscal (CP)" v={r.receptor.domicilioFiscal} />}
                  {r.receptor.regimenFiscal && <Field k="Régimen" v={label(REGIMEN, r.receptor.regimenFiscal)} />}
                  <Field k="Uso CFDI" v={label(USO_CFDI, r.receptor.usoCfdi)} />
                </Box>
                <Box title="Datos del comprobante">
                  <Field k="Fecha emisión" v={fmtFecha(r.fecha)} />
                  <Field k="Lugar expedición" v={r.lugarExpedicion} />
                  <Field k="Método de pago" v={r.metodoPago ? (METODO[r.metodoPago] ?? r.metodoPago) : "—"} />
                  <Field k="Forma de pago" v={label(FORMA_PAGO, r.formaPago)} />
                  <Field k="Moneda" v={r.moneda ? `${r.moneda}${r.tipoCambio && r.tipoCambio !== 1 ? ` · TC ${r.tipoCambio}` : ""}` : "—"} />
                </Box>
              </div>

              {/* Conceptos (I/E/T) */}
              {r.tipoComprobante !== "N" && r.tipoComprobante !== "P" && r.conceptos.length > 0 && (
                <ConceptosTable conceptos={r.conceptos} />
              )}

              {/* Impuestos */}
              {(r.traslados.length > 0 || r.retenciones.length > 0) && (
                <ImpuestosTable traslados={r.traslados} retenciones={r.retenciones} />
              )}

              {/* Nómina */}
              {r.tipoComprobante === "N" && r.nomina && <NominaBlock n={r.nomina} />}

              {/* Pago / REP */}
              {r.tipoComprobante === "P" && r.pagos && <PagosBlock pagos={r.pagos} />}

              {/* Totales (no nómina) */}
              {r.tipoComprobante !== "N" && (
                <div className="mt-5 ml-auto w-full max-w-[320px] text-[13px]">
                  <Row k="Subtotal" v={money(r.subtotal)} />
                  {!!r.descuento && <Row k="Descuento" v={`- ${money(r.descuento)}`} />}
                  {!!r.totalImpuestosTrasladados && <Row k="Impuestos trasladados" v={money(r.totalImpuestosTrasladados)} />}
                  {!!r.totalImpuestosRetenidos && <Row k="Impuestos retenidos" v={`- ${money(r.totalImpuestosRetenidos)}`} />}
                  <div className="flex justify-between border-t border-cos-line pt-2 text-[16px] font-bold text-cos-ink"><span>Total</span><span>{money(r.total)}</span></div>
                </div>
              )}

              {/* Sellos / timbre / QR */}
              {r.tfd && (
                <div className="mt-6 border-t border-cos-line-soft pt-4">
                  <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-cos-ink-soft"><ShieldCheck className="h-4 w-4 text-cos-jade-ink" /> Timbre Fiscal Digital (SAT)</p>
                  <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                    <div className="min-w-0 space-y-1.5">
                      <Field k="Folio fiscal (UUID)" v={r.tfd.uuid} mono />
                      <Field k="Fecha timbrado" v={fmtFecha(r.tfd.fechaTimbrado)} />
                      <Field k="No. certificado SAT" v={r.tfd.noCertificadoSAT} mono />
                      <Field k="No. certificado emisor" v={r.noCertificadoEmisor} mono />
                      <Field k="RFC proveedor certif." v={r.tfd.rfcProvCertif} mono />
                    </div>
                    {data?.qrDataUrl && (
                      <div className="flex-none text-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={data.qrDataUrl} alt="QR de verificación SAT" className="h-[150px] w-[150px]" />
                        <p className="mt-1 text-[10px] text-cos-ink-faint">Verifica en el SAT</p>
                      </div>
                    )}
                  </div>
                  {r.tfd.selloCFD && <Sello k="Sello digital del CFDI" v={r.tfd.selloCFD} />}
                  {r.tfd.selloSAT && <Sello k="Sello digital del SAT" v={r.tfd.selloSAT} />}
                  {r.cadenaOriginalTFD && <Sello k="Cadena original del complemento de certificación digital del SAT" v={r.cadenaOriginalTFD} />}
                  {r.verificacionUrl && (
                    <p className="rep-noprint mt-3 break-all text-[10.5px] text-cos-ink-faint">
                      <a href={r.verificacionUrl} target="_blank" rel="noreferrer" className="text-cos-brand-ink hover:underline">{r.verificacionUrl}</a>
                    </p>
                  )}
                </div>
              )}

              <p className="mt-5 text-center text-[10px] text-cos-ink-faint">Este documento es una representación impresa de un CFDI.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-cos-line-soft p-3.5">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-cos-ink-faint">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Field({ k, v, mono }: { k: string; v: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px]">
      <span className="flex-none text-cos-ink-faint">{k}</span>
      <span className={`min-w-0 break-words text-right text-cos-ink ${mono ? "font-mono text-[11.5px]" : ""}`}>{v ?? "—"}</span>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between py-1 text-cos-ink-soft"><span>{k}</span><span className="font-medium text-cos-ink">{v}</span></div>;
}
function Sello({ k, v }: { k: string; v: string }) {
  return (
    <div className="mt-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.03em] text-cos-ink-faint">{k}</p>
      <p className="mt-0.5 break-all font-mono text-[9.5px] leading-snug text-cos-ink-soft">{v}</p>
    </div>
  );
}

function ConceptosTable({ conceptos }: { conceptos: RepConcepto[] }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead className="bg-cos-paper text-[10.5px] uppercase tracking-[0.02em] text-cos-ink-faint">
          <tr>
            <th className="px-2 py-1.5 text-left">Clave</th>
            <th className="px-2 py-1.5 text-left">Descripción</th>
            <th className="px-2 py-1.5 text-right">Cant.</th>
            <th className="px-2 py-1.5 text-right">V. unit.</th>
            <th className="px-2 py-1.5 text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {conceptos.map((c, i) => (
            <tr key={i} className="border-t border-cos-line-soft align-top">
              <td className="px-2 py-1.5 font-mono text-[11px] text-cos-ink-soft">{c.claveProdServ}</td>
              <td className="px-2 py-1.5 text-cos-ink">{c.descripcion}</td>
              <td className="px-2 py-1.5 text-right text-cos-ink-soft">{c.cantidad}</td>
              <td className="px-2 py-1.5 text-right text-cos-ink-soft">{money(c.valorUnitario)}</td>
              <td className="px-2 py-1.5 text-right font-medium text-cos-ink">{money(c.importe)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImpuestosTable({ traslados, retenciones }: { traslados: RepTraslado[]; retenciones: RepTraslado[] }) {
  const rows = [...traslados, ...retenciones];
  return (
    <div className="mt-4 overflow-x-auto">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.03em] text-cos-ink-faint">Impuestos</p>
      <table className="w-full text-[12px]">
        <thead className="bg-cos-paper text-[10.5px] uppercase tracking-[0.02em] text-cos-ink-faint">
          <tr>
            <th className="px-2 py-1.5 text-left">Tipo</th>
            <th className="px-2 py-1.5 text-left">Impuesto</th>
            <th className="px-2 py-1.5 text-left">Factor</th>
            <th className="px-2 py-1.5 text-right">Tasa/Cuota</th>
            <th className="px-2 py-1.5 text-right">Base</th>
            <th className="px-2 py-1.5 text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i} className="border-t border-cos-line-soft">
              <td className="px-2 py-1.5 text-cos-ink-soft">{t.retencion ? "Retención" : "Traslado"}</td>
              <td className="px-2 py-1.5 text-cos-ink">{t.impuesto}</td>
              <td className="px-2 py-1.5 text-cos-ink-soft">{t.tipoFactor}</td>
              <td className="px-2 py-1.5 text-right text-cos-ink-soft">{t.tipoFactor === "Exento" ? "Exento" : t.tasaOCuota != null ? `${(t.tasaOCuota * 100).toFixed(t.tasaOCuota < 0.01 ? 4 : 2)}%` : "—"}</td>
              <td className="px-2 py-1.5 text-right text-cos-ink-soft">{money(t.base)}</td>
              <td className="px-2 py-1.5 text-right font-medium text-cos-ink">{money(t.importe)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NominaConceptosTable({ title, rows, conImporteGravadoExento }: { title: string; rows: RepNominaConcepto[]; conImporteGravadoExento?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.03em] text-cos-ink-faint">{title}</p>
      <table className="w-full text-[12px]">
        <thead className="bg-cos-paper text-[10.5px] uppercase tracking-[0.02em] text-cos-ink-faint">
          <tr>
            <th className="px-2 py-1.5 text-left">Clave</th>
            <th className="px-2 py-1.5 text-left">Concepto</th>
            {conImporteGravadoExento ? (
              <>
                <th className="px-2 py-1.5 text-right">Gravado</th>
                <th className="px-2 py-1.5 text-right">Exento</th>
              </>
            ) : (
              <th className="px-2 py-1.5 text-right">Importe</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={i} className="border-t border-cos-line-soft">
              <td className="px-2 py-1.5 font-mono text-[11px] text-cos-ink-soft">{c.clave ?? "—"}</td>
              <td className="px-2 py-1.5 text-cos-ink">{c.concepto ?? "—"}</td>
              {conImporteGravadoExento ? (
                <>
                  <td className="px-2 py-1.5 text-right text-cos-ink-soft">{money(c.gravado)}</td>
                  <td className="px-2 py-1.5 text-right text-cos-ink-soft">{money(c.exento)}</td>
                </>
              ) : (
                <td className="px-2 py-1.5 text-right font-medium text-cos-ink">{money(c.importe)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NominaBlock({ n }: { n: Representacion["nomina"] }) {
  if (!n) return null;
  const neto = (n.totalPercepciones ?? 0) + (n.totalOtrosPagos ?? 0) - (n.totalDeducciones ?? 0);
  return (
    <div className="mt-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Box title="Empleado / receptor">
          <Field k="CURP" v={n.curp} mono />
          <Field k="No. seguridad social" v={n.nss} mono />
          <Field k="No. empleado" v={n.numEmpleado} />
          <Field k="Puesto" v={n.puesto} />
          <Field k="Departamento" v={n.departamento} />
          <Field k="Régimen" v={label(TIPO_REGIMEN_NOM, n.tipoRegimen)} />
        </Box>
        <Box title="Periodo y datos de pago">
          <Field k="Tipo de nómina" v={n.tipoNomina ? (TIPO_NOMINA[n.tipoNomina] ?? n.tipoNomina) : "—"} />
          <Field k="Periodicidad" v={label(PERIODICIDAD, n.periodicidadPago)} />
          <Field k="Periodo" v={n.fechaInicialPago && n.fechaFinalPago ? `${n.fechaInicialPago} → ${n.fechaFinalPago}` : "—"} />
          <Field k="Fecha de pago" v={n.fechaPago} />
          <Field k="Días pagados" v={n.numDiasPagados != null ? String(n.numDiasPagados) : "—"} />
          <Field k="Salario diario integrado" v={money(n.salarioDiarioIntegrado)} />
        </Box>
      </div>

      <NominaConceptosTable title="Percepciones" rows={n.percepciones} conImporteGravadoExento />
      <NominaConceptosTable title="Deducciones" rows={n.deducciones} />
      <NominaConceptosTable title="Otros pagos" rows={n.otrosPagos} />

      <div className="mt-5 ml-auto w-full max-w-[320px] text-[13px]">
        <Row k="Total percepciones" v={money(n.totalPercepciones)} />
        {!!n.totalOtrosPagos && <Row k="Otros pagos" v={money(n.totalOtrosPagos)} />}
        <Row k="Total deducciones" v={`- ${money(n.totalDeducciones)}`} />
        <div className="flex justify-between border-t border-cos-line pt-2 text-[16px] font-bold text-cos-ink"><span>Neto a pagar</span><span>{money(neto)}</span></div>
      </div>
    </div>
  );
}

function PagosBlock({ pagos }: { pagos: NonNullable<Representacion["pagos"]> }) {
  return (
    <div className="mt-5 space-y-4">
      {pagos.map((p, i) => (
        <div key={i} className="rounded-[12px] border border-cos-line-soft p-3.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field k="Fecha de pago" v={fmtFecha(p.fechaPago)} />
            <Field k="Forma de pago" v={label(FORMA_PAGO, p.formaDePagoP)} />
            <Field k="Moneda" v={p.monedaP} />
            <Field k="Monto" v={money(p.monto)} />
          </div>
          {p.doctos.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.03em] text-cos-ink-faint">Documentos relacionados</p>
              <table className="w-full text-[12px]">
                <thead className="bg-cos-paper text-[10.5px] uppercase tracking-[0.02em] text-cos-ink-faint">
                  <tr>
                    <th className="px-2 py-1.5 text-left">UUID / Folio</th>
                    <th className="px-2 py-1.5 text-right">Parc.</th>
                    <th className="px-2 py-1.5 text-right">Saldo ant.</th>
                    <th className="px-2 py-1.5 text-right">Pagado</th>
                    <th className="px-2 py-1.5 text-right">Saldo insoluto</th>
                  </tr>
                </thead>
                <tbody>
                  {p.doctos.map((d, j) => (
                    <tr key={j} className="border-t border-cos-line-soft">
                      <td className="px-2 py-1.5 font-mono text-[10.5px] text-cos-ink-soft">{d.serie || d.folio ? `${d.serie ?? ""}${d.folio ?? ""}` : d.idDocumento}</td>
                      <td className="px-2 py-1.5 text-right text-cos-ink-soft">{d.numParcialidad ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right text-cos-ink-soft">{money(d.impSaldoAnt)}</td>
                      <td className="px-2 py-1.5 text-right font-medium text-cos-ink">{money(d.impPagado)}</td>
                      <td className="px-2 py-1.5 text-right text-cos-ink-soft">{money(d.impSaldoInsoluto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
