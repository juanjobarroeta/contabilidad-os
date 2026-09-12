"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FICHAS 1 Y 2 DEL RESOLVER (spec docs/bancos/SPEC-mesa-conciliacion.md §5-6).
//
//   Movimiento    importe original · aplicado / restante · todo lo que se sabe
//                 (contraparte, RFC, CLABE, clave de rastreo) · CEP de Banxico
//                 en una fila · «→ anticipo» cuando sobra.
//   Aplicaciones  una fila por abono: fecha · factura · monto · REP · registrada.
//
// Se pintan desde la lectura única (lib/bancos/aplicaciones): la misma suma
// que ve la lista, la factura y el estado de cuenta. Las fechas llegan por
// JSON como texto; aquí se formatean sin suponer el tipo.
// ─────────────────────────────────────────────────────────────────────────────

import type { ResumenMovimiento, AplicacionDeMovimiento } from "@/lib/bancos/aplicaciones";

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCorta = (d: Date | string | null | undefined) => {
  if (!d) return "—";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });
};
const fechaLarga = (d: Date | string) =>
  new Date(d).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const CHIP: Record<ResumenMovimiento["estado"], { label: string; cls: string }> = {
  SIN_APLICAR: { label: "Sin aplicar", cls: "border border-cos-line text-cos-ink-soft" },
  PARCIAL: { label: "Parcial", cls: "bg-cos-amber-tint text-cos-amber-ink" },
  COMPLETO: { label: "Completo", cls: "bg-cos-jade-tint text-cos-jade-ink" },
  CATEGORIZADO: { label: "Categorizado", cls: "bg-cos-slate-tint text-cos-ink-soft" },
};

const EYEBROW = "text-[11px] font-semibold uppercase tracking-[.08em] text-cos-ink-faint";

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`inline-block rounded-full px-2 py-px text-[10.5px] font-semibold uppercase tracking-wide ${cls}`}>{label}</span>;
}

function Dato({ k, v, mono }: { k: string; v: string | null | undefined; mono?: boolean }) {
  if (!v) return null;
  return (
    <div className="min-w-0">
      <p className={EYEBROW}>{k}</p>
      <p className={`truncate text-[13px] text-cos-ink ${mono ? "font-mono" : ""}`} title={v}>{v}</p>
    </div>
  );
}

export function FichaMovimiento({
  r,
  onVerCep,
  clabe,
  concepto,
  referencia,
  descripcion,
}: {
  r: ResumenMovimiento;
  onVerCep: () => void;
  clabe?: string | null;
  concepto?: string | null;
  referencia?: string | null;
  /** La cadena cruda del banco: nunca se esconde del todo. */
  descripcion?: string | null;
}) {
  const m = r.movimiento;
  const esAbono = m.monto >= 0;
  const chip = CHIP[r.estado];
  const cep = r.cep;
  const cepDevuelto = !!cep?.estado && /devuel/i.test(cep.estado);
  const cepDifiere = cep?.monto != null && Math.abs(cep.monto - r.original) > 0.01;
  const anticipo = r.restante > 0.005 && r.estado !== "SIN_APLICAR" && r.estado !== "CATEGORIZADO";
  const ultimos4 = m.cuenta.numeroCuenta ? `····${m.cuenta.numeroCuenta.slice(-4)}` : "";

  return (
    <section className="rounded-card border border-cos-line bg-cos-card p-4 shadow-card">
      {cepDevuelto && (
        <p className="mb-3 rounded-control bg-cos-red-tint px-3 py-1.5 text-[12.5px] font-semibold text-cos-red-ink">
          Banxico reporta este SPEI como devuelto. No se puede aplicar.
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className={EYEBROW}>Movimiento · {esAbono ? "Abono" : "Cargo"}</p>
          <p className={`mt-0.5 font-mono text-[28px] font-medium leading-none tracking-[-0.01em] tabular-nums ${esAbono ? "text-cos-ink" : "text-cos-red-ink"}`}>
            {money(r.original)}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-cos-ink-soft">
            <span>{fechaLarga(m.fecha)}</span>
            <span>{m.cuenta.banco} · {m.cuenta.nombre}{ultimos4 ? ` · ${ultimos4}` : ""}</span>
            <Chip {...chip} />
          </p>
        </div>
        <div className="text-right">
          <p className={EYEBROW}>Aplicado</p>
          <p className="font-mono text-[15px] font-medium tabular-nums text-cos-ink">{money(r.asignado)}</p>
          <p className={`${EYEBROW} mt-1.5`}>Restante</p>
          <p className={`font-mono text-[15px] font-medium tabular-nums ${r.restante > 0.005 ? "text-cos-amber-ink" : "text-cos-ink"}`}>{money(r.restante)}</p>
          {anticipo && (
            <span className="mt-1 inline-block rounded-full bg-cos-amber-tint px-2 py-px text-[10.5px] font-semibold text-cos-amber-ink">
              → anticipo {money(r.restante)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-cos-line-soft pt-3 sm:grid-cols-2">
        <Dato k="Contraparte" v={m.contraparteNombre} />
        <Dato k="RFC" v={m.contraparteRfc} mono />
        <Dato k="CLABE ordenante" v={clabe} mono />
        <Dato k="Clave de rastreo" v={m.claveRastreo} mono />
        <Dato k="Concepto" v={concepto} />
        <Dato k="Referencia" v={referencia} mono />
      </div>

      {descripcion && (
        <details className="mt-3 rounded-control border border-dashed border-cos-line px-3 py-1.5">
          <summary className="cursor-pointer select-none text-[12.5px] font-medium text-cos-ink-soft">Descripción del banco</summary>
          <p className="mt-1.5 break-words font-mono text-[11.5px] text-cos-ink-faint">{descripcion}</p>
        </details>
      )}

      {cep && (
        <div className="mt-3 rounded-control border border-cos-line bg-cos-paper px-3 py-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={EYEBROW}>CEP Banxico</span>
            {cep.estado && (
              <Chip
                label={cep.estado}
                cls={cepDevuelto ? "bg-cos-red-tint text-cos-red-ink" : "bg-cos-jade-tint text-cos-jade-ink"}
              />
            )}
            {cep.fechaOperacion && <span className="text-cos-ink-soft">{cep.fechaOperacion}</span>}
            {cep.monto != null && (
              <span className={`font-mono font-medium tabular-nums ${cepDifiere ? "text-cos-amber-ink" : "text-cos-ink"}`} title={cepDifiere ? "Importe según Banxico distinto al del estado de cuenta" : undefined}>
                {money(cep.monto)}
              </span>
            )}
            <button type="button" onClick={onVerCep} className="ml-auto rounded-control border border-cos-line bg-cos-card px-2.5 py-1 text-[12px] font-semibold text-cos-ink hover:border-cos-brand hover:text-cos-brand-ink">
              Ver comprobante
            </button>
          </div>
          <p className="mt-1.5 text-cos-ink-soft">
            {[cep.ordenanteBanco, cep.ordenanteNombre].filter(Boolean).join(" · ")}
            {(cep.ordenanteNombre || cep.beneficiarioNombre) && " → "}
            {[cep.beneficiarioBanco, cep.beneficiarioNombre].filter(Boolean).join(" · ")}
          </p>
        </div>
      )}
    </section>
  );
}

function ChipRep({ rep }: { rep: AplicacionDeMovimiento["rep"] }) {
  if (rep.estado === "AMPARADA") return <Chip label={`Parcialidad ${rep.numParcialidad ?? "—"}`} cls="bg-cos-jade-tint text-cos-jade-ink" />;
  if (rep.estado === "SIN_REP") return <Chip label="Sin REP" cls="bg-cos-amber-tint text-cos-amber-ink" />;
  return <Chip label="No aplica" cls="bg-cos-slate-tint text-cos-ink-faint" />;
}

export function FichaAplicaciones({ r, onVerFactura }: { r: ResumenMovimiento; onVerFactura?: (invoiceId: string) => void }) {
  const n = r.aplicaciones.length + (r.impuesto ? 1 : 0);
  return (
    <section className="rounded-card border border-cos-line bg-cos-card shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className={EYEBROW}>Aplicaciones</p>
        <p className="text-[12px] text-cos-ink-faint">
          {n === 0 ? "sin aplicar todavía" : <>{n} aplicaci{n === 1 ? "ón" : "ones"} · <span className="font-mono tabular-nums">{money(r.asignado)}</span> de <span className="font-mono tabular-nums">{money(r.original)}</span></>}
        </p>
      </div>
      {n > 0 && (
        <div className="overflow-x-auto border-t border-cos-line-soft">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left">
                {["Fecha", "Factura", "Monto", "REP", "Registrada"].map((h, i) => (
                  <th key={h} className={`px-4 py-1.5 ${EYEBROW} ${i === 2 ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.impuesto && (
                <tr className="border-t border-cos-line-soft">
                  <td className="px-4 py-2 font-mono tabular-nums text-cos-ink-soft">{fechaCorta(r.movimiento.fecha)}</td>
                  <td className="px-4 py-2 text-cos-ink">{r.impuesto.etiqueta} <span className="font-mono text-[11px] text-cos-ink-faint">{r.impuesto.status}</span></td>
                  <td className="px-4 py-2 text-right font-mono font-medium tabular-nums">{money(r.original)}</td>
                  <td className="px-4 py-2"><Chip label="Declaración" cls="bg-cos-brand-tint text-cos-brand-ink" /></td>
                  <td className="px-4 py-2 text-cos-ink-faint">—</td>
                </tr>
              )}
              {r.aplicaciones.map((a) => {
                const f = a.factura;
                const ref = `${f.serie ?? ""}${f.folio ?? ""}`.trim();
                return (
                  <tr key={a.id} className="border-t border-cos-line-soft">
                    <td className="px-4 py-2 font-mono tabular-nums text-cos-ink-soft">{fechaCorta(a.fecha)}</td>
                    <td className="px-4 py-2">
                      {onVerFactura ? (
                        <button type="button" onClick={() => onVerFactura(f.id)} className="font-mono font-medium text-cos-brand-ink hover:underline">{ref || "CFDI"}</button>
                      ) : (
                        <span className="font-mono font-medium text-cos-ink">{ref || "CFDI"}</span>
                      )}
                      <span className="block truncate text-[11.5px] text-cos-ink-faint">
                        {f.contraparteNombre ?? "—"} · {f.tipo.charAt(0) + f.tipo.slice(1).toLowerCase()} {f.metodoPago}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-medium tabular-nums text-cos-ink">{money(a.monto)}</td>
                    <td className="px-4 py-2"><ChipRep rep={a.rep} /></td>
                    <td className="px-4 py-2 font-mono tabular-nums text-cos-ink-faint">{fechaCorta(a.registro.fecha)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
