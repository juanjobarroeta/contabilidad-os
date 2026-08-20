"use client";

// Selector mes/año compartido por los paneles de contabilidad.

import { MESES } from "@/components/contabilidad/PeriodProvider";

export function PeriodPicker({
  year, month, onChange,
}: { year: number; month: number; onChange: (y: number, m: number) => void }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <select
        value={month}
        onChange={(e) => onChange(year, parseInt(e.target.value))}
        className="text-sm border border-cos-line rounded-md px-2 py-1.5 bg-cos-card"
      >
        {MESES.map((m, i) => (
          <option key={i} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        type="number"
        value={year}
        onChange={(e) => onChange(parseInt(e.target.value), month)}
        className="w-24 text-sm border border-cos-line rounded-md px-2 py-1.5 bg-cos-card"
      />
    </div>
  );
}
