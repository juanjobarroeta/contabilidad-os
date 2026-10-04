"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { AlertTriangle, Loader2 } from "lucide-react";

interface Fila { companyId: string; rfc: string; razonSocial: string; motivo: string; desde: string | null; avisados: number; detalle: string }

const MOTIVO: Record<string, string> = { fiel_vencida: "e.firma vencida", fiel_revocada: "revocada por el SAT (304)", sin_sync: "sin avanzar 7 días" };

// Para el operador: qué empresas no están bajando CFDIs y por qué. La única
// salida es que el cliente suba su e.firma; aquí se ve a quién hay que llamar.
export function SyncDetenidoPanel() {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  useEffect(() => {
    fetch("/api/operador/sync-detenido").then((r) => (r.ok ? r.json() : { empresas: [] })).then((j) => setFilas(j.empresas ?? [])).catch(() => setFilas([]));
  }, []);
  if (filas === null) return <p className="mt-4 inline-flex items-center gap-2 text-[13px] text-cos-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando la sincronización con el SAT…</p>;
  if (filas.length === 0) return null;
  return (
    <Card className="mt-5 rounded-card border-red-200 bg-red-50/40 p-5 shadow-card">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4.5 w-4.5 text-red-700" />
        <h2 className="text-[15px] font-semibold text-cos-ink">Sincronización con el SAT detenida · {filas.length}</h2>
      </div>
      <p className="mt-1 text-[13px] text-cos-ink-soft">Estas empresas no bajan CFDIs. El aviso ya salió a los usuarios indicados; si no reaccionan, hay que llamar.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-left text-cos-ink-faint">
            <tr><th className="py-1 pr-3 font-medium">Empresa</th><th className="py-1 pr-3 font-medium">Motivo</th><th className="py-1 pr-3 font-medium">Desde</th><th className="py-1 font-medium">Avisados</th></tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.companyId} className="border-t border-cos-line/60">
                <td className="py-1.5 pr-3"><span className="font-medium text-cos-ink">{f.razonSocial}</span> <span className="font-mono text-[12px] text-cos-ink-faint">{f.rfc}</span></td>
                <td className="py-1.5 pr-3">{MOTIVO[f.motivo] ?? f.motivo}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px]">{f.desde ? f.desde.slice(0, 10) : "—"}</td>
                <td className="py-1.5">{f.avisados}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
