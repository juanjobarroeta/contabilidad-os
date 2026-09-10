"use client";

// ─────────────────────────────────────────────────────────────────────────────
// VISOR DEL CEP — el comprobante de Banxico, completo.
//
// El CEP es la prueba de que ESE importe llegó a la cuenta de ESE beneficiario
// en ESA fecha: la evidencia de materialidad que se le enseña al SAT cuando
// pregunta si un pago fue real. La mesa enseñaba un resumen de cuatro campos y
// un botón para bajar el XML — es decir, para investigarlo había que abrirlo
// fuera de la aplicación, en un editor de texto.
//
// Aquí está entero: importe y fecha de operación (los de BANXICO, que son con
// los que se contrasta el estado de cuenta), las dos cuentas, y el XML firmado
// tal cual, que es lo único que un tercero puede verificar.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { Money } from "@/components/ui/Money";
import type { CepMovimiento } from "./resolver-tipos";

export function VisorCep({
  cep,
  txId,
  /** Monto del movimiento en el estado de cuenta, firmado. */
  montoMovimiento,
  onClose,
}: {
  cep: CepMovimiento;
  txId: string;
  montoMovimiento: number;
  onClose: () => void;
}) {
  const [xml, setXml] = useState<string | null>(null);
  const [errorXml, setErrorXml] = useState("");

  // El XML no viaja con los datos (pesa y casi nunca hace falta); se pide al
  // abrir el visor. Es el MISMO endpoint que lo descarga.
  useEffect(() => {
    let vivo = true;
    fetch(`/api/bancos/transactions/${txId}/cep?xml=1`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error())))
      .then((t) => { if (vivo) setXml(t); })
      .catch(() => { if (vivo) setErrorXml("No se pudo traer el XML del comprobante."); });
    return () => { vivo = false; };
  }, [txId]);

  // Banxico y el estado de cuenta tienen que decir lo mismo. Cuando no, es
  // justo lo que hay que ver: una comisión cobrada aparte, un importe devuelto,
  // o una clave de rastreo que no era la de este movimiento.
  const abs = Math.abs(montoMovimiento);
  const difiere = cep.monto != null && Math.abs(cep.monto - abs) > 0.005;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-full max-w-[620px] flex-col rounded-card border border-cos-line bg-cos-card shadow-card"
      >
        <div className="flex items-start justify-between gap-3 border-b border-cos-line px-5 py-3.5">
          <div>
            <p className="text-[16px] font-semibold text-cos-ink">Comprobante Electrónico de Pago</p>
            <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
              Emitido por Banxico
              {cep.estado ? ` · ${cep.estado}` : ""}
              {cep.fechaOperacion ? ` · operación del ${cep.fechaOperacion}` : ""}
            </p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="grid h-8 w-8 flex-none place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-control bg-cos-paper px-3 py-2.5">
            <span className="text-[12.5px] uppercase tracking-wide text-cos-ink-faint">Importe del comprobante</span>
            {cep.monto != null ? <Money value={cep.monto} size={17} weight={700} /> : <span className="text-[13px] text-cos-ink-faint">—</span>}
          </div>
          {difiere && (
            <p className="mt-1.5 rounded-control bg-cos-amber-tint px-3 py-2 text-[12.5px] text-cos-amber-ink">
              Banxico dice <Money value={cep.monto!} size={12.5} /> y el estado de cuenta{" "}
              <Money value={abs} size={12.5} />. La diferencia suele ser una comisión cobrada
              aparte — o que esta clave de rastreo no es la de este movimiento.
            </p>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ParteCep titulo="Ordenante" nombre={cep.ordenanteNombre} rfc={cep.ordenanteRfc} banco={cep.ordenanteBanco} cuenta={cep.ordenanteCuenta} />
            <ParteCep titulo="Beneficiario" nombre={cep.beneficiarioNombre} rfc={cep.beneficiarioRfc} banco={cep.beneficiarioBanco} cuenta={cep.beneficiarioCuenta} />
          </div>

          {cep.concepto && (
            <div className="mt-3">
              <p className="text-[11.5px] uppercase tracking-wide text-cos-ink-faint">Concepto</p>
              <p className="text-[13px] text-cos-ink">{cep.concepto}</p>
            </div>
          )}

          <div className="mt-4">
            <p className="text-[11.5px] uppercase tracking-wide text-cos-ink-faint">XML firmado</p>
            {errorXml ? (
              <p className="mt-1 text-[12.5px] text-cos-red-ink">{errorXml}</p>
            ) : xml == null ? (
              <p className="mt-1 inline-flex items-center gap-2 text-[12.5px] text-cos-ink-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Trayendo el comprobante…
              </p>
            ) : (
              <pre className="mt-1 max-h-[220px] overflow-auto rounded-control bg-cos-paper p-3 font-mono text-[11px] leading-[1.5] text-cos-ink-soft">
                {xml}
              </pre>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-cos-line px-5 py-3">
          <a
            href={`/api/bancos/transactions/${txId}/cep?xml=1`}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3.5 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper"
          >
            <Download className="h-4 w-4" /> Descargar XML
          </a>
          <button onClick={onClose} className="rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep">
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function ParteCep({
  titulo, nombre, rfc, banco, cuenta,
}: {
  titulo: string;
  nombre: string | null;
  rfc: string | null;
  banco: string | null;
  cuenta: string | null;
}) {
  return (
    <div className="rounded-control border border-cos-line px-3 py-2.5">
      <p className="text-[11.5px] uppercase tracking-wide text-cos-ink-faint">{titulo}</p>
      <p className="mt-0.5 text-[13.5px] font-medium text-cos-ink">{nombre ?? "—"}</p>
      <p className="font-mono text-[11.5px] text-cos-ink-soft">{rfc ?? "sin RFC"}</p>
      <p className="mt-1 text-[12px] text-cos-ink-soft">{banco ?? "—"}</p>
      {cuenta && <p className="font-mono text-[11.5px] text-cos-ink-faint">··{cuenta.slice(-4)}</p>}
    </div>
  );
}
