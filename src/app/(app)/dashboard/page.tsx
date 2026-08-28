"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL NUEVO INICIO — dos lentes sobre el mismo mes (rediseño Piloto, Fase 2).
//
//   · Empresa activa → el PILOTO DEL CIERRE: los cinco pasos del mes con su
//     estado, la cifra que importa y una acción (Propuesta B).
//   · Cartera → la COLA DE TRABAJO del despacho: una fila por cosa-que-hacer
//     en los N RFC, ordenada por urgencia (Propuesta A).
//
// El lente elegido persiste; por default, quien opera varias empresas aterriza
// en la cola y quien opera una, en el piloto. La banda del «$0.00 vencido» del
// tablero anterior murió aquí: el paso Declara del piloto cuenta lo vencido
// con honestidad (importe calculado / por calcular / informativa).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Building2, Rows3 } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { PilotoDelCierre } from "@/components/inicio/PilotoDelCierre";
import { ColaDeTrabajo } from "@/components/inicio/ColaDeTrabajo";
import { Loading } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

type Lente = "piloto" | "cola";

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export default function InicioPage() {
  const { activeCompany, companies, loading } = useCompany();
  const [lente, setLente] = useState<Lente | null>(null);

  // El lente persiste; el default depende del tamaño de la cartera.
  useEffect(() => {
    if (loading) return;
    const guardado = localStorage.getItem("inicio-lente") as Lente | null;
    setLente(guardado ?? (companies.length > 1 ? "cola" : "piloto"));
  }, [loading, companies.length]);

  function cambiar(l: Lente) {
    setLente(l);
    localStorage.setItem("inicio-lente", l);
  }

  if (loading || lente === null) return <Loading label="Cargando…" />;
  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;
  }

  const hoy = new Date();
  const multiEmpresa = companies.length > 1;
  const enCola = lente === "cola" && multiEmpresa;

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-7">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] text-cos-ink-soft">
            {enCola ? "Así va el mes de tu despacho" : "Hola, esto es lo importante de"}
          </p>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink">
            {enCola ? `${companies.length} empresas` : activeCompany.razonSocial}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
            {enCola
              ? `${MESES[hoy.getMonth()]} ${hoy.getFullYear()}`
              : `${activeCompany.rfc} · ${MESES[hoy.getMonth()]} ${hoy.getFullYear()}`}
          </p>
        </div>
        {multiEmpresa && (
          <div className="flex rounded-control border border-cos-line p-0.5">
            <button
              type="button"
              onClick={() => cambiar("piloto")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium",
                !enCola ? "bg-cos-slate-tint text-cos-ink" : "text-cos-ink-soft hover:text-cos-ink",
              )}
            >
              <Building2 className="h-3.5 w-3.5" /> Empresa
            </button>
            <button
              type="button"
              onClick={() => cambiar("cola")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium",
                enCola ? "bg-cos-slate-tint text-cos-ink" : "text-cos-ink-soft hover:text-cos-ink",
              )}
            >
              <Rows3 className="h-3.5 w-3.5" /> Cartera
            </button>
          </div>
        )}
      </div>

      {enCola ? <ColaDeTrabajo /> : <PilotoDelCierre />}
    </div>
  );
}
