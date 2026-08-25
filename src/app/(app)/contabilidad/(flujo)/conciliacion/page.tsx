"use client";

// Paso 2 del flujo: la conciliación bancaria es COMPUERTA del cierre — el
// motor no postea un mes con movimientos sin conciliar (regla existente).
//
// LA MESA YA NO VIVE AQUÍ: se mudó a /bancos, que es a donde mandan todos los
// CTAs del producto («Ir a Bancos», «Clasificar en Bancos», el tablero). Tener
// la misma mesa montada en dos rutas era la confusión original — el trabajo se
// hace en UN lugar y este paso queda como lo que es: el estado de la compuerta
// (el papel de conciliación del mes) con la puerta a la mesa.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { ConciliacionBancariaPanel } from "@/components/contabilidad/ConciliacionBancariaPanel";

export default function ConciliacionPage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader
        title="Conciliación bancaria"
        actions={
          <Link
            href="/bancos"
            className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep"
          >
            Abrir la mesa en Bancos <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
      />
      <ConciliacionBancariaPanel companyId={activeCompany.id} year={year} month={month} />
    </div>
  );
}
